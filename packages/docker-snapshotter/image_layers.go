package main

import (
	"context"
	"fmt"
	"path/filepath"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	types "github.com/containerd/containerd/api/types"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/errdefs"
	"github.com/containerd/errdefs/pkg/errgrpc"
	"google.golang.org/grpc"
)

const imageLayersService = "atelier.snapshotter.v1.ImageLayers"
const overlayUpperdirLabel = "containerd.io/snapshot/overlay.upperdir"

// Resolve returns immutable changeset directories in OverlayFS lowerdir order.
// These describe backing, not mounts to execute. In particular, resolving an
// image must never allocate a View or a disposable writable snapshot centrally.
// Backing can be cached after its client's alias is removed, but GC may evict it.
// Hybrid private descendants must retain their shared parent alias for its full
// lifetime; their resolved lower directories are protected through that alias.
type imageLayersServer interface {
	Resolve(context.Context, *api.MountsRequest) (*api.MountsResponse, error)
}

type sharedImageLayers struct{ client *Client }

func (s *sharedImageLayers) Resolve(ctx context.Context, req *api.MountsRequest) (*api.MountsResponse, error) {
	c := s.client
	c.s.Lock()
	defer c.s.Unlock()
	a, err := c.lookup(req.Key)
	if err != nil {
		return nil, err
	}
	if !retained(a) {
		return nil, fmt.Errorf("snapshot %q is not shared image backing: %w", req.Key, errdefs.ErrFailedPrecondition)
	}
	chain, ok := c.s.state.Chains[a.Target]
	if !ok || chain.Backing != a.Backing {
		return nil, fmt.Errorf("snapshot %q has no retained image chain: %w", req.Key, errdefs.ErrFailedPrecondition)
	}
	result := &api.MountsResponse{}
	for backing := a.Backing; backing != ""; {
		info, err := c.s.backend.Stat(ctx, backing)
		if err != nil {
			return nil, err
		}
		if info.Kind != snapshots.KindCommitted {
			return nil, fmt.Errorf("image ancestor %q is not committed: %w", backing, errdefs.ErrFailedPrecondition)
		}
		path := info.Labels[overlayUpperdirLabel]
		if !filepath.IsAbs(path) {
			return nil, fmt.Errorf("image backing %q has no absolute OverlayFS directory: %w", backing, errdefs.ErrFailedPrecondition)
		}
		result.Mounts = append(result.Mounts, &types.Mount{Type: "bind", Source: path, Options: []string{"ro", "rbind"}})
		backing = info.Parent
	}
	return result, nil
}

func registerImageLayers(server *grpc.Server, client *Client) {
	server.RegisterService(&grpc.ServiceDesc{
		ServiceName: imageLayersService,
		HandlerType: (*imageLayersServer)(nil),
		Methods: []grpc.MethodDesc{{MethodName: "Resolve", Handler: func(s any, ctx context.Context, dec func(any) error, interceptor grpc.UnaryServerInterceptor) (any, error) {
			req := new(api.MountsRequest)
			if err := dec(req); err != nil {
				return nil, err
			}
			handler := func(ctx context.Context, request any) (any, error) {
				result, err := s.(imageLayersServer).Resolve(ctx, request.(*api.MountsRequest))
				return result, errgrpc.ToGRPC(err)
			}
			if interceptor == nil {
				return handler(ctx, req)
			}
			return interceptor(ctx, req, &grpc.UnaryServerInfo{Server: s, FullMethod: "/" + imageLayersService + "/Resolve"}, handler)
		}}},
	}, &sharedImageLayers{client})
}

func resolveSharedLayers(ctx context.Context, conn grpc.ClientConnInterface, key string) ([]string, error) {
	var result api.MountsResponse
	if err := conn.Invoke(ctx, "/"+imageLayersService+"/Resolve", &api.MountsRequest{Key: key}, &result); err != nil {
		return nil, errgrpc.ToNative(err)
	}
	if len(result.Mounts) == 0 {
		return nil, fmt.Errorf("shared image %q has no backing: %w", key, errdefs.ErrFailedPrecondition)
	}
	layers := make([]string, 0, len(result.Mounts))
	for _, entry := range result.Mounts {
		if entry == nil || entry.Type != "bind" || !filepath.IsAbs(entry.Source) || len(entry.Options) != 2 || entry.Options[0] != "ro" || entry.Options[1] != "rbind" {
			return nil, fmt.Errorf("shared image %q returned invalid backing: %w", key, errdefs.ErrFailedPrecondition)
		}
		layers = append(layers, entry.Source)
	}
	return layers, nil
}
