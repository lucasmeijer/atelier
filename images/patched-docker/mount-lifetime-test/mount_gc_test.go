package snapshot

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/containerd/containerd/v2/core/leases"
	"github.com/containerd/containerd/v2/core/metadata"
	"github.com/containerd/containerd/v2/core/mount"
	mountmanager "github.com/containerd/containerd/v2/core/mount/manager"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/containerd/v2/plugins/content/local"
	"github.com/containerd/containerd/v2/plugins/snapshots/native"
	"github.com/stretchr/testify/require"
	bolt "go.etcd.io/bbolt"
)

// directoryHandler substitutes only the kernel mount operation. The production
// mount manager still owns activation records, paths, lease associations, format
// expansion, and cleanup; the production metadata collector decides reachability.
// Using a directory instead of EROFS makes this test unprivileged and deterministic.
type directoryHandler struct{}

func (directoryHandler) Mount(_ context.Context, m mount.Mount, target string, _ []mount.ActiveMount) (mount.ActiveMount, error) {
	if err := os.Mkdir(target, 0700); err != nil {
		return mount.ActiveMount{}, err
	}
	data, err := os.ReadFile(filepath.Join(m.Source, "payload"))
	if err != nil {
		return mount.ActiveMount{}, err
	}
	if err := os.WriteFile(filepath.Join(target, "payload"), data, 0600); err != nil {
		return mount.ActiveMount{}, err
	}
	now := time.Now()
	return mount.ActiveMount{Mount: m, MountPoint: target, MountedAt: &now}, nil
}
func (directoryHandler) Unmount(context.Context, string) error { return nil }

