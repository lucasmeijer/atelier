package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/containerd/v2/core/images"
	"github.com/containerd/containerd/v2/core/unpack"
	"github.com/containerd/errdefs"
	"github.com/containerd/platforms"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"golang.org/x/sync/semaphore"
)

func importImage(ctx context.Context, client *containerd.Client, archive *metadataArchive) (ref string, resultErr error) {
	if !platforms.OnlyStrict(platforms.DefaultSpec()).Match(archive.config.Platform) {
		return "", fmt.Errorf("image platform %s does not match this workspace %s", platforms.Format(archive.config.Platform), platforms.DefaultString())
	}
	ctx, release, err := client.WithLease(ctx)
	if err != nil {
		return "", err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		// Lease cleanup failure must be visible; expiry is not our cleanup strategy.
		resultErr = errors.Join(resultErr, release(cleanup))
	}()
	return importLeased(ctx, client, archive)
}

func importLeased(ctx context.Context, client *containerd.Client, archive *metadataArchive) (string, error) {
	cs := client.ContentStore()
	// The image record is only published after successful unpack. The lease keeps
	// new metadata and snapshots alive until then, including during cancellation.
	for _, d := range []ocispec.Descriptor{archive.manifest.Config, archive.target} {
		if err := content.WriteBlob(ctx, cs, "atelier-transfer-"+d.Digest.String(), bytes.NewReader(archive.blobs[blobPath(d)]), d); err != nil {
			return "", err
		}
	}
	caps, err := client.GetSnapshotterCapabilities(ctx, "erofs")
	if err != nil {
		return "", err
	}
	u, err := unpack.NewUnpacker(ctx, cs,
		unpack.WithUnpackPlatform(unpack.Platform{SnapshotterKey: "erofs", Snapshotter: client.SnapshotService("erofs"), SnapshotterCapabilities: caps, Applier: client.DiffService()}),
		unpack.WithUnpackLimiter(semaphore.NewWeighted(4)))
	if err != nil {
		return "", err
	}
	handler := images.Handlers(images.HandlerFunc(func(_ context.Context, d ocispec.Descriptor) ([]ocispec.Descriptor, error) {
		if images.IsLayerType(d.MediaType) {
			return nil, fmt.Errorf("EROFS cache miss for layer %s: prepare all layers on System before transferring (layer fetching is disabled)", d.Digest)
		}
		return nil, nil
	}), images.SetChildrenLabels(cs, images.ChildrenHandler(cs)))
	dispatchErr := images.Dispatch(ctx, u.Unpack(handler), nil, archive.target)
	_, waitErr := u.Wait()
	if dispatchErr != nil {
		return "", dispatchErr
	}
	if waitErr != nil {
		return "", waitErr
	}
	record := images.Image{Name: archive.name, Target: archive.target}
	if _, err := client.ImageService().Create(ctx, record); err != nil {
		if !errdefs.IsAlreadyExists(err) {
			return "", err
		}
		if _, err := client.ImageService().Update(ctx, record, "target"); err != nil {
			return "", err
		}
	}
	return pinnedReference(archive.name, archive.target), nil
}
