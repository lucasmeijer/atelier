package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/protocol"
	digest "github.com/opencontainers/go-digest"
)

// Kill the real process on either side of the backend's durable transaction.
// The parent opens the same OverlayFS metadata and exercises the client interface.
type killedBackend struct {
	snapshots.Snapshotter
	phase string
}

func (b killedBackend) kill(phase string) {
	if b.phase == phase {
		syscall.Kill(os.Getpid(), syscall.SIGKILL)
	}
}
func (b killedBackend) Prepare(ctx context.Context, k, p string, o ...snapshots.Opt) ([]mount.Mount, error) {
	b.kill("before")
	m, e := b.Snapshotter.Prepare(ctx, k, p, o...)
	b.kill("after")
	return m, e
}
func (b killedBackend) View(ctx context.Context, k, p string, o ...snapshots.Opt) ([]mount.Mount, error) {
	b.kill("before")
	m, e := b.Snapshotter.View(ctx, k, p, o...)
	b.kill("after")
	return m, e
}
func (b killedBackend) Commit(ctx context.Context, n, k string, o ...snapshots.Opt) error {
	b.kill("before")
	e := b.Snapshotter.Commit(ctx, n, k, o...)
	b.kill("after")
	return e
}
func (b killedBackend) Remove(ctx context.Context, k string) error {
	b.kill("before")
	e := b.Snapshotter.Remove(ctx, k)
	b.kill("after")
	return e
}
func openRecoveryStore(t *testing.T, root string) *Store {
	t.Helper()
	b, e := overlay.NewSnapshotter(filepath.Join(root, "overlay"), overlay.WithUpperdirLabel)
	if e != nil {
		t.Fatal(e)
	}
	s := &Store{backend: b, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}, "B": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	data, e := os.ReadFile(s.path)
	if e == nil {
		if e = json.Unmarshal(data, &s.state); e != nil {
			t.Fatal(e)
		}
	} else if !os.IsNotExist(e) {
		t.Fatal(e)
	}
	if e = s.recover(context.Background()); e != nil {
		t.Fatal(e)
	}
	return s
}
func recoveryOperation(t *testing.T, s *Store, op string) {
	t.Helper()
	ctx := context.Background()
	c := &Client{s, "A"}
	var e error
	switch op {
	case "prepare":
		_, e = c.Prepare(ctx, "new", "image")
	case "view":
		_, e = c.View(ctx, "new", "image")
	case "commit", "shared-commit", "deduplicate":
		e = c.Commit(ctx, "new", "active")
	case "remove":
		e = c.Remove(ctx, "active")
	case "retire":
		e = s.retire(ctx, "A")
	case "gc":
		_, e = s.collectLayersTo(ctx, 0)
	}
	if e != nil {
		t.Fatal(e)
	}
}
func TestRecoveryKillHelper(t *testing.T) {
	args := os.Args
	if len(args) < 5 || args[len(args)-4] != "crash-recovery" {
		return
	}
	root, op, phase := args[len(args)-3], args[len(args)-2], args[len(args)-1]
	s := openRecoveryStore(t, root)
	s.backend = killedBackend{s.backend, phase}
	recoveryOperation(t, s, op)
	t.Fatal("operation did not reach crash point")
}
func TestRecoveryAcrossBackendTransactions(t *testing.T) {
	for _, op := range []string{"prepare", "view", "commit", "shared-commit", "deduplicate", "remove", "retire"} {
		for _, phase := range []string{"before", "after"} {
			t.Run(op+"/"+phase, func(t *testing.T) {
				ctx := context.Background()
				root := t.TempDir()
				s := openRecoveryStore(t, root)
				a := &Client{s, "A"}
				b := &Client{s, "B"}
				label := snapshots.WithLabels(map[string]string{protocol.RefLabel: digest.FromString("base").String()})
				if _, e := a.Prepare(ctx, "extract", "", label); e != nil {
					t.Fatal(e)
				}
				if e := a.Commit(ctx, "image", "extract"); e != nil {
					t.Fatal(e)
				}
				if _, e := b.Prepare(ctx, "extract", "", label); e != nil {
					t.Fatal(e)
				}
				if e := b.Commit(ctx, "image", "extract"); e != nil {
					t.Fatal(e)
				}
				opts := []snapshots.Opt{}
				if op == "deduplicate" || op == "shared-commit" {
					opts = append(opts, snapshots.WithLabels(map[string]string{protocol.RefLabel: digest.FromString("child").String()}))
				}
				if _, e := a.Prepare(ctx, "active", "image", opts...); e != nil {
					t.Fatal(e)
				}
				if op == "deduplicate" {
					if _, e := b.Prepare(ctx, "active", "image", opts...); e != nil {
						t.Fatal(e)
					}
					if e := b.Commit(ctx, "child", "active"); e != nil {
						t.Fatal(e)
					}
				}
				s.save()
				if e := s.backend.Close(); e != nil {
					t.Fatal(e)
				}
				cmd := exec.Command(os.Args[0], "-test.run=^TestRecoveryKillHelper$", "--", "crash-recovery", root, op, phase)
				output, e := cmd.CombinedOutput()
				exit, ok := e.(*exec.ExitError)
				if !ok || exit.ProcessState.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
					t.Fatalf("not killed: %v %s", e, output)
				}
				// Preserve the intent to also exercise a crash after alias publication but
				// before journal deletion. Repeated recovery must be harmless.
				journal, e := os.ReadFile(filepath.Join(root, "aliases.json.intent"))
				if e != nil {
					t.Fatal(e)
				}
				s = openRecoveryStore(t, root)
				if e = os.WriteFile(s.path+".intent", journal, 0600); e != nil {
					t.Fatal(e)
				}
				if e = s.recover(ctx); e != nil {
					t.Fatal(e)
				}
				if op == "retire" {
					if !s.state.Retired["A"] {
						t.Fatal("retirement not durable")
					}
					if e = s.restore(ctx); e != nil {
						t.Fatal(e)
					}
					if len(s.state.Clients["A"]) != 0 {
						t.Fatal("retirement incomplete")
					}
				} else {
					c := &Client{s, "A"}
					if phase == "before" {
						recoveryOperation(t, s, op)
					}
					key := "new"
					if op == "remove" {
						key = "active"
					}
					_, e = c.Stat(ctx, key)
					if op == "remove" {
						if !errdefs.IsNotFound(e) {
							t.Fatal(e)
						}
					} else if e != nil {
						t.Fatal(e)
					}
				}
				if _, e = (&Client{s, "B"}).Stat(ctx, "image"); e != nil {
					t.Fatal("other client lost image", e)
				}
				// Every physical entry must be reachable; every alias must resolve.
				referenced := map[string]bool{}
				for _, chain := range s.state.Chains {
					referenced[chain.Backing] = true
				}
				for _, aliases := range s.state.Clients {
					for _, alias := range aliases {
						referenced[alias.Backing] = true
						if _, e = s.backend.Stat(ctx, alias.Backing); e != nil {
							t.Fatal(e)
						}
					}
				}
				if e = s.backend.Walk(ctx, func(_ context.Context, i snapshots.Info) error {
					if !referenced[i.Name] {
						t.Errorf("orphan %s", i.Name)
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
				s.backend.Close()
			})
		}
	}
}

type interruptedPrepare struct {
	snapshots.Snapshotter
	after bool
}

func (b interruptedPrepare) Prepare(ctx context.Context, k, p string, opts ...snapshots.Opt) ([]mount.Mount, error) {
	if b.after {
		if _, err := b.Snapshotter.Prepare(ctx, k, p, opts...); err != nil {
			return nil, err
		}
	}
	return nil, context.Canceled
}
func TestErrorResolvesActualBackendOutcome(t *testing.T) {
	for _, after := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "after"}[after], func(t *testing.T) {
			s := openRecoveryStore(t, t.TempDir())
			defer s.backend.Close()
			s.save()
			backend := s.backend
			s.backend = interruptedPrepare{backend, after}
			c := &Client{s, "A"}
			if _, err := c.Prepare(context.Background(), "interrupted", ""); err != context.Canceled {
				t.Fatal(err)
			}
			_, err := c.Stat(context.Background(), "interrupted")
			if after && err != nil {
				t.Fatal(err)
			}
			if !after && !errdefs.IsNotFound(err) {
				t.Fatal(err)
			}
			if _, err := os.Stat(s.path + ".intent"); !os.IsNotExist(err) {
				t.Fatal("intent not resolved", err)
			}
			s.backend = backend
			if _, err := c.Prepare(context.Background(), "next", ""); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRestoreCleansAbandonedDirectories(t *testing.T) {
	root := t.TempDir()
	s := openRecoveryStore(t, root)
	defer s.backend.Close()
	c := &Client{s, "A"}
	if _, err := c.Prepare(context.Background(), "active", ""); err != nil {
		t.Fatal(err)
	}
	abandoned := filepath.Join(root, "overlay", "snapshots", "new-abandoned")
	if err := os.Mkdir(abandoned, 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(abandoned); !os.IsNotExist(err) {
		t.Fatal("abandoned directory retained", err)
	}
	if _, err := c.Mounts(context.Background(), "active"); err != nil {
		t.Fatal(err)
	}
}
