// Experimental trusted-client adapter. Backend and index are not one crash-atomic transaction.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	"github.com/containerd/containerd/v2/contrib/snapshotservice"
	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/filters"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	"google.golang.org/grpc"
)

const refLabel = "containerd.io/snapshot.ref"

type Alias struct {
	Info    snapshots.Info
	Backing string
	Target  string
}
type Chain struct{ Backing, Parent string }
type State struct {
	Sequence uint64
	Clients  map[string]map[string]Alias
	Chains   map[string]Chain
	Retired  map[string]bool
}
type Store struct {
	sync.Mutex
	backend snapshots.Snapshotter
	state   State
	path    string
}
type Client struct {
	s  *Store
	id string
}

func (s *Store) save() {
	b, e := json.MarshalIndent(s.state, "", "  ")
	must(e)
	must(os.WriteFile(s.path+".tmp", b, 0600))
	must(os.Rename(s.path+".tmp", s.path))
}
func must(e error) {
	if e != nil {
		panic(e)
	}
}
func (s *Store) next() string {
	s.state.Sequence++
	return fmt.Sprintf("physical-%d", s.state.Sequence)
}
func clone(i snapshots.Info) snapshots.Info {
	m := map[string]string{}
	for k, v := range i.Labels {
		m[k] = v
	}
	i.Labels = m
	return i
}
func (c *Client) lookup(k string) (Alias, error) {
	if c.s.state.Retired[c.id] {
		return Alias{}, fmt.Errorf("client retired: %w", errdefs.ErrFailedPrecondition)
	}
	a, ok := c.s.state.Clients[c.id][k]
	if !ok {
		return a, fmt.Errorf("%s: %w", k, errdefs.ErrNotFound)
	}
	return a, nil
}
func (c *Client) Stat(ctx context.Context, k string) (snapshots.Info, error) {
	c.s.Lock()
	defer c.s.Unlock()
	a, e := c.lookup(k)
	return clone(a.Info), e
}
func (c *Client) Update(ctx context.Context, i snapshots.Info, paths ...string) (snapshots.Info, error) {
	c.s.Lock()
	defer c.s.Unlock()
	a, e := c.lookup(i.Name)
	if e != nil {
		return snapshots.Info{}, e
	}
	a.Info = clone(a.Info)
	if len(paths) == 0 {
		a.Info.Labels = clone(i).Labels
	}
	for _, p := range paths {
		if p == "labels" {
			a.Info.Labels = clone(i).Labels
		} else if strings.HasPrefix(p, "labels.") {
			k := strings.TrimPrefix(p, "labels.")
			if v, ok := i.Labels[k]; ok {
				a.Info.Labels[k] = v
			} else {
				delete(a.Info.Labels, k)
			}
		} else {
			return snapshots.Info{}, fmt.Errorf("immutable field %s: %w", p, errdefs.ErrInvalidArgument)
		}
	}
	a.Info.Updated = time.Now().UTC()
	c.s.state.Clients[c.id][i.Name] = a
	c.s.save()
	return clone(a.Info), nil
}
func (c *Client) Usage(ctx context.Context, k string) (snapshots.Usage, error) {
	c.s.Lock()
	defer c.s.Unlock()
	a, e := c.lookup(k)
	if e != nil {
		return snapshots.Usage{}, e
	}
	return c.s.backend.Usage(ctx, a.Backing)
}
func (c *Client) Mounts(ctx context.Context, k string) ([]mount.Mount, error) {
	c.s.Lock()
	defer c.s.Unlock()
	a, e := c.lookup(k)
	if e != nil {
		return nil, e
	}
	return c.s.backend.Mounts(ctx, a.Backing)
}
func (c *Client) Prepare(ctx context.Context, k, p string, opts ...snapshots.Opt) ([]mount.Mount, error) {
	return c.create(ctx, k, p, false, opts...)
}
func (c *Client) View(ctx context.Context, k, p string, opts ...snapshots.Opt) ([]mount.Mount, error) {
	return c.create(ctx, k, p, true, opts...)
}
func (c *Client) create(ctx context.Context, k, p string, view bool, opts ...snapshots.Opt) ([]mount.Mount, error) {
	c.s.Lock()
	defer c.s.Unlock()
	if c.s.state.Retired[c.id] {
		return nil, fmt.Errorf("retired: %w", errdefs.ErrFailedPrecondition)
	}
	if _, ok := c.s.state.Clients[c.id][k]; ok {
		return nil, errdefs.ErrAlreadyExists
	}
	bp := ""
	if p != "" {
		a, e := c.lookup(p)
		if e != nil {
			return nil, e
		}
		if a.Info.Kind != snapshots.KindCommitted {
			return nil, errdefs.ErrInvalidArgument
		}
		bp = a.Backing
	}
	now := time.Now().UTC()
	i := snapshots.Info{Name: k, Parent: p, Kind: snapshots.KindActive, Created: now, Updated: now, Labels: map[string]string{}}
	if view {
		i.Kind = snapshots.KindView
	}
	for _, o := range opts {
		if e := o(&i); e != nil {
			return nil, e
		}
	}
	target := i.Labels[refLabel]
	if target != "" {
		if e := digest.Digest(target).Validate(); e != nil {
			return nil, fmt.Errorf("invalid chain reference: %w", errdefs.ErrInvalidArgument)
		}
	}
	if ch, ok := c.s.state.Chains[target]; ok && !view {
		if ch.Parent != bp {
			return nil, fmt.Errorf("chain parent mismatch: %w", errdefs.ErrFailedPrecondition)
		}
		bi, e := c.s.backend.Stat(ctx, ch.Backing)
		if e != nil {
			return nil, e
		}
		i.Kind = snapshots.KindCommitted
		i.Created = bi.Created
		i.Updated = bi.Updated
		c.s.state.Clients[c.id][k] = Alias{i, ch.Backing, target}
		c.s.save()
		slog.Info("reuse", "client", c.id, "key", k, "parent", p, "snapshot.ref", target, "backing", ch.Backing, "hit", true)
		return nil, errdefs.ErrAlreadyExists
	}
	b := c.s.next()
	c.s.save()
	var m []mount.Mount
	var e error
	if view {
		m, e = c.s.backend.View(ctx, b, bp, opts...)
	} else {
		m, e = c.s.backend.Prepare(ctx, b, bp, opts...)
	}
	if e != nil {
		return nil, e
	}
	c.s.state.Clients[c.id][k] = Alias{i, b, target}
	c.s.save()
	slog.Info("create", "client", c.id, "key", k, "parent", p, "snapshot.ref", target, "backing", b, "hit", false)
	return m, nil
}
func (c *Client) Commit(ctx context.Context, name, key string, opts ...snapshots.Opt) error {
	c.s.Lock()
	defer c.s.Unlock()
	a, e := c.lookup(key)
	if e != nil {
		return e
	}
	if a.Info.Kind != snapshots.KindActive {
		return errdefs.ErrFailedPrecondition
	}
	if _, ok := c.s.state.Clients[c.id][name]; ok {
		return errdefs.ErrAlreadyExists
	}
	i := snapshots.Info{Name: name, Parent: a.Info.Parent, Kind: snapshots.KindCommitted, Created: a.Info.Created, Updated: time.Now().UTC(), Labels: map[string]string{}}
	for _, o := range opts {
		if e := o(&i); e != nil {
			return e
		}
	}
	if a.Target != "" {
		i.Labels[refLabel] = a.Target
	}
	bp := ""
	if a.Info.Parent != "" {
		p, e := c.lookup(a.Info.Parent)
		if e != nil {
			return e
		}
		bp = p.Backing
	}
	b := ""
	if ch, ok := c.s.state.Chains[a.Target]; ok {
		if ch.Parent != bp {
			return errdefs.ErrFailedPrecondition
		}
		if e := c.s.backend.Remove(ctx, a.Backing); e != nil {
			return e
		}
		b = ch.Backing
	} else {
		b = c.s.next()
		c.s.save()
		if e := c.s.backend.Commit(ctx, b, a.Backing, snapshots.WithLabels(i.Labels)); e != nil {
			return e
		}
		if a.Target != "" {
			c.s.state.Chains[a.Target] = Chain{b, bp}
		}
	}
	delete(c.s.state.Clients[c.id], key)
	c.s.state.Clients[c.id][name] = Alias{i, b, a.Target}
	c.s.save()
	slog.Info("commit", "client", c.id, "key", key, "name", name, "snapshot.ref", a.Target, "backing", b)
	return nil
}
func retained(a Alias) bool { return a.Info.Kind == snapshots.KindCommitted && a.Target != "" }