func TestManagedMountGC(t *testing.T) {
	for _, tc := range []struct {
		name           string
		deleteOriginal bool
		flatView       bool
	}{
		{"live_original_lease_flat_view", false, true},
		{"deleted_original_lease_flat_view", true, true},
		{"deleted_original_lease_nonflat_view", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := namespaces.WithNamespace(context.Background(), "moby")
			root := t.TempDir()
			openDB := func(name string) *bolt.DB {
				db, err := bolt.Open(filepath.Join(root, name), 0600, nil)
				require.NoError(t, err)
				return db
			}
			cs, err := local.NewStore(filepath.Join(root, "content"))
			require.NoError(t, err)
			sn, err := native.NewSnapshotter(filepath.Join(root, "snapshots"))
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, sn.Close()) })
			db := metadata.NewDB(openDB("metadata.db"), cs, map[string]snapshots.Snapshotter{"native": sn})
			require.NoError(t, db.Init(ctx))
			t.Cleanup(func() { require.NoError(t, db.Close()) })
			mm, err := mountmanager.NewManager(openDB("mounts.db"), filepath.Join(root, "mounts"),
				mountmanager.WithMountHandler("testfs", directoryHandler{}))
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, mm.(io.Closer).Close()) })
			db.RegisterCollectibleResource(metadata.ResourceMount, mm.(metadata.Collector))
			lm := metadata.NewLeaseManager(db)

			original, err := lm.Create(ctx, leases.WithID("original-operation"))
			require.NoError(t, err)
			originalCtx := leases.WithLease(ctx, original.ID)
			ss := db.Snapshotter("native")
			initial, err := ss.Prepare(originalCtx, "working", "")
			require.NoError(t, err)
			require.Len(t, initial, 1)
			require.NoError(t, os.WriteFile(filepath.Join(initial[0].Source, "payload"), []byte("snapshot data\n"), 0600))
			require.NoError(t, ss.Commit(originalCtx, "committed", "working"))

			opts := []leases.Opt{leases.WithID("snapshot-view")}
			if tc.flatView {
				opts = append(opts, leases.WithLabels(map[string]string{"containerd.io/gc.flat": "true"}))
			}
			viewLease, err := lm.Create(ctx, opts...)
			require.NoError(t, err)
			viewMounts, err := ss.View(leases.WithLease(ctx, viewLease.ID), "view", "committed")
			require.NoError(t, err)
			require.Len(t, viewMounts, 1)
			backingFile := filepath.Join(viewMounts[0].Source, "payload")

			// Same wrapper and captured context as WithMountManager uses. Cache
			// this object across operations, just as BuildKit cacheRecord does.
			wrapper := &managedSnapshotter{Snapshotter: FromContainerdSnapshotter("native", ss, nil), manager: mm, leases: lm, namespace: "moby"}
			cached := wrapper.wrap(originalCtx, "view", &staticMountable{mounts: []mount.Mount{
				{Type: "testfs", Source: viewMounts[0].Source},
				{Type: "format/bind", Source: "{{ mount 0 }}", Options: []string{"rbind", "ro"}},
			}})
			// First use completes normally; the mountable itself remains cached.
			_, firstRelease, err := cached.Mount()
			require.NoError(t, err)
			require.NoError(t, firstRelease())
			if tc.deleteOriginal {
				require.NoError(t, lm.Delete(ctx, original))
			}

			// Later export: this activation must survive until release, even
			// though the original operation is gone. Do not release before GC.
			mounts, release, err := cached.Mount()
			require.NoError(t, err)
			defer func() { require.NoError(t, release()) }()
			require.Len(t, mounts, 1)
			exposedFile := filepath.Join(mounts[0].Source, "payload")
			data, err := os.ReadFile(exposedFile)
			require.NoError(t, err)
			require.Equal(t, "snapshot data\n", string(data))
			// Hold a second consumer of the same cached mountable concurrently.
			otherMounts, otherRelease, err := cached.Mount()
			require.NoError(t, err)
			defer func() { require.NoError(t, otherRelease()) }()
			require.Len(t, otherMounts, 1)
			otherFile := filepath.Join(otherMounts[0].Source, "payload")
			require.NotEqual(t, exposedFile, otherFile)
			activeLeases, err := lm.List(ctx, `labels."buildkit/lease.temporary"`)
			require.NoError(t, err)
			require.Len(t, activeLeases, 2)
			for _, lease := range activeLeases {
				require.NotContains(t, lease.Labels, "containerd.io/gc.expire", "long-running consumers must not lose protection")
			}
			t.Logf("Before GC: activation readable; original lease deleted=%v; flat view=%v", tc.deleteOriginal, tc.flatView)

			_, err = db.GarbageCollect(ctx)
			require.NoError(t, err)
			// Distinguish disappearing access paths from missing snapshot data.
			_, err = ss.Stat(ctx, "view")
			require.NoError(t, err, "snapshot view must remain leased")
			data, err = os.ReadFile(backingFile)
			require.NoError(t, err, "backing snapshot data must still exist")
			require.Equal(t, "snapshot data\n", string(data))
			t.Log("After GC: snapshot view and backing data still exist")
			data, err = os.ReadFile(exposedFile)
			require.NoError(t, err, "GC removed an activation still held by its consumer; release() has not been called")
			require.Equal(t, "snapshot data\n", string(data))

			require.NoError(t, release())
			_, err = os.Stat(exposedFile)
			require.ErrorIs(t, err, os.ErrNotExist, "released activation must be cleaned up")
			_, err = db.GarbageCollect(ctx)
			require.NoError(t, err)
			data, err = os.ReadFile(otherFile)
			require.NoError(t, err, "releasing one consumer must not affect the other")
			require.Equal(t, "snapshot data\n", string(data))
			require.NoError(t, otherRelease())
			activeLeases, err = lm.List(ctx, `labels."buildkit/lease.temporary"`)
			require.NoError(t, err)
			require.Empty(t, activeLeases, "normal release must not leak leases")

			// Simulate a client crash (no release) followed by the existing
			// worker/base startup cleanup of all temporary BuildKit leases.
			orphanMounts, _, err := cached.Mount()
			require.NoError(t, err)
			require.Len(t, orphanMounts, 1)
			orphanFile := filepath.Join(orphanMounts[0].Source, "payload")
			_, err = os.Stat(orphanFile)
			require.NoError(t, err)
			activeLeases, err = lm.List(ctx, `labels."buildkit/lease.temporary"`)
			require.NoError(t, err)
			require.Len(t, activeLeases, 1)
			for _, lease := range activeLeases {
				require.NoError(t, lm.Delete(ctx, lease))
			}
			_, err = db.GarbageCollect(ctx)
			require.NoError(t, err)
			_, err = os.Stat(orphanFile)
			require.ErrorIs(t, err, os.ErrNotExist, "worker restart must allow GC of orphan activations, even with non-flat snapshot leases")
			_, err = ss.Stat(ctx, "view")
			require.NoError(t, err, "orphan cleanup must not delete the leased snapshot")
		})
	}
}
