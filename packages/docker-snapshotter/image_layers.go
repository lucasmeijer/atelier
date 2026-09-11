package main

import (
	"context"
	"fmt"
	"path/filepath"

	api "github.com/containerd/containerd/api/services/snapshots/v1"
	types "github.com/containerd/containerd/api/types"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/errdefs"
)

const overlayUpperdirLabel = "containerd.io/snapshot/overlay.upperdir"

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
