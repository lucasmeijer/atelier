package main

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"time"

	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

type blobOwnership struct {
	Clients     map[string]bool `json:"clients"`
	UnusedSince time.Time       `json:"unusedSince"`
}

type contentOwnership struct {
	Blobs     map[digest.Digest]blobOwnership `json:"blobs"`
	Retired   map[string]bool                 `json:"retired"`
	GCFailure *GCFailure                      `json:"gcFailure,omitempty"`
}

// Before the first GC-capable startup, private metadata may already reference any
// existing blob. Pin those blobs to every surviving client, including parked
// clients. This one-time initialization is durable before listeners or GC start.
func (b *blobStore) openOwnership(legacyClients []string) error {
	b.ownershipPath = filepath.Join(filepath.Dir(b.path), "ownership.json")
	b.gcRequests = make(chan struct{}, 1)
	data, err := os.ReadFile(b.ownershipPath)
	if err == nil {
		return json.Unmarshal(data, &b.ownership)
	}
	if !os.IsNotExist(err) {
		return err
	}
	state := contentOwnership{Blobs: map[digest.Digest]blobOwnership{}, Retired: map[string]bool{}}
	now := time.Now().UTC()
	err = b.Store.Walk(context.Background(), func(info content.Info) error {
		record := blobOwnership{Clients: map[string]bool{}, UnusedSince: now}
		for _, id := range legacyClients {
			record.Clients[id] = true
		}
		if len(record.Clients) > 0 {
			record.UnusedSince = time.Time{}
		}
		state.Blobs[info.Digest] = record
		return nil
	})
	if err != nil {
		return err
	}
	return b.saveOwnership(state)
}

// Publish memory only after durable storage succeeds. In particular a failed pin
// must not let a subsequent acquisition return success with only an in-memory pin.
// Caller holds b's lock (or is opening the store before serving).
func (b *blobStore) saveOwnership(next contentOwnership) error {
	if err := durableJSON(b.ownershipPath, next); err != nil {
		return err
	}
	b.ownership = next
	return nil
}

func (c *clientContent) id() string { return c.prefix[:len(c.prefix)-1] }

// Caller holds b's lock across existence check, durable pin and acquisition.
func (c *clientContent) pin(d digest.Digest) error {
	b := c.blobStore
	if b.ownership.Retired[c.id()] {
		return errdefs.ErrFailedPrecondition
	}
	record := b.ownership.Blobs[d]
	if record.Clients[c.id()] {
		return nil
	}
	next := b.ownership
	next.Blobs = maps.Clone(next.Blobs)
	owners := map[string]bool{c.id(): true}
	maps.Copy(owners, record.Clients)
	next.Blobs[d] = blobOwnership{Clients: owners}
	return b.saveOwnership(next)
}

func (b *blobStore) releaseClient(id string) error {
	next := b.ownership
	next.Blobs = maps.Clone(next.Blobs)
	next.Retired = maps.Clone(next.Retired)
	next.Retired[id] = true
	now := time.Now().UTC()
	for d, record := range next.Blobs {
		if !record.Clients[id] {
			continue
		}
		record.Clients = maps.Clone(record.Clients)
		delete(record.Clients, id)
		if len(record.Clients) == 0 {
			record.UnusedSince = now
		}
		next.Blobs[d] = record
	}
	if err := b.saveOwnership(next); err != nil {
		return err
	}
	b.requestContentGC()
	return nil
}

func (c *clientContent) Info(ctx context.Context, d digest.Digest) (content.Info, error) {
	c.Lock()
	defer c.Unlock()
	info, err := c.Store.Info(ctx, d)
	if err != nil {
		return info, err
	}
	return info, c.pin(d)
}

func (c *clientContent) Update(ctx context.Context, info content.Info, fields ...string) (content.Info, error) {
	c.Lock()
	defer c.Unlock()
	if _, err := c.Store.Info(ctx, info.Digest); err != nil {
		return content.Info{}, err
	}
	if err := c.pin(info.Digest); err != nil {
		return content.Info{}, err
	}
	return c.Store.Update(ctx, info, fields...)
}

func (c *clientContent) ReaderAt(ctx context.Context, desc ocispec.Descriptor) (content.ReaderAt, error) {
	c.Lock()
	defer c.Unlock()
	if _, err := c.Store.Info(ctx, desc.Digest); err != nil {
		return nil, err
	}
	if err := c.pin(desc.Digest); err != nil {
		return nil, err
	}
	return c.Store.ReaderAt(ctx, desc)
}

func (c *clientContent) Walk(ctx context.Context, fn content.WalkFunc, filters ...string) error {
	// Enumeration is not acquisition: containerd's private metadata GC walks ALL
	// backing blobs looking for deletions. Pinning here would retain every other
	// client's content. Snapshot the listing under the GC lock, then invoke
	// callbacks outside it so actual acquisition through Info/ReaderAt can pin.
	var infos []content.Info
	err := func() error {
		c.Lock()
		defer c.Unlock()
		return c.Store.Walk(ctx, func(info content.Info) error {
			infos = append(infos, info)
			return nil
		}, filters...)
	}()
	if err != nil {
		return err
	}
	for _, info := range infos {
		if err := fn(info); err != nil {
			return err
		}
	}
	return nil
}

func (w *clientWriter) Commit(ctx context.Context, size int64, expected digest.Digest, opts ...content.Opt) error {
	c := w.client
	c.Lock()
	defer c.Unlock()
	// Digest() also covers writers opened without an expected descriptor, as well
	// as resumed uploads. Persist BEFORE commit can make the blob visible on disk.
	if err := c.pin(w.Writer.Digest()); err != nil {
		return err
	}
	err := w.Writer.Commit(ctx, size, expected, opts...)
	c.requestContentGC()
	return err
}
