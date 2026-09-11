package protocol

import (
	"context"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	types "github.com/containerd/containerd/api/types"
	"github.com/containerd/errdefs/pkg/errgrpc"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
)

const (
	RefLabel          = "containerd.io/snapshot.ref"
	WarmService       = "atelier.snapshotter.v1.Warm"
	LayerLabel        = "containerd.io/snapshot/cri.layer-digest"
	ManifestLabel     = "containerd.io/snapshot/cri.manifest-digest"
	UncompressedLabel = "containerd.io/uncompressed"
)

// Our internal interface reuses containerd's protobuf request/descriptor types.
// Lookup pins content; Adopt rechecks everything and persists an image alias.
// The local caller MUST register the returned descriptor before calling Adopt.
// Neither call changes ownership of shared backing or allocates a snapshot.
type WarmServer interface {
	Lookup(context.Context, *api.PrepareSnapshotRequest) (*types.Descriptor, error)
	Adopt(context.Context, *api.PrepareSnapshotRequest) (*emptypb.Empty, error)
}

func RegisterWarm(g *grpc.Server, w WarmServer) {
	g.RegisterService(&grpc.ServiceDesc{
		ServiceName: WarmService, HandlerType: (*WarmServer)(nil),
		Methods: []grpc.MethodDesc{
			{MethodName: "Lookup", Handler: warmHandler("Lookup", func(ctx context.Context, s WarmServer, r *api.PrepareSnapshotRequest) (any, error) {
				return s.Lookup(ctx, r)
			})},
			{MethodName: "Adopt", Handler: warmHandler("Adopt", func(ctx context.Context, s WarmServer, r *api.PrepareSnapshotRequest) (any, error) {
				return s.Adopt(ctx, r)
			})},
		},
	}, w)
}
func warmHandler(method string, call func(context.Context, WarmServer, *api.PrepareSnapshotRequest) (any, error)) grpc.MethodHandler {
	return func(s any, ctx context.Context, dec func(any) error, interceptor grpc.UnaryServerInterceptor) (any, error) {
		r := new(api.PrepareSnapshotRequest)
		if err := dec(r); err != nil {
			return nil, err
		}
		h := func(ctx context.Context, r any) (any, error) {
			result, err := call(ctx, s.(WarmServer), r.(*api.PrepareSnapshotRequest))
			return result, errgrpc.ToGRPC(err)
		}
		if interceptor == nil {
			return h(ctx, r)
		}
		return interceptor(ctx, r, &grpc.UnaryServerInfo{Server: s, FullMethod: "/" + WarmService + "/" + method}, h)
	}
}
