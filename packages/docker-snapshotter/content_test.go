package main

import (
	"bytes"
	"context"
	"testing"

	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

func TestContentRetentionAndPrivateIngests(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	b, err := openBlobs(root)
	if err != nil {
		t.Fatal(err)
	}
	a := &clientContent{blobStore: b, prefix: "A/"}
	c := &clientContent{blobStore: b, prefix: "B/"}
	payload := []byte("portable content")
	desc := ocispec.Descriptor{Digest: digest.FromBytes(payload), Size: int64(len(payload))}
	if err := content.WriteBlob(ctx, a, "image", bytes.NewReader(payload), desc); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Writer(ctx, content.WithRef("image"), content.WithDescriptor(desc)); !errdefs.IsAlreadyExists(err) {
		t.Fatalf("warm content was not reused: %v", err)
	}
	if err := a.Delete(ctx, desc.Digest); err != nil {
		t.Fatal(err)
	}
	got, err := content.ReadBlob(ctx, c, desc)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("GC damaged shared blob: %q %v", got, err)
	}
	// A client's abort/list/status cannot interfere with the same ref in B.
	for _, client := range []*clientContent{a, c} {
		w, err := client.Writer(ctx, content.WithRef("partial"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(client.prefix)); err != nil {
			t.Fatal(err)
		}
		status, err := w.Status()
		if err != nil || status.Ref != "partial" {
			t.Fatalf("writer ref: %+v %v", status, err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Status(ctx, "partial"); !errdefs.IsNotFound(err) {
		t.Fatalf("retired upload: %v", err)
	}
	statuses, err := c.ListStatuses(ctx, `ref==partial`)
	if err != nil || len(statuses) != 1 || statuses[0].Ref != "partial" {
		t.Fatalf("scoped statuses: %+v %v", statuses, err)
	}
	reopened, err := openBlobs(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err = content.ReadBlob(ctx, reopened, desc)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("restart lost blob: %q %v", got, err)
	}
	if err := reopened.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := (&clientContent{blobStore: reopened, prefix: "B/"}).Status(ctx, "partial"); err != nil {
		t.Fatal(err)
	}
}
