package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/containerd/v2/core/images"
	"github.com/containerd/errdefs"
	"github.com/containerd/platforms"
	"github.com/distribution/reference"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

func exportImage(ctx context.Context, client *containerd.Client, image, platform string, out io.Writer) error {
	parsed, err := reference.ParseNormalizedNamed(image)
	if err != nil {
		return err
	}
	// Resolve by tag even when the caller pins it, then check the requested digest.
	name := reference.TagNameOnly(reference.TrimNamed(parsed)).String()
	if tagged, ok := parsed.(reference.Tagged); ok {
		name = reference.TrimNamed(parsed).String() + ":" + tagged.Tag()
	}
	lookup := reference.TagNameOnly(parsed).String()
	im, err := client.ImageService().Get(ctx, lookup)
	if errdefs.IsNotFound(err) && lookup != name {
		im, err = client.ImageService().Get(ctx, name)
	}
	if err != nil {
		return err
	}
	if pinned, ok := parsed.(reference.Digested); ok && pinned.Digest() != im.Target.Digest {
		return fmt.Errorf("image %s points to %s, not requested %s", name, im.Target.Digest, pinned.Digest())
	}
	p, err := platforms.Parse(platform)
	if err != nil {
		return err
	}
	match := platforms.OnlyStrict(p)
	target := im.Target
	cs := client.ContentStore()
	for depth := 0; ; depth++ {
		if depth > 8 {
			return fmt.Errorf("image index nesting exceeds eight levels")
		}
		if images.IsManifestType(target.MediaType) {
			break
		}
		if !images.IsIndexType(target.MediaType) {
			return fmt.Errorf("unsupported image target %s", target.MediaType)
		}
		data, err := content.ReadBlob(ctx, cs, target)
		if err != nil {
			return err
		}
		var index ocispec.Index
		if err := json.Unmarshal(data, &index); err != nil {
			return err
		}
		var matches []ocispec.Descriptor
		for _, d := range index.Manifests {
			if d.Platform != nil && match.Match(*d.Platform) {
				matches = append(matches, d)
			}
		}
		if len(matches) != 1 {
			return fmt.Errorf("expected exactly one manifest for %s, found %d", platform, len(matches))
		}
		target = matches[0]
	}
	mb, err := content.ReadBlob(ctx, cs, target)
	if err != nil {
		return err
	}
	var manifest ocispec.Manifest
	if err := json.Unmarshal(mb, &manifest); err != nil {
		return err
	}
	cb, err := content.ReadBlob(ctx, cs, manifest.Config)
	if err != nil {
		return err
	}
	var config ocispec.Image
	if err := json.Unmarshal(cb, &config); err != nil {
		return err
	}
	if !match.Match(config.Platform) {
		return fmt.Errorf("image configuration platform %s does not match %s", platforms.Format(config.Platform), platform)
	}
	// Validate exactly the same transport contract before emitting any stdout.
	var archive bytes.Buffer
	if err := writeArchive(&archive, name, target, manifest.Config, map[string][]byte{blobPath(target): mb, blobPath(manifest.Config): cb}); err != nil {
		return err
	}
	if _, err := readArchive(bytes.NewReader(archive.Bytes())); err != nil {
		return err
	}
	_, err = io.Copy(out, &archive)
	return err
}
