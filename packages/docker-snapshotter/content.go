package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/containerd/v2/pkg/filters"
	"github.com/containerd/containerd/v2/plugins/content/local"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// Docker keeps its metadata/GC database private. The underlying immutable blobs
// are installation-owned, like retained snapshot chains: one client's GC must
// never remove another client's content. No cache eviction policy exists yet.
type clientContent struct {
	content.Store
	prefix string
}

func (c *clientContent) Delete(context.Context, digest.Digest) error { return nil }
func (c *clientContent) Writer(ctx context.Context, opts ...content.WriterOpt) (content.Writer, error) {
	var o content.WriterOpts
	for _, opt := range opts {
		if err := opt(&o); err != nil {
			return nil, err
		}
	}
	if o.Ref == "" {
		return nil, errdefs.ErrInvalidArgument
	}
	w, err := c.Store.Writer(ctx, content.WithRef(c.prefix+o.Ref), content.WithDescriptor(o.Desc))
	if err != nil {
		return nil, err
	}
	return &clientWriter{Writer: w, ref: o.Ref}, nil
}
func (c *clientContent) Status(ctx context.Context, ref string) (content.Status, error) {
	s, err := c.Store.Status(ctx, c.prefix+ref)
	s.Ref = strings.TrimPrefix(s.Ref, c.prefix)
	return s, err
}
func (c *clientContent) Abort(ctx context.Context, ref string) error {
	return c.Store.Abort(ctx, c.prefix+ref)
}
func (c *clientContent) ListStatuses(ctx context.Context, filters ...string) ([]content.Status, error) {
	// Filter after removing the client prefix, so ref filters retain their meaning.
	statuses, err := c.Store.ListStatuses(ctx)
	if err != nil {
		return nil, err
	}
	return scopedStatuses(statuses, c.prefix, filters)
}

type blobStore struct {
	content.Store
	sync.Mutex
	path    string
	applied map[string]ocispec.Descriptor
}

func openBlobs(root string) (*blobStore, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	cs, err := local.NewStore(root)
	if err != nil {
		return nil, err
	}
	b := &blobStore{Store: cs, path: filepath.Join(root, "applied.json"), applied: map[string]ocispec.Descriptor{}}
	data, err := os.ReadFile(b.path)
	if err == nil {
		err = json.Unmarshal(data, &b.applied)
	} else if os.IsNotExist(err) {
		err = nil
	}
	return b, err
}

type clientWriter struct {
	content.Writer
	ref string
}

func (w *clientWriter) Status() (content.Status, error) {
	s, err := w.Writer.Status()
	s.Ref = w.ref
	return s, err
}
func scopedStatuses(statuses []content.Status, prefix string, fs []string) ([]content.Status, error) {
	f, err := filters.ParseAll(fs...)
	if err != nil {
		return nil, err
	}
	result := []content.Status{}
	for _, s := range statuses {
		if !strings.HasPrefix(s.Ref, prefix) {
			continue
		}
		s.Ref = strings.TrimPrefix(s.Ref, prefix)
		if f.Match(filters.AdapterFunc(func(path []string) (string, bool) {
			if len(path) == 1 && path[0] == "ref" {
				return s.Ref, true
			}
			return "", false
		})) {
			result = append(result, s)
		}
	}
	return result, nil
}

// Stop the client's gRPC server before this call so no new writes can race
// retirement. Repeat on startup for tombstones left by interrupted retirement.
func (b *blobStore) retire(ctx context.Context, id string) error {
	c := &clientContent{Store: b.Store, prefix: id + "/"}
	statuses, err := c.ListStatuses(ctx)
	if err != nil {
		return err
	}
	for _, status := range statuses {
		if err := c.Abort(ctx, status.Ref); err != nil {
			return err
		}
	}
	return nil
}
