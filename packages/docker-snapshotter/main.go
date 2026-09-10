// Trusted-client snapshotter with durable recovery of backend/index mutations.
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
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	contentapi "github.com/containerd/containerd/api/services/content/v1"
	diffapi "github.com/containerd/containerd/api/services/diff/v1"
	api "github.com/containerd/containerd/api/services/snapshots/v1"
	"github.com/containerd/containerd/v2/contrib/snapshotservice"
	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/filters"
	"github.com/containerd/containerd/v2/plugins/services/content/contentserver"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	"google.golang.org/grpc"
)

const refLabel = "containerd.io/snapshot.ref"

var clientPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,48}$`)

type Alias struct {
	Info    snapshots.Info
	Backing string
	Target  string
}
type Chain struct{ Backing, Parent string }
type State struct {
	Sequence             uint64
	Clients              map[string]map[string]Alias
	Chains               map[string]Chain
	Retired              map[string]bool
	Parents              map[string]string    `json:",omitempty"`
	UnusedSince          map[string]time.Time `json:",omitempty"`
	GCFailure            *GCFailure           `json:",omitempty"`
	PendingLayerRemovals map[string]string    `json:",omitempty"`
}
type Store struct {
	sync.Mutex
	backend    snapshots.Snapshotter
	state      State
	path       string
	gcRequests chan struct{}
}
type Client struct {
	s  *Store
	id string
}

func (s *Store) save() {
	s.updateUnusedLayers()
	must(durableJSON(s.path, s.state))
}
func must(e error) {
	if e != nil {
		panic(e)
	}
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
	// Always let containerd fetch/register the content before committing reuse.
	// Early AlreadyExists skips blobs as well as extraction, making exports empty.
	b := fmt.Sprintf("physical-%d", c.s.state.Sequence+1)
	kind := "prepare"
	if view {
		kind = "view"
	}
	if e := c.s.mutate(ctx, mutation{Kind: kind, Key: b, Parent: bp, Labels: i.Labels}, func() {
		c.s.state.Sequence++
		c.s.state.Clients[c.id][k] = Alias{i, b, target}
	}); e != nil {
		return nil, e
	}
	m, e := c.s.backend.Mounts(ctx, b)
	if e != nil {
		return nil, e
	}
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
	b := fmt.Sprintf("physical-%d", c.s.state.Sequence+1)
	op := mutation{Kind: "commit", Key: a.Backing, Name: b, Parent: bp, Labels: i.Labels}
	if ch, ok := c.s.state.Chains[a.Target]; ok {
		if ch.Parent != bp {
			return errdefs.ErrFailedPrecondition
		}
		b = ch.Backing
		op = mutation{Kind: "remove", Key: a.Backing}
	}
	if e := c.s.mutate(ctx, op, func() {
		if op.Kind == "commit" {
			c.s.state.Sequence++
			if a.Target != "" {
				c.s.state.Chains[a.Target] = Chain{b, bp}
			}
		}
		delete(c.s.state.Clients[c.id], key)
		c.s.state.Clients[c.id][name] = Alias{i, b, a.Target}
	}); e != nil {
		return e
	}
	c.s.requestLayerGC()
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
	if e := c.s.removeAlias(ctx, c.id, k, a); e != nil {
		return e
	}
	c.s.requestLayerGC()
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
	// Tombstone even an unseen identity: retirement may overtake a timed-out
	// registration request, which must not resurrect a deleted workspace later.
	s.state.Retired[id] = true
	s.save()

	// Remove leaves first: Docker's private committed init snapshot parents its
	// writable container snapshot. Neither is shared immutable image backing.
	for len(s.state.Clients[id]) > 0 {
		progress := false
		for k, a := range s.state.Clients[id] {
			hasChild := false
			for _, child := range s.state.Clients[id] {
				if child.Info.Parent == k {
					hasChild = true
					break
				}
			}
			if hasChild {
				continue
			}
			if e := s.removeAlias(ctx, id, k, a); e != nil {
				return e
			}
			progress = true
		}
		if !progress {
			return fmt.Errorf("cyclic client snapshot graph: %w", errdefs.ErrFailedPrecondition)
		}
	}
	s.state.Clients[id] = map[string]Alias{}
	s.state.Retired[id] = true
	s.save()
	s.requestLayerGC()
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
	localSocket := flag.String("local-socket", "", "run workspace-local snapshotter on this socket")
	localRoot := flag.String("local-root", "", "workspace volume directory for private snapshots")
	sharedSocket := flag.String("shared-socket", "", "installation client socket for local coordinator")
	containerdSocket := flag.String("containerd-socket", "/run/containerd/containerd.sock", "private containerd callback socket")
	root := flag.String("root", "", "absolute backend store")
	dir := flag.String("socket-dir", "", "absolute socket directory")
	clients := flag.String("clients", "", "comma separated fixed client IDs")
	connectionFile := flag.String("connection-file", "", "publish installation connection descriptor")
	registryAddress := flag.String("registry-address", "", "installation-owned TCP registry address; also advertise BuildKit socket")
	instance := flag.String("instance-id", fmt.Sprint(os.Getpid()), "readiness identity")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if *localSocket != "" {
		for _, path := range []string{*localSocket, *sharedSocket, *containerdSocket, *localRoot} {
			if !filepath.IsAbs(path) {
				panic("absolute local snapshotter socket and storage paths required")
			}
		}
		runLocal(*sharedSocket, *containerdSocket, *localSocket, *localRoot)
		return
	}
	if !filepath.IsAbs(*root) || !filepath.IsAbs(*dir) {
		panic("absolute root and socket-dir required")
	}
	must(os.MkdirAll(*root, 0700))
	must(os.MkdirAll(*dir, 0700))
	owner, e := lockStore(*root)
	must(e)
	defer owner.Close()
	backend, e := overlay.NewSnapshotter(filepath.Join(*root, "overlayfs"), overlay.WithUpperdirLabel)
	must(e)
	defer backend.Close()
	s := &Store{backend: backend, path: filepath.Join(*root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{}, Chains: map[string]Chain{}, Retired: map[string]bool{}, Parents: map[string]string{}}}
	if b, e := os.ReadFile(s.path); e == nil {
		must(json.Unmarshal(b, &s.state))
	} else if !os.IsNotExist(e) {
		must(e)
	}
	must(s.restore(context.Background()))
	var legacyClients []string
	for id := range s.state.Clients {
		if !s.state.Retired[id] {
			legacyClients = append(legacyClients, id)
		}
	}
	blobs, e := openBlobs(filepath.Join(*root, "content"), legacyClients...)
	must(e)
	for id, retired := range s.state.Retired {
		if retired {
			must(blobs.retire(context.Background(), id))
		}
	}
	var serviceLock sync.Mutex
	servers := map[string]*grpc.Server{}
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
	register := func(id, parent string) error {
		if !clientPattern.MatchString(id) || len(filepath.Join(*dir, id+".sock")) >= 108 {
			return errdefs.ErrInvalidArgument
		}
		s.Lock()
		defer s.Unlock()
		if err := s.claimClient(id, parent); err != nil {
			return err
		}
		if servers[id] != nil {
			return nil
		}
		clientID := id
		g := grpc.NewServer(grpc.WaitForHandlers(true), grpc.UnaryInterceptor(func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
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
		registerWarm(g, &sharedWarm{client: &Client{s, id}, blobs: blobs})
		registerImageLayers(g, &Client{s, id})
		contentapi.RegisterContentServer(g, contentserver.New(&clientContent{blobStore: blobs, prefix: id + "/"}))
		diffapi.RegisterDiffServer(g, &sharedDiff{client: &Client{s, id}, blobs: blobs})
		l := listen(filepath.Join(*dir, id+".sock"))
		go func() {
			if err := g.Serve(l); err != nil && err != grpc.ErrServerStopped {
				panic(err)
			}
		}()
		servers[id] = g
		s.save()
		slog.Info("client-ready", "client", id)
		return nil
	}

	for id := range clientIDs {
		must(register(id, s.state.Parents[id]))
	}
	s.Lock()
	s.save()
	s.Unlock()
	stopLayerGC := s.startLayerGC()
	defer stopLayerGC()
	mux := http.NewServeMux()
	s.registerStorageAPI(mux)
	blobs.registerContentStorageAPI(mux)
	stopContentGC := blobs.startContentGC()
	defer stopContentGC()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, *instance)
	})
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, r *http.Request) {
		s.Lock()
		defer s.Unlock()
		w.Header().Set("Content-Type", "application/json")
		must(json.NewEncoder(w).Encode(s.state))
	})
	mux.HandleFunc("POST /register", func(w http.ResponseWriter, r *http.Request) {
		serviceLock.Lock()
		defer serviceLock.Unlock()
		if err := register(r.URL.Query().Get("client"), r.URL.Query().Get("parent")); err != nil {
			status := http.StatusInternalServerError
			if errdefs.IsInvalidArgument(err) {
				status = http.StatusBadRequest
			}
			if errdefs.IsFailedPrecondition(err) {
				status = http.StatusConflict
			}
			http.Error(w, err.Error(), status)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /retire", func(w http.ResponseWriter, r *http.Request) {
		serviceLock.Lock()
		defer serviceLock.Unlock()
		id := r.URL.Query().Get("client")
		if !clientPattern.MatchString(id) {
			http.Error(w, "invalid client identity", http.StatusBadRequest)
			return
		}
		ids, err := s.retireTree(r.Context(), id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for _, client := range ids {
			if server := servers[client]; server != nil {
				server.Stop()
				delete(servers, client)
			}
			if err := blobs.retire(r.Context(), client); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(204)
	})
	if *connectionFile != "" {
		connection := map[string]any{"version": 1, "adminSocket": filepath.Join(*dir, "admin.sock"), "snapshotterRoot": *root, "socketDirectory": *dir, "depth": 0}
		if *registryAddress != "" {
			connection["buildServices"] = map[string]string{"buildkitSocket": filepath.Join(*dir, "buildkit.sock"), "registryAddress": *registryAddress}
		}
		descriptor, err := json.Marshal(connection)
		must(err)
		must(os.MkdirAll(filepath.Dir(*connectionFile), 0755))
		must(os.WriteFile(*connectionFile+".tmp", descriptor, 0644))
		must(os.Rename(*connectionFile+".tmp", *connectionFile))
	}
	admin := &http.Server{Handler: mux}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stop)
	al := listen(filepath.Join(*dir, "admin.sock"))
	go func() {
		e := admin.Serve(al)
		if e != http.ErrServerClosed {
			must(e)
		}
	}()

	slog.Info("ready", "root", *root, "socket_dir", *dir, "clients", clientIDs, "version", "containerd-v2.2.2")
	<-stop
	must(admin.Shutdown(context.Background()))
	serviceLock.Lock()
	for _, g := range servers {
		g.GracefulStop()
	}
	serviceLock.Unlock()
}
