package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
)

const compressedContentTargetBytes int64 = 10_000_000_000
const unownedContentRetention = 7 * 24 * time.Hour

type ContentStorageStats struct {
	PinnedBytes      int64      `json:"pinnedBytes"`
	ReclaimableBytes int64      `json:"reclaimableBytes"`
	IngestBytes      int64      `json:"ingestBytes"`
	TotalBytes       int64      `json:"totalBytes"`
	TargetBytes      int64      `json:"targetBytes"`
	RetentionDays    int        `json:"retentionDays"`
	MeasuredAt       time.Time  `json:"measuredAt"`
	GCFailure        *GCFailure `json:"gcFailure,omitempty"`
}

type ContentGCResult struct {
	ContentStorageStats
	ReclaimedBytes int64 `json:"reclaimedBytes"`
}

// Content payload bytes, counted once per digest, plus unfinished upload bytes.
// This excludes filesystem overhead, ownership/applied metadata and other stores.
// The caller holds b's lock; uploads can continue writing while we measure them.
func (b *blobStore) measureContent(ctx context.Context) (ContentStorageStats, []content.Info, error) {
	stats := ContentStorageStats{TargetBytes: compressedContentTargetBytes, RetentionDays: int(unownedContentRetention / (24 * time.Hour)), GCFailure: b.ownership.GCFailure}
	var unused []content.Info
	err := b.Store.Walk(ctx, func(info content.Info) error {
		record, exists := b.ownership.Blobs[info.Digest]
		if !exists {
			return fmt.Errorf("blob %s has no ownership record", info.Digest)
		}
		if len(record.Clients) > 0 {
			stats.PinnedBytes += info.Size
		} else {
			stats.ReclaimableBytes += info.Size
			unused = append(unused, info)
		}
		return nil
	})
	if err != nil {
		return stats, nil, err
	}
	statuses, err := b.Store.ListStatuses(ctx)
	if err != nil {
		return stats, nil, err
	}
	for _, status := range statuses {
		stats.IngestBytes += status.Offset
	}
	stats.TotalBytes = stats.PinnedBytes + stats.ReclaimableBytes + stats.IngestBytes
	stats.MeasuredAt = time.Now().UTC()
	return stats, unused, nil
}

func (b *blobStore) contentStorageStats(ctx context.Context) (ContentStorageStats, error) {
	b.Lock()
	defer b.Unlock()
	stats, _, err := b.measureContent(ctx)
	return stats, err
}

func (b *blobStore) collectContent(ctx context.Context) (ContentGCResult, error) {
	return b.collectContentTo(ctx, compressedContentTargetBytes, time.Now().UTC())
}

// Age expires only UNOWNED content. If still above the soft target, reclaim
// younger unowned blobs oldest-first. Pins and uploads are never age-evicted.
// Acquisition, commit and eviction share this lock. A failed physical deletion
// leaves its record intact, is reported durably and is retried next collection.
func (b *blobStore) collectContentTo(ctx context.Context, target int64, now time.Time) (result ContentGCResult, err error) {
	b.Lock()
	defer b.Unlock()
	defer func() {
		next := b.ownership
		if err != nil {
			next.GCFailure = &GCFailure{Message: err.Error(), At: time.Now().UTC()}
			slog.Error("content-gc", "error", err)
		} else {
			next.GCFailure = nil
		}
		if saveErr := b.saveOwnership(next); saveErr != nil {
			err = fmt.Errorf("content GC: %v; persist result: %w", err, saveErr)
			// Also surface persistence failures in live measurements if disk is full.
			b.ownership.GCFailure = &GCFailure{Message: err.Error(), At: time.Now().UTC()}
			slog.Error("content-gc", "error", err)
		}
		result.GCFailure = b.ownership.GCFailure
	}()
	before, unused, err := b.measureContent(ctx)
	if err != nil {
		return result, err
	}
	sort.Slice(unused, func(i, j int) bool {
		a, z := b.ownership.Blobs[unused[i].Digest].UnusedSince, b.ownership.Blobs[unused[j].Digest].UnusedSince
		if a.Equal(z) {
			return unused[i].Digest < unused[j].Digest
		}
		return a.Before(z)
	})
	total := before.TotalBytes
	for _, info := range unused {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if total <= target && now.Sub(b.ownership.Blobs[info.Digest].UnusedSince) < unownedContentRetention {
			break
		}
		if err := b.Store.Delete(ctx, info.Digest); err != nil {
			return result, fmt.Errorf("delete blob %s: %w", info.Digest, err)
		}
		if err := syncDirectory(filepath.Join(filepath.Dir(b.path), "blobs", info.Digest.Algorithm().String())); err != nil {
			return result, err
		}
		// Never forget occupied bytes before physical deletion succeeds. An abrupt
		// stop here leaves a harmless record for a missing blob, cleaned below.
		total -= info.Size
		result.ReclaimedBytes += info.Size
		delete(b.ownership.Blobs, info.Digest)
	}
	// Clean records left by interrupted deletes or failed commits. No commit can
	// be in flight under this lock. Applied descriptors are only reuse hints.
	for d := range b.ownership.Blobs {
		if _, infoErr := b.Store.Info(ctx, d); infoErr != nil {
			if !errdefs.IsNotFound(infoErr) {
				return result, infoErr
			}
			delete(b.ownership.Blobs, d)
		}
	}
	for key := range b.applied {
		_, encoded, _ := strings.Cut(key, "@")
		if _, exists := b.ownership.Blobs[digest.Digest(encoded)]; !exists {
			delete(b.applied, key)
		}
	}
	if err := durableJSON(b.path, b.applied); err != nil {
		return result, err
	}
	result.ContentStorageStats, _, err = b.measureContent(ctx)
	return result, err
}

func (b *blobStore) requestContentGC() {
	select {
	case b.gcRequests <- struct{}{}:
	default:
	}
}

func (b *blobStore) startContentGC() func() {
	return startStorageGC(b.gcRequests, b.collectContent)
}

func (b *blobStore) registerContentStorageAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /content/storage", storageHandler(b.contentStorageStats))
	mux.HandleFunc("POST /content/gc", storageHandler(b.collectContent))
}
