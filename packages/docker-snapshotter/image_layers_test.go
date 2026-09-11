package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/protocol"
	digest "github.com/opencontainers/go-digest"
	"google.golang.org/grpc"
)

func TestResolveSharedImageLayers(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	backend, err := overlay.NewSnapshotter(filepath.Join(root, "overlay"), overlay.WithUpperdirLabel)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	store := &Store{backend: backend, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}, "B": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	client := &Client{store, "A"}
	parent := ""
	var want []string
	for _, key := range []string{"base", "top"} {
		if _, err := client.Prepare(ctx, "extract", parent, snapshots.WithLabels(map[string]string{protocol.RefLabel: digest.FromString(key).String()})); err != nil {
			t.Fatal(err)
		}
		if err := client.Commit(ctx, key, "extract"); err != nil {
			t.Fatal(err)
		}
		info, err := backend.Stat(ctx, store.state.Clients["A"][key].Backing)
		if err != nil {
			t.Fatal(err)
		}
		want = append([]string{info.Labels[overlayUpperdirLabel]}, want...)
		parent = key
	}
	server := grpc.NewServer()
	protocol.RegisterImageLayers(server, &sharedImageLayers{client})
	conn := testRPC(t, server)
	before, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	sequence := store.state.Sequence
	for range 2 {
		got, err := protocol.ResolveSharedLayers(ctx, conn, "top")
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("layers %v, want %v: %v", got, want, err)
		}
	}
	after, err := os.ReadFile(store.path)
	if err != nil || string(after) != string(before) || store.state.Sequence != sequence {
		t.Fatalf("resolution mutated aliases/backend sequence: %v", err)
	}
	count := 0
	if err := backend.Walk(ctx, func(context.Context, snapshots.Info) error { count++; return nil }); err != nil || count != 2 {
		t.Fatalf("resolution allocated temporary snapshots: count=%d err=%v", count, err)
	}
	if _, err := (&sharedImageLayers{&Client{store, "B"}}).Resolve(ctx, &api.MountsRequest{Key: "top"}); !errdefs.IsNotFound(err) {
		t.Fatalf("resolved another client's alias: %v", err)
	}
	for _, key := range []string{"private-active", "private-committed"} {
		if _, err := client.Prepare(ctx, key, "top"); err != nil {
			t.Fatal(err)
		}
		if key == "private-committed" {
			if err := client.Commit(ctx, "private-init", key); err != nil {
				t.Fatal(err)
			}
			key = "private-init"
		}
		if _, err := protocol.ResolveSharedLayers(ctx, conn, key); !errdefs.IsFailedPrecondition(err) {
			t.Fatalf("resolved private backing %q: %v", key, err)
		}
	}
	if err := store.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.ResolveSharedLayers(ctx, conn, "top"); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("retired client still resolves images: %v", err)
	}
	for _, path := range want {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("retirement invalidated previously resolved backing %s: %v", path, err)
		}
	}
}
