package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/errdefs"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/process"
)

// One durable intent covers the only operation in flight under Store's lock.
// Recovery observes the backend's atomic metadata transaction: if it happened,
// publish the intended aliases; otherwise retain the previous aliases. Never
// replay an unpack or discard an active snapshot's filesystem contents.
type mutation struct {
	Kind   string
	Key    string
	Parent string
	Name   string
	Labels map[string]string
}
type intent struct {
	Operation mutation
	State     State
}

func durableJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func (s *Store) clearIntent() error {
	if err := os.Remove(s.path + ".intent"); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(s.path))
}
func (s *Store) applied(ctx context.Context, op mutation) (bool, error) {
	key := op.Key
	if op.Kind == "commit" {
		key = op.Name
	}
	info, err := s.backend.Stat(ctx, key)
	if errdefs.IsNotFound(err) {
		return op.Kind == "remove", nil
	}
	if err != nil {
		return false, err
	}
	if op.Kind == "remove" {
		return false, nil
	}
	kind := snapshots.KindActive
	if op.Kind == "view" {
		kind = snapshots.KindView
	}
	if op.Kind == "commit" {
		kind = snapshots.KindCommitted
	}
	if info.Kind != kind || info.Parent != op.Parent {
		return false, fmt.Errorf("unexpected backend state for %s: kind=%v parent=%q", key, info.Kind, info.Parent)
	}
	return true, nil
}
func (s *Store) recover(ctx context.Context) error {
	b, err := os.ReadFile(s.path + ".intent")
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var pending intent
	if err := json.Unmarshal(b, &pending); err != nil {
		return err
	}
	switch pending.Operation.Kind {
	case "prepare", "view", "commit", "remove":
	default:
		return fmt.Errorf("unknown snapshot mutation %q", pending.Operation.Kind)
	}
	applied, err := s.applied(ctx, pending.Operation)
	if err != nil {
		return err
	}
	if applied {
		s.state = pending.State
		s.save()
	}
	return s.clearIntent()
}

func (s *Store) mutate(ctx context.Context, op mutation, change func()) error {
	// Keep the currently published state untouched until backend outcome is known.
	previous := s.state
	b, err := json.Marshal(previous)
	process.Must(err)
	// Unmarshal into a fresh value: maps must not alias previous.
	var next State
	process.Must(json.Unmarshal(b, &next))
	s.state = next
	change()
	s.updateUnusedLayers()
	pending := intent{op, s.state}
	s.state = previous
	process.Must(durableJSON(s.path+".intent", pending))
	switch op.Kind {
	case "prepare":
		_, err = s.backend.Prepare(ctx, op.Key, op.Parent, snapshots.WithLabels(op.Labels))
	case "view":
		_, err = s.backend.View(ctx, op.Key, op.Parent, snapshots.WithLabels(op.Labels))
	case "commit":
		err = s.backend.Commit(ctx, op.Name, op.Key, snapshots.WithLabels(op.Labels))
	case "remove":
		err = s.backend.Remove(ctx, op.Key)
	default:
		panic("unknown snapshot mutation")
	}
	// Even an error (including cancellation) may follow a committed backend
	// transaction. Resolve using a live context, just as on process restart.
	process.Must(s.recover(context.Background()))
	return err
}

func (s *Store) removeAlias(ctx context.Context, id, key string, a Alias) error {
	if retained(a) {
		delete(s.state.Clients[id], key)
		s.save()
		return nil
	}
	return s.mutate(ctx, mutation{Kind: "remove", Key: a.Backing}, func() {
		delete(s.state.Clients[id], key)
	})
}

// Restore before opening any client listener. OverlayFS may also have filesystem
// directories left by a killed create/remove whose metadata transaction ended.
func (s *Store) restore(ctx context.Context) error {
	if err := s.recover(ctx); err != nil {
		return err
	}
	for id, retired := range s.state.Retired {
		if retired && len(s.state.Clients[id]) > 0 {
			if err := s.retire(ctx, id); err != nil {
				return err
			}
		}
	}
	// OverlayFS has no metadata bucket until its first successful creation.
	if cleaner, ok := s.backend.(snapshots.Cleaner); ok && s.state.Sequence > 0 {
		return cleaner.Cleanup(ctx)
	}
	return nil
}
