package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	types "github.com/containerd/containerd/api/types"
	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/oci"
	"github.com/containerd/errdefs"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/protocol"
	digest "github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/identity"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"google.golang.org/protobuf/types/known/emptypb"
)

type sharedWarm struct {
	client *Client
	blobs  *blobStore
}

// Caller holds Store's lock. NotFound means an optimization miss, not permission
// to adopt an unverified chain. The exact requested compressed representation must
// already have been applied successfully over this ancestry.
func (w *sharedWarm) candidate(ctx context.Context, r *api.PrepareSnapshotRequest) (ocispec.Descriptor, Chain, error) {
	miss := func() (ocispec.Descriptor, Chain, error) { return ocispec.Descriptor{}, Chain{}, errdefs.ErrNotFound }
	s := w.client.s
	if s.state.Retired[w.client.id] {
		return ocispec.Descriptor{}, Chain{}, errdefs.ErrFailedPrecondition
	}
	target, layer, manifest := digest.Digest(r.Labels[protocol.RefLabel]), digest.Digest(r.Labels[protocol.LayerLabel]), digest.Digest(r.Labels[protocol.ManifestLabel])
	if target == "" || layer == "" || manifest == "" {
		return miss()
	}
	for _, d := range []digest.Digest{target, layer, manifest} {
		if d.Validate() != nil {
			return ocispec.Descriptor{}, Chain{}, errdefs.ErrInvalidArgument
		}
	}
	ch, ok := s.state.Chains[target.String()]
	if !ok {
		return miss()
	}
	bp, parent := "", digest.Digest("")
	if r.Parent != "" {
		a, err := w.client.lookup(r.Parent)
		if err != nil {
			return ocispec.Descriptor{}, Chain{}, err
		}
		if a.Info.Kind != snapshots.KindCommitted {
			return ocispec.Descriptor{}, Chain{}, errdefs.ErrInvalidArgument
		}
		bp, parent = a.Backing, digest.Digest(a.Target)
	}
	if ch.Parent != bp {
		return miss()
	}
	data, err := content.ReadBlob(ctx, &clientContent{blobStore: w.blobs, prefix: w.client.id + "/"}, ocispec.Descriptor{Digest: manifest})
	if err != nil {
		return ocispec.Descriptor{}, Chain{}, err
	}
	var m ocispec.Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return ocispec.Descriptor{}, Chain{}, fmt.Errorf("requested manifest: %w", err)
	}
	var desc ocispec.Descriptor
	for _, d := range m.Layers {
		if d.Digest == layer {
			desc = d
			break
		}
	}
	if desc.Digest == "" {
		return ocispec.Descriptor{}, Chain{}, errdefs.ErrInvalidArgument
	}
	w.blobs.Lock()
	applied, known := w.blobs.applied[diffCacheKey(desc)]
	w.blobs.Unlock()
	if !known {
		return miss()
	}
	chain := applied.Digest
	if parent != "" {
		chain = identity.ChainID([]digest.Digest{parent, applied.Digest})
	}
	if chain != target {
		return miss()
	}
	info, err := (&clientContent{blobStore: w.blobs, prefix: w.client.id + "/"}).Info(ctx, desc.Digest)
	if err != nil {
		return ocispec.Descriptor{}, Chain{}, err
	}
	if info.Size != desc.Size {
		return ocispec.Descriptor{}, Chain{}, errdefs.ErrFailedPrecondition
	}
	desc.Annotations = map[string]string{protocol.UncompressedLabel: applied.Digest.String()}
	return desc, ch, nil
}
func (w *sharedWarm) Lookup(ctx context.Context, r *api.PrepareSnapshotRequest) (*types.Descriptor, error) {
	w.client.s.Lock()
	defer w.client.s.Unlock()
	desc, _, err := w.candidate(ctx, r)
	if err != nil {
		return nil, err
	}
	return oci.DescriptorToProto(desc), nil
}
func (w *sharedWarm) Adopt(ctx context.Context, r *api.PrepareSnapshotRequest) (*emptypb.Empty, error) {
	s := w.client.s
	s.Lock()
	defer s.Unlock()
	_, ch, err := w.candidate(ctx, r)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if a, ok := s.state.Clients[w.client.id][r.Key]; ok {
		if a.Backing == ch.Backing && a.Info.Kind == snapshots.KindCommitted && a.Target == r.Labels[protocol.RefLabel] && a.Info.Parent == r.Parent {
			return &emptypb.Empty{}, nil
		}
		return nil, errdefs.ErrAlreadyExists
	}
	bi, err := s.backend.Stat(ctx, ch.Backing)
	if err != nil {
		return nil, err
	}
	i := snapshots.Info{Name: r.Key, Parent: r.Parent, Kind: snapshots.KindCommitted, Created: bi.Created, Updated: bi.Updated, Labels: r.Labels}
	// Atomic alias publication has no physical side effects requiring an intent.
	s.state.Clients[w.client.id][r.Key] = Alias{clone(i), ch.Backing, r.Labels[protocol.RefLabel]}
	s.save()
	slog.Info("warm-adopt", "client", w.client.id, "key", r.Key, "snapshot.ref", r.Labels[protocol.RefLabel], "blob", r.Labels[protocol.LayerLabel], "backing", ch.Backing)
	return &emptypb.Empty{}, nil
}
