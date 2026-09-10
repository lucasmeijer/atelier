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
	"github.com/containerd/errdefs/pkg/errgrpc"
	digest "github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/identity"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
)

const (
	warmService       = "atelier.snapshotter.v1.Warm"
	layerLabel        = "containerd.io/snapshot/cri.layer-digest"
	manifestLabel     = "containerd.io/snapshot/cri.manifest-digest"
	uncompressedLabel = "containerd.io/uncompressed"
)

// Our internal interface reuses containerd's protobuf request/descriptor types.
// Lookup is read-only; Adopt rechecks everything and persists only an alias.
// The local caller MUST register the returned descriptor before calling Adopt.
// Neither call changes ownership of shared backing or allocates a snapshot.
type warmServer interface {
	Lookup(context.Context, *api.PrepareSnapshotRequest) (*types.Descriptor, error)
	Adopt(context.Context, *api.PrepareSnapshotRequest) (*emptypb.Empty, error)
}

func registerWarm(g *grpc.Server, w warmServer) {
	g.RegisterService(&grpc.ServiceDesc{
		ServiceName: warmService, HandlerType: (*warmServer)(nil),
		Methods: []grpc.MethodDesc{
			{MethodName: "Lookup", Handler: warmHandler("Lookup", func(ctx context.Context, s warmServer, r *api.PrepareSnapshotRequest) (any, error) {
				return s.Lookup(ctx, r)
			})},
			{MethodName: "Adopt", Handler: warmHandler("Adopt", func(ctx context.Context, s warmServer, r *api.PrepareSnapshotRequest) (any, error) {
				return s.Adopt(ctx, r)
			})},
		},
	}, w)
}
func warmHandler(method string, call func(context.Context, warmServer, *api.PrepareSnapshotRequest) (any, error)) grpc.MethodHandler {
	return func(s any, ctx context.Context, dec func(any) error, interceptor grpc.UnaryServerInterceptor) (any, error) {
		r := new(api.PrepareSnapshotRequest)
		if err := dec(r); err != nil {
			return nil, err
		}
		h := func(ctx context.Context, r any) (any, error) {
			result, err := call(ctx, s.(warmServer), r.(*api.PrepareSnapshotRequest))
			return result, errgrpc.ToGRPC(err)
		}
		if interceptor == nil {
			return h(ctx, r)
		}
		return interceptor(ctx, r, &grpc.UnaryServerInfo{Server: s, FullMethod: "/" + warmService + "/" + method}, h)
	}
}

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
	target, layer, manifest := digest.Digest(r.Labels[refLabel]), digest.Digest(r.Labels[layerLabel]), digest.Digest(r.Labels[manifestLabel])
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
	data, err := content.ReadBlob(ctx, w.blobs, ocispec.Descriptor{Digest: manifest})
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
	info, err := w.blobs.Info(ctx, desc.Digest)
	if err != nil {
		return ocispec.Descriptor{}, Chain{}, err
	}
	if info.Size != desc.Size {
		return ocispec.Descriptor{}, Chain{}, errdefs.ErrFailedPrecondition
	}
	desc.Annotations = map[string]string{uncompressedLabel: applied.Digest.String()}
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
		if a.Backing == ch.Backing && a.Info.Kind == snapshots.KindCommitted && a.Target == r.Labels[refLabel] && a.Info.Parent == r.Parent {
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
	s.state.Clients[w.client.id][r.Key] = Alias{clone(i), ch.Backing, r.Labels[refLabel]}
	s.save()
	slog.Info("warm-adopt", "client", w.client.id, "key", r.Key, "snapshot.ref", r.Labels[refLabel], "blob", r.Labels[layerLabel], "backing", ch.Backing)
	return &emptypb.Empty{}, nil
}
