package main

import (
	"context"
	"log/slog"
	"reflect"

	api "github.com/containerd/containerd/api/services/diff/v1"
	"github.com/containerd/containerd/v2/core/diff"
	"github.com/containerd/containerd/v2/core/diff/apply"
	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/oci"
	"github.com/containerd/errdefs"
	"github.com/containerd/errdefs/pkg/errgrpc"
	digest "github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/identity"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// Content registration must happen before snapshot reuse. Returning an active
// snapshot from Prepare lets containerd acquire every blob (usually metadata-only
// from our shared content backend). Apply then skips extraction for a verified
// diff/parent chain; Commit atomically substitutes the retained backing.
type sharedDiff struct {
	api.UnimplementedDiffServer
	client *Client
	blobs  *blobStore
}

func (d *sharedDiff) Apply(ctx context.Context, req *api.ApplyRequest) (*api.ApplyResponse, error) {
	if req.Diff == nil {
		return nil, errgrpc.ToGRPC(errdefs.ErrInvalidArgument)
	}
	for _, m := range req.Mounts {
		if m == nil {
			return nil, errgrpc.ToGRPC(errdefs.ErrInvalidArgument)
		}
	}
	if len(req.Payloads) != 0 {
		return nil, errgrpc.ToGRPC(errdefs.ErrNotImplemented)
	}
	desc := oci.DescriptorFromProto(req.Diff)
	if err := desc.Digest.Validate(); err != nil {
		return nil, errgrpc.ToGRPC(errdefs.ErrInvalidArgument)
	}
	mounts := mount.FromProto(req.Mounts)
	applied, reused, err := d.cachedApply(ctx, desc, mounts)
	if err != nil {
		return nil, errgrpc.ToGRPC(err)
	}
	if !reused {
		// Extraction must not monopolize snapshot metadata RPCs for all clients.
		applied, err = apply.NewFileSystemApplier(d.blobs).Apply(ctx, desc, mounts, diff.WithSyncFs(req.SyncFs))
		if err != nil {
			return nil, errgrpc.ToGRPC(err)
		}
		d.blobs.Lock()
		d.blobs.applied[diffCacheKey(desc)] = applied
		err = durableJSON(d.blobs.path, d.blobs.applied)
		d.blobs.Unlock()
		if err != nil {
			return nil, errgrpc.ToGRPC(err)
		}
	}
	return &api.ApplyResponse{Applied: oci.DescriptorToProto(applied)}, nil
}
func diffCacheKey(desc ocispec.Descriptor) string { return desc.MediaType + "@" + desc.Digest.String() }

func (d *sharedDiff) cachedApply(ctx context.Context, desc ocispec.Descriptor, mounts []mount.Mount) (ocispec.Descriptor, bool, error) {
	s := d.client.s
	s.Lock()
	defer s.Unlock()
	if s.state.Retired[d.client.id] {
		return ocispec.Descriptor{}, false, errdefs.ErrFailedPrecondition
	}
	// Only operate on this client's known active snapshots. Other diff operations
	// (including Docker's own filesystem paths) belong to its local walking differ.
	var alias Alias
	found := false
	for _, a := range s.state.Clients[d.client.id] {
		if a.Info.Kind != snapshots.KindActive {
			continue
		}
		m, err := s.backend.Mounts(ctx, a.Backing)
		if err != nil {
			return ocispec.Descriptor{}, false, err
		}
		if reflect.DeepEqual(m, mounts) {
			alias = a
			found = true
			break
		}
	}
	if !found {
		return ocispec.Descriptor{}, false, errdefs.ErrNotImplemented
	}
	d.blobs.Lock()
	cacheKey := diffCacheKey(desc)
	applied, known := d.blobs.applied[cacheKey]
	d.blobs.Unlock()
	if !known {
		return ocispec.Descriptor{}, false, nil
	}
	parent := digest.Digest("")
	bp := ""
	if alias.Info.Parent != "" {
		p := s.state.Clients[d.client.id][alias.Info.Parent]
		parent = digest.Digest(p.Target)
		bp = p.Backing
	}
	chain := identity.ChainID([]digest.Digest{applied.Digest})
	if parent != "" {
		chain = identity.ChainID([]digest.Digest{parent, applied.Digest})
	}
	retained, exists := s.state.Chains[alias.Target]
	if exists && retained.Parent == bp && chain.String() == alias.Target {
		// Missing blobs must never yield successful reuse.
		if _, err := d.blobs.Info(ctx, desc.Digest); err != nil {
			return ocispec.Descriptor{}, false, err
		}
		slog.Info("reuse", "client", d.client.id, "snapshot.ref", alias.Target, "blob", desc.Digest)
		return applied, true, nil
	}
	return ocispec.Descriptor{}, false, nil
}
