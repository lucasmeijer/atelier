package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
)

func TestScopedReuseLifecycle(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	b, e := overlay.NewSnapshotter(filepath.Join(root, "overlay"))
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	s := &Store{backend: b, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}, "B": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	a := &Client{s, "A"}
	c := &Client{s, "B"}
	target := digest.FromString("first diff").String()
	opt := snapshots.WithLabels(map[string]string{refLabel: target})
	if _, e = a.Prepare(ctx, "same-key", "", opt); e != nil {
		t.Fatal(e)
	}
	if e = a.Commit(ctx, "committed", "same-key"); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Stat(ctx, "committed"); !errdefs.IsNotFound(e) {
		t.Fatalf("leaked A alias: %v", e)
	}
	if _, e = c.Prepare(ctx, "same-key", "", opt); !errdefs.IsAlreadyExists(e) {
		t.Fatalf("no early hit: %v", e)
	}
	count := 0
	e = c.Walk(ctx, func(_ context.Context, i snapshots.Info) error {
		count++
		if i.Kind != snapshots.KindCommitted || i.Name != "same-key" {
			t.Errorf("bad adoption: %+v", i)
		}
		return nil
	}, `labels."containerd.io/snapshot.ref"==`+target+`,parent==""`)
	if e != nil || count != 1 {
		t.Fatalf("adoption filter: %d %v", count, e)
	}
	if _, e = c.Prepare(ctx, "writable", "same-key"); e != nil {
		t.Fatal(e)
	}
	if e = c.Remove(ctx, "same-key"); !errdefs.IsFailedPrecondition(e) {
		t.Fatalf("removed live parent %v", e)
	}
	before := s.state.Clients["B"]["same-key"].Backing
	if e = s.retire(ctx, "A"); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Mounts(ctx, "writable"); e != nil {
		t.Fatal(e)
	}
	if _, e = b.Stat(ctx, before); e != nil {
		t.Fatal(e)
	}
	i, e := c.Update(ctx, snapshots.Info{Name: "same-key", Labels: map[string]string{"test": "yes"}}, "labels.test")
	if e != nil || i.Labels["test"] != "yes" {
		t.Fatalf("update: %+v %v", i, e)
	}
	if _, e = c.Update(ctx, i, "parent"); !errdefs.IsInvalidArgument(e) {
		t.Fatal(e)
	}
	if e = c.Remove(ctx, "writable"); e != nil {
		t.Fatal(e)
	}
	if e = c.Remove(ctx, "same-key"); e != nil {
		t.Fatal(e)
	}
	if _, e = b.Stat(ctx, before); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Prepare(ctx, "adopt-again", "", opt); !errdefs.IsAlreadyExists(e) {
		t.Fatal(e)
	}
}
func TestConcurrentColdCommit(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	b, e := overlay.NewSnapshotter(filepath.Join(root, "overlay"))
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	s := &Store{backend: b, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}, "B": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	a := &Client{s, "A"}
	c := &Client{s, "B"}
	opt := snapshots.WithLabels(map[string]string{refLabel: digest.FromString("shared").String()})
	for _, cl := range []*Client{a, c} {
		if _, e := cl.Prepare(ctx, "same", "", opt); e != nil {
			t.Fatal(e)
		}
	}
	for _, cl := range []*Client{a, c} {
		if e := cl.Commit(ctx, "done", "same"); e != nil {
			t.Fatal(e)
		}
	}
	if s.state.Clients["A"]["done"].Backing != s.state.Clients["B"]["done"].Backing {
		t.Fatal("duplicate committed backing")
	}
}

func TestPrivateCommittedInitReclaimed(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	b, e := overlay.NewSnapshotter(filepath.Join(root, "overlay"))
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	s := &Store{backend: b, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	a := &Client{s, "A"}
	opt := snapshots.WithLabels(map[string]string{refLabel: digest.FromString("image").String()})
	if _, e = a.Prepare(ctx, "extract", "", opt); e != nil {
		t.Fatal(e)
	}
	if e = a.Commit(ctx, "image", "extract"); e != nil {
		t.Fatal(e)
	}
	image := s.state.Clients["A"]["image"].Backing
	for _, mode := range []string{"remove", "retire"} {
		if _, e = a.Prepare(ctx, "init-active", "image"); e != nil {
			t.Fatal(e)
		}
		if e = a.Commit(ctx, "init", "init-active"); e != nil {
			t.Fatal(e)
		}
		init := s.state.Clients["A"]["init"].Backing
		if _, e = a.Prepare(ctx, "container", "init"); e != nil {
			t.Fatal(e)
		}
		active := s.state.Clients["A"]["container"].Backing
		if mode == "remove" {
			if e = a.Remove(ctx, "init"); !errdefs.IsFailedPrecondition(e) {
				t.Fatal(e)
			}
			if e = a.Remove(ctx, "container"); e != nil {
				t.Fatal(e)
			}
			if e = a.Remove(ctx, "init"); e != nil {
				t.Fatal(e)
			}
		} else {
			if e = s.retire(ctx, "A"); e != nil {
				t.Fatal(e)
			}
		}
		for _, key := range []string{init, active} {
			if _, e = b.Stat(ctx, key); !errdefs.IsNotFound(e) {
				t.Fatalf("private backing %s leaked: %v", key, e)
			}
		}
		if _, e = b.Stat(ctx, image); e != nil {
			t.Fatalf("image backing removed: %v", e)
		}
	}
}