func (c *Client) Remove(ctx context.Context, k string) error {
	c.s.Lock()
	defer c.s.Unlock()
	a, e := c.lookup(k)
	if e != nil {
		return e
	}
	for _, v := range c.s.state.Clients[c.id] {
		if v.Info.Parent == k {
			return errdefs.ErrFailedPrecondition
		}
	}
	if !retained(a) {
		if e := c.s.backend.Remove(ctx, a.Backing); e != nil {
			return e
		}
	}
	delete(c.s.state.Clients[c.id], k)
	c.s.save()
	slog.Info("remove", "client", c.id, "key", k, "backing", a.Backing, "retained", retained(a))
	return nil
}
func (c *Client) Walk(ctx context.Context, fn snapshots.WalkFunc, fs ...string) error {
	f, e := filters.ParseAll(fs...)
	if e != nil {
		return e
	}
	c.s.Lock()
	if c.s.state.Retired[c.id] {
		c.s.Unlock()
		return errdefs.ErrFailedPrecondition
	}
	items := []snapshots.Info{}
	for _, a := range c.s.state.Clients[c.id] {
		items = append(items, clone(a.Info))
	}
	c.s.Unlock()
	for _, i := range items {
		ad := filters.AdapterFunc(func(p []string) (string, bool) {
			if len(p) == 0 {
				return "", false
			}
			switch p[0] {
			case "name":
				return i.Name, true
			case "parent":
				return i.Parent, true
			case "kind":
				switch i.Kind {
				case snapshots.KindActive:
					return "active", true
				case snapshots.KindView:
					return "view", true
				case snapshots.KindCommitted:
					return "committed", true
				}
			case "labels":
				v, ok := i.Labels[strings.Join(p[1:], ".")]
				return v, ok
			}
			return "", false
		})
		if f.Match(ad) {
			if e := fn(ctx, i); e != nil {
				return e
			}
		}
	}
	return nil
}
func (c *Client) Cleanup(ctx context.Context) error {
	c.s.Lock()
	defer c.s.Unlock()
	if c.s.state.Retired[c.id] {
		return errdefs.ErrFailedPrecondition
	}
	if cleaner, ok := c.s.backend.(snapshots.Cleaner); ok {
		return cleaner.Cleanup(ctx)
	}
	return nil
}
func (c *Client) Close() error { return nil }
func (s *Store) retire(ctx context.Context, id string) error {
	s.Lock()
	defer s.Unlock()
	m, ok := s.state.Clients[id]
	if !ok {
		return errdefs.ErrNotFound
	}
	// Remove leaves first: Docker's private committed init snapshot parents its
	// writable container snapshot. Neither is shared immutable image backing.
	for len(m) > 0 {
		progress := false
		for k, a := range m {
			hasChild := false
			for _, child := range m {
				if child.Info.Parent == k {
					hasChild = true
					break
				}
			}
			if hasChild {
				continue
			}
			if !retained(a) {
				if e := s.backend.Remove(ctx, a.Backing); e != nil {
					return e
				}
			}
			delete(m, k)
			s.save()
			progress = true
		}
		if !progress {
			return fmt.Errorf("cyclic client snapshot graph: %w", errdefs.ErrFailedPrecondition)
		}
	}
	s.state.Clients[id] = map[string]Alias{}
	s.state.Retired[id] = true
	s.save()
	slog.Info("retire", "client", id)
	return nil
}
func listen(path string) net.Listener {
	if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
		must(e)
	}
	l, e := net.Listen("unix", path)
	must(e)
	must(os.Chmod(path, 0600))
	return l
}
func lockStore(root string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(root, "owner.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("snapshotter store already owned: %w", err)
	}
	return f, nil
}

