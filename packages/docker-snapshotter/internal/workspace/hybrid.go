package workspace

// The private overlay backend is the source of truth for private snapshots.
// Ancestry crossing into the immutable store is persisted in the same metadata
// transaction as Prepare/Commit, using reserved labels. There is no second
// journal whose state could diverge after a crash.
// Containerd metadata already gives this backend globally unique keys. Do not
// namespace them again: containerd GC walks/removes across namespaces using a
// background context without a namespace.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/filters"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay/overlayutils"
	"github.com/containerd/errdefs"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/protocol"
	digest "github.com/opencontainers/go-digest"
)

const privatePrefix = "atelier.internal.private."
const sharedParentLabel = privatePrefix + "parent"
const sharedLayersLabel = privatePrefix + "layers"
const initializeLabel = privatePrefix + "initialize"
const upperLabel = "containerd.io/snapshot/overlay.upperdir"

// Hybrid owns private snapshot backing and resolves immutable image ancestry
// through the shared snapshotter. Closing it closes only the private backend.
type Hybrid struct {
	mu           sync.Mutex
	mountOptions []string
	private      snapshots.Snapshotter
	shared       snapshots.Snapshotter
	resolve      func(context.Context, string) ([]string, error)
}

// NewHybrid opens private backing and recovers pending initialization before use.
// The caller owns the shared snapshotter and resolver lifetimes.
func NewHybrid(root string, shared snapshots.Snapshotter, resolve func(context.Context, string) ([]string, error)) (*Hybrid, error) {
	p, err := overlay.NewSnapshotter(root, overlay.WithUpperdirLabel)
	if err != nil {
		return nil, err
	}
	// Upstream Cleanup reclaims backing directories left by interrupted removals
	// and allocations; all ancestry metadata lives in its transactional store.
	if err := p.(snapshots.Cleaner).Cleanup(context.Background()); err != nil && !errdefs.IsNotFound(err) {
		p.Close()
		return nil, err
	}
	options := []string{}
	if _, err := os.Stat("/sys/module/overlay/parameters/index"); err == nil {
		options = append(options, "index=off")
	} else if !os.IsNotExist(err) {
		p.Close()
		return nil, err
	}
	userxattr, err := overlayutils.NeedsUserXAttr(root)
	if err != nil {
		p.Close()
		return nil, err
	}
	if userxattr {
		options = append(options, "userxattr")
	}
	h := &Hybrid{private: p, shared: shared, resolve: resolve, mountOptions: options}
	var pending []string
	if err := walkPrivate(p, context.Background(), func(_ context.Context, i snapshots.Info) error {
		if i.Labels[initializeLabel] != "" {
			pending = append(pending, i.Name)
		}
		return nil
	}); err != nil {
		p.Close()
		return nil, err
	}
	for _, key := range pending {
		if err := h.initialize(context.Background(), key); err != nil {
			p.Close()
			return nil, err
		}
	}
	return h, nil
}
func logicalInfo(i snapshots.Info) snapshots.Info {
	i.Labels = maps.Clone(i.Labels)
	if i.Parent == "" {
		i.Parent = i.Labels[sharedParentLabel]
	}
	for k := range i.Labels {
		if strings.HasPrefix(k, privatePrefix) || k == upperLabel {
			delete(i.Labels, k)
		}
	}
	return i
}
func requestedInfo(opts []snapshots.Opt) (snapshots.Info, error) {
	i := snapshots.Info{Labels: map[string]string{}}
	for _, opt := range opts {
		if err := opt(&i); err != nil {
			return i, err
		}
	}
	for k := range i.Labels {
		if strings.HasPrefix(k, privatePrefix) || k == upperLabel {
			return i, fmt.Errorf("reserved snapshot label %s: %w", k, errdefs.ErrInvalidArgument)
		}
	}
	return i, nil
}
func (h *Hybrid) Stat(ctx context.Context, key string) (snapshots.Info, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stat(ctx, key)
}
func (h *Hybrid) stat(ctx context.Context, key string) (snapshots.Info, error) {
	i, err := h.private.Stat(ctx, key)
	if errdefs.IsNotFound(err) {
		return h.shared.Stat(ctx, key)
	}
	if err != nil {
		return i, err
	}
	return logicalInfo(i), nil
}
func (h *Hybrid) Prepare(ctx context.Context, key, parent string, opts ...snapshots.Opt) ([]mount.Mount, error) {
	return h.create(ctx, key, parent, false, opts...)
}
func (h *Hybrid) View(ctx context.Context, key, parent string, opts ...snapshots.Opt) ([]mount.Mount, error) {
	return h.create(ctx, key, parent, true, opts...)
}
func (h *Hybrid) create(ctx context.Context, key, parent string, view bool, opts ...snapshots.Opt) ([]mount.Mount, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	i, err := requestedInfo(opts)
	if err != nil {
		return nil, err
	}
	if _, err := h.stat(ctx, key); err == nil {
		return nil, errdefs.ErrAlreadyExists
	} else if !errdefs.IsNotFound(err) {
		return nil, err
	}
	if target := i.Labels[protocol.RefLabel]; target != "" {
		if err := digest.Digest(target).Validate(); err != nil {
			return nil, fmt.Errorf("invalid image reference: %w", errdefs.ErrInvalidArgument)
		}
		privateParent := false
		if parent != "" {
			if _, err := h.private.Stat(ctx, parent); err == nil {
				privateParent = true
			} else if !errdefs.IsNotFound(err) {
				return nil, err
			}
		}
		// Images produced by docker commit can have workspace-private image
		// ancestry. Their descendants stay local rather than pretending that
		// their parents have been published into the installation cache.
		if !privateParent {
			if view {
				return h.shared.View(ctx, key, parent, opts...)
			}
			return h.shared.Prepare(ctx, key, parent, opts...)
		}
	}
	if i.Labels[snapshots.LabelSnapshotUIDMapping] != "" || i.Labels[snapshots.LabelSnapshotGIDMapping] != "" {
		return nil, fmt.Errorf("private shared overlays do not support ID mapping: %w", errdefs.ErrInvalidArgument)
	}
	localParent := ""
	var layers []string
	if parent != "" {
		p, err := h.private.Stat(ctx, parent)
		if errdefs.IsNotFound(err) {
			p, err = h.shared.Stat(ctx, parent)
			if err != nil {
				return nil, err
			}
			if p.Kind != snapshots.KindCommitted {
				return nil, errdefs.ErrInvalidArgument
			}
			layers, err = h.resolve(ctx, parent)
			if err != nil {
				return nil, err
			}
			if len(layers) == 0 {
				return nil, fmt.Errorf("shared image has no backing layers: %w", errdefs.ErrFailedPrecondition)
			}
			encoded, err := json.Marshal(layers)
			if err != nil {
				return nil, err
			}
			i.Labels[sharedParentLabel] = parent
			i.Labels[sharedLayersLabel] = string(encoded)
		} else if err != nil {
			return nil, err
		} else {
			localParent = parent
			if p.Labels[sharedLayersLabel] != "" {
				i.Labels[sharedLayersLabel] = p.Labels[sharedLayersLabel]
			}
		}
	}
	if !view && len(layers) > 0 {
		i.Labels[initializeLabel] = "true"
	}
	if view {
		_, err = h.private.View(ctx, key, localParent, snapshots.WithLabels(i.Labels))
	} else {
		_, err = h.private.Prepare(ctx, key, localParent, snapshots.WithLabels(i.Labels))
	}
	if err != nil {
		return nil, err
	}
	rollback := func(err error) ([]mount.Mount, error) { return nil, errors.Join(err, h.private.Remove(ctx, key)) }
	if !view && len(layers) > 0 {
		if err := h.initialize(ctx, key); err != nil {
			return rollback(err)
		}
	}
	m, err := h.mounts(ctx, key)
	if err != nil {
		return rollback(err)
	}
	return m, nil
}
func (h *Hybrid) Mounts(ctx context.Context, key string) ([]mount.Mount, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, err := h.private.Stat(ctx, key); errdefs.IsNotFound(err) {
		return h.shared.Mounts(ctx, key)
	} else if err != nil {
		return nil, err
	}
	return h.mounts(ctx, key)
}
func (h *Hybrid) mounts(ctx context.Context, key string) ([]mount.Mount, error) {
	i, err := h.private.Stat(ctx, key)
	if err != nil {
		return nil, err
	}
	m, err := h.private.Mounts(ctx, key)
	if err != nil {
		return nil, err
	}
	if i.Labels[sharedLayersLabel] == "" {
		return m, nil
	}
	var layers []string
	if err := json.Unmarshal([]byte(i.Labels[sharedLayersLabel]), &layers); err != nil {
		return nil, err
	}
	// Upstream returns one overlay mount, or a bind mount for zero/one
	// ancestors. Expand that optimized bind when shared ancestors are present.
	lower := strings.Join(layers, ":")
	if m[0].Type == "overlay" {
		for n, opt := range m[0].Options {
			if strings.HasPrefix(opt, "lowerdir=") {
				m[0].Options[n] = opt + ":" + lower
				return m, nil
			}
		}
		return nil, fmt.Errorf("overlay mount missing lowerdir")
	}
	if i.Kind == snapshots.KindView {
		if i.Parent != "" {
			lower = m[0].Source + ":" + lower
		}
		if i.Parent == "" && len(layers) == 1 {
			return []mount.Mount{{Type: "bind", Source: layers[0], Options: []string{"ro", "rbind"}}}, nil
		}
		return []mount.Mount{{Type: "overlay", Source: "overlay", Options: append([]string{"ro", "lowerdir=" + lower}, h.mountOptions...)}}, nil
	}
	upper := i.Labels[upperLabel]
	// WithUpperdirLabel exposes fs; the upstream overlay backend allocates its
	// work directory alongside fs in the same snapshot directory.
	options := []string{"workdir=" + filepath.Join(filepath.Dir(upper), "work"), "upperdir=" + upper, "lowerdir=" + lower}
	for _, opt := range m[0].Options {
		if opt != "bind" && opt != "rbind" && opt != "rw" && opt != "ro" {
			options = append(options, opt)
		}
	}
	options = append(options, h.mountOptions...)
	return []mount.Mount{{Type: "overlay", Source: "overlay", Options: options}}, nil
}
func (h *Hybrid) Commit(ctx context.Context, name, key string, opts ...snapshots.Opt) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	requested, err := requestedInfo(opts)
	if err != nil {
		return err
	}
	raw, err := h.private.Stat(ctx, key)
	if errdefs.IsNotFound(err) {
		if _, err := h.private.Stat(ctx, name); err == nil {
			return errdefs.ErrAlreadyExists
		} else if !errdefs.IsNotFound(err) {
			return err
		}
		return h.shared.Commit(ctx, name, key, opts...)
	}
	if err != nil {
		return err
	}
	if _, err := h.stat(ctx, name); err == nil {
		return errdefs.ErrAlreadyExists
	} else if !errdefs.IsNotFound(err) {
		return err
	}
	for label, value := range raw.Labels {
		if strings.HasPrefix(label, privatePrefix) {
			requested.Labels[label] = value
		}
	}
	return h.private.Commit(ctx, name, key, snapshots.WithLabels(requested.Labels))
}
func (h *Hybrid) Update(ctx context.Context, i snapshots.Info, paths ...string) (snapshots.Info, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, err := requestedInfo([]snapshots.Opt{snapshots.WithLabels(i.Labels)}); err != nil {
		return snapshots.Info{}, err
	}
	for _, p := range paths {
		if strings.HasPrefix(p, "labels."+privatePrefix) || p == "labels."+upperLabel {
			return snapshots.Info{}, errdefs.ErrInvalidArgument
		}
	}
	raw, err := h.private.Stat(ctx, i.Name)
	if errdefs.IsNotFound(err) {
		return h.shared.Update(ctx, i, paths...)
	}
	if err != nil {
		return snapshots.Info{}, err
	}
	i.Labels = maps.Clone(i.Labels)
	if i.Labels == nil {
		i.Labels = map[string]string{}
	}
	for label, value := range raw.Labels {
		if strings.HasPrefix(label, privatePrefix) {
			i.Labels[label] = value
		}
	}
	updated, err := h.private.Update(ctx, i, paths...)
	if err != nil {
		return updated, err
	}
	return logicalInfo(updated), nil
}
func (h *Hybrid) Usage(ctx context.Context, key string) (snapshots.Usage, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, err := h.private.Stat(ctx, key); errdefs.IsNotFound(err) {
		return h.shared.Usage(ctx, key)
	} else if err != nil {
		return snapshots.Usage{}, err
	}
	return h.private.Usage(ctx, key)
}
func (h *Hybrid) Remove(ctx context.Context, key string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, err := h.private.Stat(ctx, key); err == nil {
		return h.private.Remove(ctx, key)
	} else if !errdefs.IsNotFound(err) {
		return err
	}
	if err := walkPrivate(h.private, ctx, func(_ context.Context, i snapshots.Info) error {
		if i.Labels[sharedParentLabel] == key {
			return fmt.Errorf("shared snapshot has private children: %w", errdefs.ErrFailedPrecondition)
		}
		return nil
	}); err != nil {
		return err
	}
	return h.shared.Remove(ctx, key)
}
func (h *Hybrid) Walk(ctx context.Context, fn snapshots.WalkFunc, fs ...string) error {
	h.mu.Lock()
	var items []snapshots.Info
	err := h.shared.Walk(ctx, func(_ context.Context, i snapshots.Info) error { items = append(items, i); return nil })
	if err == nil {
		err = walkPrivate(h.private, ctx, func(_ context.Context, i snapshots.Info) error {
			items = append(items, logicalInfo(i))
			return nil
		})
	}
	h.mu.Unlock()
	if err != nil {
		return err
	}
	f, err := filters.ParseAll(fs...)
	if err != nil {
		return err
	}
	for _, i := range items {
		if f.Match(snapshotFilter(i)) {
			if err := fn(ctx, i); err != nil {
				return err
			}
		}
	}
	return nil
}
func snapshotFilter(i snapshots.Info) filters.Adaptor {
	return filters.AdapterFunc(func(p []string) (string, bool) {
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
}
func (h *Hybrid) Cleanup(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	err := h.private.(snapshots.Cleaner).Cleanup(ctx)
	if errdefs.IsNotFound(err) {
		return nil
	}
	return err
}
func (h *Hybrid) Close() error { return h.private.Close() }

// Initialization is a persisted pending operation: after a crash, replay it
// before serving requests. Once published, Mounts must not reset permissions a
// container has changed in its upper directory.
func (h *Hybrid) initialize(ctx context.Context, key string) error {
	raw, err := h.private.Stat(ctx, key)
	if err != nil {
		return err
	}
	var layers []string
	if err := json.Unmarshal([]byte(raw.Labels[sharedLayersLabel]), &layers); err != nil {
		return err
	}
	parent, err := os.Stat(layers[0])
	if err != nil {
		return err
	}
	st := parent.Sys().(*syscall.Stat_t)
	if err := os.Lchown(raw.Labels[upperLabel], int(st.Uid), int(st.Gid)); err != nil {
		return err
	}
	if err := os.Chmod(raw.Labels[upperLabel], parent.Mode()); err != nil {
		return err
	}
	delete(raw.Labels, initializeLabel)
	_, err = h.private.Update(ctx, raw, "labels."+initializeLabel)
	return err
}

// Upstream reports NotFound for its uninitialized metadata bucket before the
// first snapshot is created. Walk in that state means an empty collection.
func walkPrivate(p snapshots.Snapshotter, ctx context.Context, fn snapshots.WalkFunc) error {
	var callbackError error
	err := p.Walk(ctx, func(ctx context.Context, i snapshots.Info) error { callbackError = fn(ctx, i); return callbackError })
	if callbackError != nil {
		return callbackError
	}
	if errdefs.IsNotFound(err) {
		return nil
	}
	return err
}

// Warm acquisition calls back into containerd, so release the graph mutex
// before that work. A private image ancestor is never eligible for adoption
// from the installation, even when its content chain happens to match.
func (h *Hybrid) privateImageRequest(ctx context.Context, key, parent string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.privateImageRequestLocked(ctx, key, parent)
}

func (h *Hybrid) privateImageRequestLocked(ctx context.Context, key, parent string) (bool, error) {
	if _, err := h.private.Stat(ctx, key); err == nil {
		return false, errdefs.ErrAlreadyExists
	} else if !errdefs.IsNotFound(err) {
		return false, err
	}
	if parent == "" {
		return false, nil
	}
	if _, err := h.private.Stat(ctx, parent); err == nil {
		return true, nil
	} else if errdefs.IsNotFound(err) {
		return false, nil
	} else {
		return false, err
	}
}
