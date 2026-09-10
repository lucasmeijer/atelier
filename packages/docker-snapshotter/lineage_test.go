package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
)

func TestRegistrationRecordsExistingRootOnlyClients(t *testing.T) {
	s := &Store{state: State{Clients: map[string]map[string]Alias{"existing": {}}, Retired: map[string]bool{}}}
	if err := s.claimClient("existing", ""); err != nil {
		t.Fatal(err)
	}
	if parent, ok := s.state.Parents["existing"]; !ok || parent != "" {
		t.Fatalf("root registration lacks explicit ownership entry: %v", s.state.Parents)
	}
	if err := s.claimClient("child", "existing"); err != nil {
		t.Fatal(err)
	}
}

func TestCreatorIdentityIsImmutableAndCannotBeRetired(t *testing.T) {
	s := &Store{state: State{Clients: map[string]map[string]Alias{}, Parents: map[string]string{}, Retired: map[string]bool{}}}
	for _, pair := range [][2]string{{"A", ""}, {"B", "A"}, {"C", "B"}, {"B", "A"}} {
		if err := s.claimClient(pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	for _, pair := range [][2]string{{"B", ""}, {"A", "C"}, {"new", "missing"}} {
		if err := s.claimClient(pair[0], pair[1]); !errdefs.IsFailedPrecondition(err) {
			t.Fatalf("invalid creator accepted %v: %v", pair, err)
		}
	}
	if err := s.claimClient("new", "new"); !errdefs.IsInvalidArgument(err) {
		t.Fatalf("self parent accepted: %v", err)
	}
	s.state.Retired["B"] = true
	for _, pair := range [][2]string{{"B", "A"}, {"new", "B"}} {
		if err := s.claimClient(pair[0], pair[1]); !errdefs.IsFailedPrecondition(err) {
			t.Fatalf("retired creator/client accepted %v: %v", pair, err)
		}
	}
}

type failedTreeRemoval struct{ snapshots.Snapshotter }

func (b failedTreeRemoval) Remove(context.Context, string) error {
	return errors.New("interrupted retirement")
}

func TestRetirementTombstonesWholeNestedSubtreeBeforeCleanup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	backend, err := overlay.NewSnapshotter(filepath.Join(root, "overlay"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	s := &Store{backend: backend, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{}, Chains: map[string]Chain{}, Parents: map[string]string{}, Retired: map[string]bool{}}}
	for _, pair := range [][2]string{{"A", ""}, {"B", "A"}, {"C", "B"}, {"sibling", "A"}} {
		if err := s.claimClient(pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
		if _, err := (&Client{s, pair[0]}).Prepare(ctx, "private", ""); err != nil {
			t.Fatal(err)
		}
	}
	s.backend = failedTreeRemoval{backend}
	ids, err := s.retireTree(ctx, "B")
	if err == nil || !reflect.DeepEqual(ids, []string{"C", "B"}) {
		t.Fatalf("retirement did not stop on interrupted child cleanup: %v %v", ids, err)
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	var restored State
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"B", "C"} {
		if !restored.Retired[id] {
			t.Fatalf("crash could restore descendant listener %s", id)
		}
	}
	s = &Store{backend: backend, path: s.path, state: restored}
	if err := s.restore(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"B", "C"} {
		if len(s.state.Clients[id]) != 0 {
			t.Fatalf("retirement failed to recover %s", id)
		}
		if err := s.claimClient(id, s.state.Parents[id]); !errdefs.IsFailedPrecondition(err) {
			t.Fatalf("late registration revived %s: %v", id, err)
		}
	}
	for _, id := range []string{"A", "sibling"} {
		if _, err := (&Client{s, id}).Mounts(ctx, "private"); err != nil {
			t.Fatalf("subtree retirement broke %s: %v", id, err)
		}
	}
	if _, err := s.retireTree(ctx, "B"); err != nil {
		t.Fatalf("repeated retirement failed: %v", err)
	}
}