func main() {
	root := flag.String("root", "", "absolute backend store")
	dir := flag.String("socket-dir", "", "absolute socket directory")
	clients := flag.String("clients", "", "comma separated fixed client IDs")
	instance := flag.String("instance-id", fmt.Sprint(os.Getpid()), "readiness identity")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if !filepath.IsAbs(*root) || !filepath.IsAbs(*dir) {
		panic("absolute root and socket-dir required")
	}
	must(os.MkdirAll(*root, 0700))
	must(os.MkdirAll(*dir, 0700))
	owner, e := lockStore(*root)
	must(e)
	defer owner.Close()
	backend, e := overlay.NewSnapshotter(filepath.Join(*root, "overlayfs"))
	must(e)
	defer backend.Close()
	s := &Store{backend: backend, path: filepath.Join(*root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	if b, e := os.ReadFile(s.path); e == nil {
		must(json.Unmarshal(b, &s.state))
	} else if !os.IsNotExist(e) {
		must(e)
	}
	servers := []*grpc.Server{}
	clientIDs := map[string]bool{}
	if *clients != "" {
		for _, id := range strings.Split(*clients, ",") {
			clientIDs[id] = true
		}
	}
	for id := range s.state.Clients {
		if !s.state.Retired[id] {
			clientIDs[id] = true
		}
	}
	for id := range clientIDs {
		if id == "" || strings.ContainsAny(id, "/\\.") {
			panic("invalid client ID")
		}
		if s.state.Clients[id] == nil {
			s.state.Clients[id] = map[string]Alias{}
		}
		clientID := id
		g := grpc.NewServer(grpc.UnaryInterceptor(func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
			t := time.Now()
			r, e := h(ctx, req)
			slog.Info("rpc", "client", clientID, "method", info.FullMethod, "request", fmt.Sprint(req), "error", fmt.Sprint(e), "duration_us", time.Since(t).Microseconds())
			return r, e
		}), grpc.StreamInterceptor(func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, h grpc.StreamHandler) error {
			t := time.Now()
			e := h(srv, ss)
			slog.Info("rpc", "client", clientID, "method", info.FullMethod, "error", fmt.Sprint(e), "duration_us", time.Since(t).Microseconds())
			return e
		}))
		api.RegisterSnapshotsServer(g, snapshotservice.FromSnapshotter(&Client{s, id}))
		l := listen(filepath.Join(*dir, id+".sock"))
		go func() { must(g.Serve(l)) }()
		servers = append(servers, g)
	}
	s.save()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, *instance)
	})
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, r *http.Request) {
		s.Lock()
		defer s.Unlock()
		w.Header().Set("Content-Type", "application/json")
		must(json.NewEncoder(w).Encode(s.state))
	})
	mux.HandleFunc("POST /retire", func(w http.ResponseWriter, r *http.Request) {
		if e := s.retire(r.Context(), r.URL.Query().Get("client")); e != nil {
			http.Error(w, e.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
	admin := &http.Server{Handler: mux}
	al := listen(filepath.Join(*dir, "admin.sock"))
	go func() {
		e := admin.Serve(al)
		if e != http.ErrServerClosed {
			must(e)
		}
	}()
	slog.Info("ready", "root", *root, "socket_dir", *dir, "clients", clientIDs, "version", "containerd-v2.2.2")
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	for _, g := range servers {
		g.GracefulStop()
	}
	must(admin.Close())
}
