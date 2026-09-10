package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	"google.golang.org/grpc"
)

func gcStore(t *testing.T, root string) *Store {
	t.Helper()
	s := openRecoveryStore(t, root)
	if err := s.restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.backend.Close() })
	return s
}

func gcLayer(t *testing.T, c *Client, name, parent string) (string, string) {
	t.Helper()
	ctx := context.Background()
	if _, err := c.Prepare(ctx, "unpack", parent, snapshots.WithLabels(map[string]string{refLabel: digest.FromString(name).String()})); err != nil {
		t.Fatal(err)
	}
	info, err := c.s.backend.Stat(ctx, c.s.state.Clients[c.id]["unpack"].Backing)
	if err != nil {
		t.Fatal(err)
	}
	path := info.Labels[overlayUpperdirLabel]
	if err := os.WriteFile(filepath.Join(path, "data"), make([]byte, 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.Commit(ctx, name, "unpack"); err != nil {
		t.Fatal(err)
	}
	return c.s.state.Clients[c.id][name].Backing, path
}

func TestGCStatsDeduplicateProtectAndStopAtTarget(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	a, b := &Client{s, "A"}, &Client{s, "B"}
	shared, sharedPath := gcLayer(t, a, "shared", "")
	gcLayer(t, b, "shared", "")
	old, oldPath := gcLayer(t, a, "old", "")
	newer, newPath := gcLayer(t, a, "newer", "")
	if err := a.Remove(ctx, "old"); err != nil {
		t.Fatal(err)
	}
	if err := a.Remove(ctx, "newer"); err != nil {
		t.Fatal(err)
	}
	s.state.UnusedSince[old] = time.Now().Add(-time.Hour)
	s.state.UnusedSince[newer] = time.Now().Add(-time.Minute)
	s.save()
	before, err := s.storageStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	usage, err := s.backend.Usage(ctx, shared)
	if err != nil {
		t.Fatal(err)
	}
	if before.UsedBytes != usage.Size || before.UnusedBytes != 2*usage.Size {
		t.Fatalf("not deduplicated: %+v usage=%+v", before, usage)
	}
	// Stats are read-only, and below-target manual GC must not flush the cache.
	if _, err := s.collectLayers(ctx); err != nil {
		t.Fatal(err)
	}
	if len(s.state.Chains) != 3 {
		t.Fatal("below-target GC flushed unused layers")
	}
	result, err := s.collectLayersTo(ctx, before.TotalBytes-usage.Size)
	if err != nil {
		t.Fatal(err)
	}
	if result.ReclaimedBytes != usage.Size || result.TotalBytes != before.TotalBytes-usage.Size {
		t.Fatalf("incorrect GC stats: %+v", result)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old backing not physically removed: %v", err)
	}
	for _, path := range []string{sharedPath, newPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	result, err = s.collectLayersTo(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.UsedBytes != usage.Size || result.UnusedBytes != 0 {
		t.Fatalf("other client not protected: %+v", result)
	}
	if _, err := b.Stat(ctx, "shared"); err != nil {
		t.Fatal(err)
	}
	if err := s.retire(ctx, "B"); err != nil {
		t.Fatal(err)
	}
	result, err = s.collectLayersTo(ctx, 0)
	if err != nil || result.TotalBytes != 0 {
		t.Fatalf("retired backing retained: %+v %v", result, err)
	}
}

func TestGCUnusedAgePersistsAndResetsOnReuse(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s := gcStore(t, root)
	a := &Client{s, "A"}
	backing, _ := gcLayer(t, a, "image", "")
	if err := a.Remove(ctx, "image"); err != nil {
		t.Fatal(err)
	}
	s.state.UnusedSince[backing] = time.Now().UTC().Add(-time.Hour)
	s.save()
	original := s.state.UnusedSince[backing]
	if err := s.backend.Close(); err != nil {
		t.Fatal(err)
	}
	s = gcStore(t, root)
	if !s.state.UnusedSince[backing].Equal(original) {
		t.Fatal("lost unused age on restart")
	}
	a = &Client{s, "A"}
	gcLayer(t, a, "image", "")
	if _, exists := s.state.UnusedSince[backing]; exists {
		t.Fatal("used layer still eligible")
	}
	if err := a.Remove(ctx, "image"); err != nil {
		t.Fatal(err)
	}
	if !s.state.UnusedSince[backing].After(original) {
		t.Fatal("reuse did not reset unused age")
	}
}

func TestGCProtectsColdUnpackTargetAndAncestors(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	a, b := &Client{s, "A"}, &Client{s, "B"}
	_, basePath := gcLayer(t, a, "base", "")
	_, topPath := gcLayer(t, a, "top", "base")
	gcLayer(t, b, "base", "")
	if _, err := b.Prepare(ctx, "cold", "base", snapshots.WithLabels(map[string]string{refLabel: digest.FromString("top").String()})); err != nil {
		t.Fatal(err)
	}
	// The applier can now skip extraction using A's completed chain.
	if err := s.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	result, err := s.collectLayersTo(ctx, 0)
	if err != nil || result.UnusedBytes != 0 {
		t.Fatalf("in-flight chain lost protection: %+v %v", result, err)
	}
	if err := b.Commit(ctx, "top", "cold"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{basePath, topPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.retire(ctx, "B"); err != nil {
		t.Fatal(err)
	}
	result, err = s.collectLayersTo(ctx, 0)
	if err != nil || result.TotalBytes != 0 {
		t.Fatalf("leaf-first chain reclamation failed: %+v %v", result, err)
	}
}

func TestGCProtectsHybridPrivateDescendantsAcrossRestart(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	c := &Client{s, "A"}
	_, path := gcLayer(t, c, "base", "")
	root := filepath.Join(t.TempDir(), "private")
	open := func() *hybridSnapshotter {
		h, err := newHybridSnapshotter(root, c, func(ctx context.Context, key string) ([]string, error) {
			result, err := (&sharedImageLayers{c}).Resolve(ctx, &api.MountsRequest{Key: key})
			if err != nil {
				return nil, err
			}
			var paths []string
			for _, m := range result.Mounts {
				paths = append(paths, m.Source)
			}
			return paths, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	h := open()
	if _, err := h.Prepare(ctx, "init", "base"); err != nil {
		t.Fatal(err)
	}
	if err := h.Commit(ctx, "private-image", "init"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Prepare(ctx, "container", "private-image"); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h = open() // Park/restart preserves the same private ancestry metadata.
	defer h.Close()
	if err := h.Remove(ctx, "base"); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("private parent removed: %v", err)
	}
	if _, err := s.collectLayersTo(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Mounts(ctx, "container"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"container", "private-image", "base"} {
		if err := h.Remove(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	result, err := s.collectLayersTo(ctx, 0)
	if err != nil || result.TotalBytes != 0 {
		t.Fatalf("private release not reclaimed: %+v %v", result, err)
	}
}

type gcBeforeAdopt struct {
	grpc.ClientConnInterface
	collect func()
}

func (c gcBeforeAdopt) Invoke(ctx context.Context, method string, args, reply any, opts ...grpc.CallOption) error {
	if method == "/"+warmService+"/Adopt" {
		c.collect()
	}
	return c.ClientConnInterface.Invoke(ctx, method, args, reply, opts...)
}
func TestGCBetweenWarmLookupAndAdoptUsesOrdinaryUnpack(t *testing.T) {
	f := newLocalFixture(t)
	f.local.shared = gcBeforeAdopt{f.local.shared, func() {
		if err := f.s.retire(f.ctx, "A"); err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.collectLayersTo(f.ctx, 0); err != nil {
			t.Fatal(err)
		}
	}}
	result, err := f.local.Prepare(f.ctx, f.request)
	if err != nil || len(result.Mounts) == 0 {
		t.Fatalf("GC race broke pull: %+v %v", result, err)
	}
	if f.s.state.Clients["B"][f.request.Key].Info.Kind != snapshots.KindActive {
		t.Fatal("ordinary unpack not prepared")
	}
}

type gcFailureBackend struct{ snapshots.Snapshotter }

func (b gcFailureBackend) Remove(context.Context, string) error {
	return errors.New("injected removal failure")
}

func TestGCFailurePersistsUntilSuccessfulCollection(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s := gcStore(t, root)
	a := &Client{s, "A"}
	gcLayer(t, a, "image", "")
	if err := a.Remove(ctx, "image"); err != nil {
		t.Fatal(err)
	}
	s.backend = gcFailureBackend{s.backend}
	if _, err := s.collectLayersTo(ctx, 0); err == nil {
		t.Fatal("failed removal swallowed")
	}
	stats, err := s.storageStats(ctx)
	if err != nil || stats.GCFailure == nil || stats.UnusedBytes == 0 {
		t.Fatalf("failure missing: %+v %v", stats, err)
	}
	if err := s.backend.Close(); err != nil {
		t.Fatal(err)
	}
	s = gcStore(t, root)
	stats, err = s.storageStats(ctx)
	if err != nil || stats.GCFailure == nil {
		t.Fatalf("lost failure after restart: %+v %v", stats, err)
	}
	result, err := s.collectLayersTo(ctx, 0)
	if err != nil || result.GCFailure != nil || result.TotalBytes != 0 {
		t.Fatalf("retry failed: %+v %v", result, err)
	}
}

func TestStorageHTTPReadIsFreshAndGCRespectsTarget(t *testing.T) {
	s := gcStore(t, t.TempDir())
	mux := http.NewServeMux()
	s.registerStorageAPI(mux)
	read := func() StorageStats {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", "/storage", nil))
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("bad response: %v", w)
		}
		var stats StorageStats
		if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
			t.Fatal(err)
		}
		return stats
	}
	if read().TotalBytes != 0 {
		t.Fatal("nonempty initial store")
	}
	a := &Client{s, "A"}
	gcLayer(t, a, "image", "")
	used := read()
	if used.UsedBytes == 0 || used.TargetBytes != unpackedLayerTargetBytes {
		t.Fatalf("bad byte counts: %+v", used)
	}
	if err := a.Remove(context.Background(), "image"); err != nil {
		t.Fatal(err)
	}
	unused := read()
	if unused.UnusedBytes != used.UsedBytes || unused.UsedBytes != 0 {
		t.Fatalf("stale stats: %+v", unused)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/gc", nil))
	var result GCResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || result.ReclaimedBytes != 0 || result.UnusedBytes != unused.UnusedBytes {
		t.Fatalf("manual GC flushed cache: %+v", result)
	}
}

func TestGCConcurrentRetirementAndCollection(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	gcLayer(t, &Client{s, "A"}, "image", "")
	gcLayer(t, &Client{s, "B"}, "image", "")
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.collectLayersTo(ctx, 0); err != nil {
				t.Error(err)
			}
		}()
	}
	if err := s.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if _, err := (&Client{s, "B"}).Stat(ctx, "image"); err != nil {
		t.Fatal(err)
	}
}

func TestGCCrashRecovery(t *testing.T) {
	for _, phase := range []string{"before", "after"} {
		t.Run(phase, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			s := gcStore(t, root)
			_, path := gcLayer(t, &Client{s, "A"}, "unused", "")
			_, keep := gcLayer(t, &Client{s, "B"}, "used", "")
			if err := s.retire(ctx, "A"); err != nil {
				t.Fatal(err)
			}
			if err := s.backend.Close(); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestRecoveryKillHelper$", "--", "crash-recovery", root, "gc", phase)
			output, err := cmd.CombinedOutput()
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
				t.Fatalf("did not crash: %s %v", output, err)
			}
			s = gcStore(t, root)
			_, exists := s.state.Chains[digest.FromString("unused").String()]
			if exists != (phase == "before") {
				t.Fatal("backing/index recovery disagrees")
			}
			if _, err := s.collectLayersTo(ctx, 0); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("leaked removed directory: %v", err)
			}
			if _, err := os.Stat(keep); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Model OverlayFS successfully deleting metadata but failing to delete files.
// Upstream Remove/Cleanup log this situation and still return nil.
type gcPhysicalFailureBackend struct{ snapshots.Snapshotter }

func (b gcPhysicalFailureBackend) Remove(ctx context.Context, key string) error {
	info, err := b.Snapshotter.Stat(ctx, key)
	if err != nil {
		return err
	}
	if err := b.Snapshotter.Remove(ctx, key); err != nil {
		return err
	}
	path := info.Labels[overlayUpperdirLabel]
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(path, "leftover"), make([]byte, 8192), 0600)
}
func (b gcPhysicalFailureBackend) Cleanup(context.Context) error { return nil }
func TestGCPhysicalDeletionFailureRemainsAccountedAndRetryable(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	c := &Client{s, "A"}
	gcLayer(t, c, "unused", "")
	if err := c.Remove(ctx, "unused"); err != nil {
		t.Fatal(err)
	}
	backend := s.backend
	s.backend = gcPhysicalFailureBackend{backend}
	if _, err := s.collectLayersTo(ctx, 0); err == nil {
		t.Fatal("physical failure hidden")
	}
	stats, err := s.storageStats(ctx)
	if err != nil || stats.UnusedBytes == 0 || stats.GCFailure == nil || len(s.state.PendingLayerRemovals) != 1 {
		t.Fatalf("lost occupied bytes: %+v %v", stats, err)
	}
	s.backend = backend
	result, err := s.collectLayersTo(ctx, 0)
	if err != nil || result.TotalBytes != 0 || result.ReclaimedBytes != stats.UnusedBytes || result.GCFailure != nil {
		t.Fatalf("physical retry failed: %+v %v", result, err)
	}
}

type largeLayerUsage struct{ snapshots.Snapshotter }

func (b largeLayerUsage) Usage(ctx context.Context, key string) (snapshots.Usage, error) {
	usage, err := b.Snapshotter.Usage(ctx, key)
	usage.Size += 6_000_000_000
	return usage, err
}
func TestGCAutomaticStartupCommitAndRelease(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	a := &Client{s, "A"}
	gcLayer(t, a, "old", "")
	gcLayer(t, a, "recent", "")
	for _, key := range []string{"old", "recent"} {
		if err := a.Remove(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	s.backend = largeLayerUsage{s.backend}
	stop := s.startLayerGC()
	defer stop()
	wait := func(chains, unused int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			s.Lock()
			matches := len(s.state.Chains) == chains && len(s.state.UnusedSince) == unused
			s.Unlock()
			if matches {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("automatic collection did not reach chains=%d unused=%d", chains, unused)
	}
	wait(1, 1) // Startup reclaims oldest unused layers toward 10 GB.
	gcLayer(t, a, "active", "")
	wait(1, 0) // A commit above target releases the remaining unused layer.
	gcLayer(t, a, "second-active", "")
	stats, err := s.storageStats(ctx)
	if err != nil || stats.UsedBytes <= unpackedLayerTargetBytes {
		t.Fatalf("soft-target fixture: %+v %v", stats, err)
	}
	if err := a.Remove(ctx, "second-active"); err != nil {
		t.Fatal(err)
	}
	wait(1, 0) // Releasing references makes over-target storage collectible.
}

func TestGCNestedRetirementPreservesSibling(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	for _, pair := range [][2]string{{"root", ""}, {"child", "root"}, {"grandchild", "child"}, {"sibling", "root"}} {
		if err := s.claimClient(pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	_, childPath := gcLayer(t, &Client{s, "child"}, "child-only", "")
	_, grandchildPath := gcLayer(t, &Client{s, "grandchild"}, "grandchild-only", "")
	_, sharedPath := gcLayer(t, &Client{s, "child"}, "shared", "")
	gcLayer(t, &Client{s, "sibling"}, "shared", "")
	if _, err := s.retireTree(ctx, "child"); err != nil {
		t.Fatal(err)
	}
	stats, err := s.collectLayersTo(ctx, 0)
	if err != nil || stats.UnusedBytes != 0 || len(s.state.Chains) != 1 {
		t.Fatalf("subtree GC failed: %+v %v", stats, err)
	}
	for _, path := range []string{childPath, grandchildPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("subtree data retained: %v", err)
		}
	}
	if _, err := os.Stat(sharedPath); err != nil {
		t.Fatal(err)
	}
}

type growingUnpackUsage struct {
	snapshots.Snapshotter
	active string
	growth int64
}

func (b *growingUnpackUsage) Usage(ctx context.Context, key string) (snapshots.Usage, error) {
	usage, err := b.Snapshotter.Usage(ctx, key)
	if key == b.active {
		b.growth += 1_000_000
		usage.Size += b.growth
	}
	return usage, err
}
func TestGCReclaimedBytesExcludeConcurrentUnpackGrowth(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	c := &Client{s, "A"}
	gcLayer(t, c, "unused", "")
	if err := c.Remove(ctx, "unused"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Prepare(ctx, "unpacking", "", snapshots.WithLabels(map[string]string{refLabel: digest.FromString("growing").String()})); err != nil {
		t.Fatal(err)
	}
	s.backend = &growingUnpackUsage{Snapshotter: s.backend, active: s.state.Clients["A"]["unpacking"].Backing}
	before, err := s.storageStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.collectLayersTo(ctx, 0)
	if err != nil || result.ReclaimedBytes != before.UnusedBytes || result.UsedBytes <= before.UsedBytes {
		t.Fatalf("unpack growth distorted reclaimed bytes: %+v %v", result, err)
	}
}

func TestGCRepeatedWorkspaceChurnStaysWithinTarget(t *testing.T) {
	ctx := context.Background()
	s := gcStore(t, t.TempDir())
	const target = 32_768
	for i := range 20 {
		id := fmt.Sprintf("workspace-%d", i)
		if err := s.claimClient(id, ""); err != nil {
			t.Fatal(err)
		}
		gcLayer(t, &Client{s, id}, id, "")
		if err := s.retire(ctx, id); err != nil {
			t.Fatal(err)
		}
		result, err := s.collectLayersTo(ctx, target)
		if err != nil || result.UsedBytes != 0 || result.TotalBytes > target {
			t.Fatalf("churn grew past target: %+v %v", result, err)
		}
		if len(s.state.PendingLayerRemovals) != 0 {
			t.Fatal("completed GC left deletion records")
		}
	}
}
