package main

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"

	api "github.com/containerd/containerd/api/services/diff/v1"
	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/containerd/v2/core/mount"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/pkg/oci"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/identity"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestApplyReuseRequiresContentAndMatchingChain(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	backend, err := overlay.NewSnapshotter(filepath.Join(root, "overlay"))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	s := &Store{backend: backend, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}, "B": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	a, b := &Client{s, "A"}, &Client{s, "B"}
	blobs, err := openBlobs(filepath.Join(root, "content"))
	if err != nil {
		t.Fatal(err)
	}
	// An intentionally non-tar blob proves a cache hit never attempts extraction.
	payload := []byte("compressed layer fixture")
	desc := ocispec.Descriptor{MediaType: ocispec.MediaTypeImageLayerGzip, Digest: digest.FromBytes(payload), Size: int64(len(payload))}
	applied := ocispec.Descriptor{MediaType: ocispec.MediaTypeImageLayer, Digest: digest.FromString("verified uncompressed layer"), Size: 1024}
	if err := content.WriteBlob(ctx, blobs, "fixture", bytes.NewReader(payload), desc); err != nil {
		t.Fatal(err)
	}
	blobs.applied[diffCacheKey(desc)] = applied
	if err := durableJSON(blobs.path, blobs.applied); err != nil {
		t.Fatal(err)
	}
	blobs, err = openBlobs(filepath.Join(root, "content"))
	if err != nil {
		t.Fatal(err)
	}
	parent := digest.FromString("parent")
	target := identity.ChainID([]digest.Digest{parent, applied.Digest})
	prepare := func(c *Client, key, parent string, target digest.Digest) []mount.Mount {
		t.Helper()
		m, err := c.Prepare(ctx, key, parent, snapshots.WithLabels(map[string]string{refLabel: target.String()}))
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	commit := func(c *Client, name, key string) {
		t.Helper()
		if err := c.Commit(ctx, name, key); err != nil {
			t.Fatal(err)
		}
	}
	prepare(a, "base-extract", "", parent)
	commit(a, "base", "base-extract")
	prepare(a, "extract", "base", target)
	commit(a, "image", "extract")
	prepare(b, "base-extract", "", parent)
	commit(b, "base", "base-extract")
	mounts := prepare(b, "extract", "base", target)
	d := &sharedDiff{client: b, blobs: blobs}
	response, err := d.Apply(ctx, &api.ApplyRequest{Diff: oci.DescriptorToProto(desc), Mounts: mount.ToProto(mounts)})
	if err != nil || response.Applied.Digest != applied.Digest.String() || response.Applied.Size != applied.Size {
		t.Fatalf("reuse failed: %+v %v", response, err)
	}
	wrongMedia := desc
	wrongMedia.MediaType = ocispec.MediaTypeImageLayer
	if _, reused, err := d.cachedApply(ctx, wrongMedia, mounts); err != nil || reused {
		t.Fatalf("wrong media reused: %v %v", reused, err)
	}
	wrongMounts := []mount.Mount{{Type: "bind", Source: "/unowned"}}
	if _, _, err := d.cachedApply(ctx, desc, wrongMounts); !errdefs.IsNotImplemented(err) {
		t.Fatalf("unknown mount should use local differ: %v", err)
	}
	wrong := prepare(b, "wrong", "", target)
	if _, reused, err := d.cachedApply(ctx, desc, wrong); err != nil || reused {
		t.Fatalf("wrong parent reused: %v %v", reused, err)
	}
	if err := blobs.Delete(ctx, desc.Digest); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.cachedApply(ctx, desc, mounts); !errdefs.IsNotFound(err) {
		t.Fatalf("missing export blob accepted: %v", err)
	}
	commit(b, "image", "extract")
	if s.state.Clients["A"]["image"].Backing != s.state.Clients["B"]["image"].Backing {
		t.Fatal("commit did not reuse retained backing")
	}
}

func TestApplyRejectsMissingOrInvalidDescriptor(t *testing.T) {
	d := &sharedDiff{}
	for _, request := range []*api.ApplyRequest{{}, {Diff: oci.DescriptorToProto(ocispec.Descriptor{Digest: "not-a-digest"})}} {
		if _, err := d.Apply(context.Background(), request); status.Code(err) != codes.InvalidArgument {
			t.Fatalf("invalid descriptor accepted: %v", err)
		}
	}
}
