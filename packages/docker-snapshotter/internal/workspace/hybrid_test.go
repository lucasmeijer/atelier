package workspace

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/protocol"
	digest "github.com/opencontainers/go-digest"
)

type hybridFixture struct {
	ctx    context.Context
	h      *Hybrid
	shared snapshots.Snapshotter
	root   string
	layers []string
}

func newHybridFixture(t *testing.T) *hybridFixture {
	t.Helper()
	f := &hybridFixture{ctx: namespaces.WithNamespace(context.Background(), "moby"), root: filepath.Join(t.TempDir(), "private")}
	var err error
	f.shared, err = overlay.NewSnapshotter(filepath.Join(t.TempDir(), "shared"), overlay.WithUpperdirLabel)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.shared.Close() })
	for _, pair := range [][2]string{{"base", ""}, {"image", "base"}} {
		if _, err := f.shared.Prepare(f.ctx, "extract", pair[1]); err != nil {
			t.Fatal(err)
		}
		if err := f.shared.Commit(f.ctx, pair[0], "extract"); err != nil {
			t.Fatal(err)
		}
		info, err := f.shared.Stat(f.ctx, pair[0])
		if err != nil {
			t.Fatal(err)
		}
		f.layers = append([]string{info.Labels[upperLabel]}, f.layers...)
	}
	f.h, err = NewHybrid(f.root, f.shared, func(context.Context, string) ([]string, error) { return f.layers, nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.h.Close() })
	return f
}
func option(m []mount.Mount, prefix string) string {
	for _, o := range m[0].Options {
		if strings.HasPrefix(o, prefix) {
			return strings.TrimPrefix(o, prefix)
		}
	}
	return ""
}
func (t *hybridFixture) upper(test *testing.T, key string) string {
	test.Helper()
	i, err := t.h.private.Stat(t.ctx, key)
	if err != nil {
		test.Fatal(err)
	}
	return i.Labels[upperLabel]
}
func TestHybridPrivateAncestryAndLifetime(t *testing.T) {
	f := newHybridFixture(t)
	if err := os.Chmod(f.layers[0], 0751); err != nil {
		t.Fatal(err)
	}
	m, err := f.h.Prepare(f.ctx, "init-active", "image", snapshots.WithLabels(map[string]string{"caller": "init"}))
	if err != nil {
		t.Fatal(err)
	}
	if m[0].Type != "overlay" || option(m, "lowerdir=") != strings.Join(f.layers, ":") {
		t.Fatalf("wrong mount: %+v", m)
	}
	upper := f.upper(t, "init-active")
	if !strings.HasPrefix(upper, f.root+"/") {
		t.Fatalf("upper escaped private root: %s", upper)
	}
	stat, err := os.Stat(upper)
	if err != nil || stat.Mode().Perm() != 0751 {
		t.Fatalf("root mode not inherited: %v %v", stat, err)
	}
	if err := os.WriteFile(filepath.Join(upper, "init"), []byte("private init"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Commit(f.ctx, "init", "init-active"); err != nil {
		t.Fatal(err)
	}
	info, err := f.h.Stat(f.ctx, "init")
	if err != nil || info.Parent != "image" || info.Kind != snapshots.KindCommitted {
		t.Fatalf("private commit: %+v %v", info, err)
	}
	for key := range info.Labels {
		if strings.HasPrefix(key, privatePrefix) || key == upperLabel {
			t.Fatalf("leaked internal label %s", key)
		}
	}
	m, err = f.h.Prepare(f.ctx, "container", "init")
	if err != nil {
		t.Fatal(err)
	}
	if got := option(m, "lowerdir="); got != upper+":"+strings.Join(f.layers, ":") {
		t.Fatalf("wrong ancestry: %s", got)
	}
	containerUpper := f.upper(t, "container")
	if err := os.WriteFile(filepath.Join(containerUpper, "test"), []byte("private container"), 0600); err != nil {
		t.Fatal(err)
	}
	usage, err := f.h.Usage(f.ctx, "container")
	if err != nil || usage.Size == 0 {
		t.Fatalf("private usage %+v %v", usage, err)
	}
	if err := f.h.Remove(f.ctx, "init"); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("removed private parent: %v", err)
	}
	if err := f.h.Remove(f.ctx, "image"); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("removed shared parent: %v", err)
	}
	var names []string
	if err := f.h.Walk(f.ctx, func(_ context.Context, i snapshots.Info) error { names = append(names, i.Name); return nil }); err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"base", "container", "image", "init"}) {
		t.Fatalf("union walk: %v", names)
	}
	names = nil
	if err := f.h.Walk(f.ctx, func(_ context.Context, i snapshots.Info) error { names = append(names, i.Name); return nil }, "parent==image", "kind==committed"); err != nil {
		t.Fatal(err)
	}
	// Multiple filter arguments are OR, matching upstream snapshotter semantics.
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"base", "image", "init"}) {
		t.Fatalf("filtered union: %v", names)
	}
	if err := f.h.Remove(f.ctx, "container"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(containerUpper); !os.IsNotExist(err) {
		t.Fatalf("private upper remains: %v", err)
	}
	if err := f.h.Remove(f.ctx, "init"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.shared.Stat(f.ctx, "init"); !errdefs.IsNotFound(err) {
		t.Fatalf("private commit leaked centrally: %v", err)
	}
	if err := f.h.Remove(f.ctx, "image"); err != nil {
		t.Fatal(err)
	}
}
func TestHybridRestartLabelsAndViews(t *testing.T) {
	f := newHybridFixture(t)
	if _, err := f.h.Prepare(f.ctx, "active", "image"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Update(f.ctx, snapshots.Info{Name: "active", Labels: map[string]string{"updated": "yes"}}, "labels"); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Commit(f.ctx, "init", "active", snapshots.WithLabels(map[string]string{"committed": "yes"})); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Prepare(f.ctx, "container", "init"); err != nil {
		t.Fatal(err)
	}
	before, err := f.h.Mounts(f.ctx, "container")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.h.Close(); err != nil {
		t.Fatal(err)
	}
	f.h, err = NewHybrid(f.root, f.shared, func(context.Context, string) ([]string, error) {
		t.Fatal("restart resolved cached ancestry again")
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := f.h.Mounts(f.ctx, "container")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("restart changed mounts: %+v %v", after, err)
	}
	info, err := f.h.Stat(f.ctx, "init")
	if err != nil || info.Parent != "image" || info.Labels["committed"] != "yes" {
		t.Fatalf("lost commit metadata: %+v %v", info, err)
	}
	view, err := f.h.View(f.ctx, "view", "init")
	if err != nil {
		t.Fatal(err)
	}
	if option(view, "upperdir=") != "" || option(view, "lowerdir=") != f.upper(t, "init")+":"+strings.Join(f.layers, ":") {
		t.Fatalf("private view incorrect: %+v", view)
	}
	for _, operation := range []func() error{
		func() error {
			_, err := f.h.Prepare(f.ctx, "invalid", "", snapshots.WithLabels(map[string]string{sharedLayersLabel: "[]"}))
			return err
		},
		func() error {
			_, err := f.h.Update(f.ctx, snapshots.Info{Name: "container", Labels: map[string]string{sharedParentLabel: "other"}}, "labels")
			return err
		},
		func() error {
			return f.h.Commit(f.ctx, "invalid", "container", snapshots.WithLabels(map[string]string{sharedLayersLabel: "[]"}))
		},
	} {
		if err := operation(); !errdefs.IsInvalidArgument(err) {
			t.Fatalf("internal label override accepted: %v", err)
		}
	}
}
func TestHybridViewsAndPrivateImages(t *testing.T) {
	f := newHybridFixture(t)
	m, err := f.h.View(f.ctx, "shared-view", "image")
	if err != nil {
		t.Fatal(err)
	}
	if m[0].Type != "overlay" || option(m, "lowerdir=") != strings.Join(f.layers, ":") || option(m, "upperdir=") != "" {
		t.Fatalf("shared view: %+v", m)
	}
	if _, err := f.h.Prepare(f.ctx, "commit-active", "image"); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Commit(f.ctx, "private-image", "commit-active"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Prepare(f.ctx, "child-extract", "private-image", snapshots.WithLabels(map[string]string{protocol.RefLabel: digest.FromString("child").String()})); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Commit(f.ctx, "private-child", "child-extract"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.shared.Stat(f.ctx, "private-child"); !errdefs.IsNotFound(err) {
		t.Fatalf("published private child: %v", err)
	}

}
func TestHybridPendingInitializationRecoveryAndRollback(t *testing.T) {
	f := newHybridFixture(t)
	// Simulate process death after backend Prepare commits its metadata and
	// before first-parent root ownership/mode initialization is published.
	k := "interrupted"
	layers, _ := json.Marshal(f.layers)
	labels := map[string]string{sharedParentLabel: "image", sharedLayersLabel: string(layers), initializeLabel: "true"}
	if _, err := f.h.private.Prepare(f.ctx, k, "", snapshots.WithLabels(labels)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f.layers[0], 0753); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.h, err = NewHybrid(f.root, f.shared, func(context.Context, string) ([]string, error) { return f.layers, nil })
	if err != nil {
		t.Fatal(err)
	}
	raw, err := f.h.private.Stat(f.ctx, k)
	if err != nil {
		t.Fatal(err)
	}
	if raw.Labels[initializeLabel] != "" {
		t.Fatal("pending initialization not completed")
	}
	st, err := os.Stat(raw.Labels[upperLabel])
	if err != nil || st.Mode().Perm() != 0753 {
		t.Fatalf("initialization not replayed: %v %v", st, err)
	}
	if err := os.Chmod(raw.Labels[upperLabel], 0701); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Mounts(f.ctx, "interrupted"); err != nil {
		t.Fatal(err)
	}
	st, err = os.Stat(raw.Labels[upperLabel])
	if err != nil || st.Mode().Perm() != 0701 {
		t.Fatal("mount reset private root permissions")
	}
	f.h.resolve = func(context.Context, string) ([]string, error) {
		return []string{filepath.Join(f.root, "missing")}, nil
	}
	if _, err := f.h.Prepare(f.ctx, "failed", "image"); err == nil {
		t.Fatal("expected failed initialization")
	}
	if _, err := f.h.Stat(f.ctx, "failed"); !errdefs.IsNotFound(err) {
		t.Fatalf("failed creation not rolled back: %v", err)
	}
	if err := f.h.Cleanup(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func TestHybridStartupProbeReclaimsInterruptedFirstAllocation(t *testing.T) {
	f := newHybridFixture(t)
	orphan := filepath.Join(f.root, "snapshots", "new-interrupted")
	if err := os.MkdirAll(filepath.Join(orphan, "fs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "fs", "partial"), []byte("not published"), 0600); err != nil {
		t.Fatal(err)
	}
	// The production supervisor performs this API probe before starting Docker.
	// It initializes a previously empty DB and upstream Remove reclaims backing
	// from a process killed during its very first allocation.
	if _, err := f.h.Prepare(f.ctx, "startup-probe", ""); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Remove(f.ctx, "startup-probe"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("unpublished backing not reclaimed: %v", err)
	}
}
