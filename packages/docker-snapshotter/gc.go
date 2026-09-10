package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/continuity/fs"
)

const unpackedLayerTargetBytes int64 = 10_000_000_000

// Only unpacked shared image storage is counted. Compressed content, private
// workspace snapshots, the registry and BuildKit each have separate lifetimes.
type StorageStats struct {
	UsedBytes   int64      `json:"usedBytes"`
	UnusedBytes int64      `json:"unusedBytes"`
	TotalBytes  int64      `json:"totalBytes"`
	TargetBytes int64      `json:"targetBytes"`
	MeasuredAt  time.Time  `json:"measuredAt"`
	GCFailure   *GCFailure `json:"gcFailure,omitempty"`
}

type GCFailure struct {
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

type GCResult struct {
	StorageStats
	ReclaimedBytes int64 `json:"reclaimedBytes"`
}

// Caller holds Store's lock. Aliases protect images even in parked clients.
// Local hybrid snapshots prevent removal of their shared parent alias. Retirement
// is only safe after the owning container/volume has been removed.
func (s *Store) usedLayers() map[string]bool {
	byBacking := make(map[string]Chain, len(s.state.Chains))
	for _, chain := range s.state.Chains {
		byBacking[chain.Backing] = chain
	}
	used := map[string]bool{}
	var mark func(string)
	mark = func(backing string) {
		chain, exists := byBacking[backing]
		if !exists || used[backing] {
			return
		}
		used[backing] = true
		mark(chain.Parent)
	}
	for _, aliases := range s.state.Clients {
		for _, alias := range aliases {
			mark(alias.Backing)
			// A cold prepare can skip extraction against a retained chain. Keep
			// that chain until commit, even if its previous owner retires.
			if chain, exists := s.state.Chains[alias.Target]; exists {
				mark(chain.Backing)
			}
		}
	}
	return used
}

// Persist transitions, not access times: a reused layer becomes newest-unused
// when its last reference disappears. Older saved stores start their clock now.
func (s *Store) updateUnusedLayers() {
	used := s.usedLayers()
	previous := s.state.UnusedSince
	s.state.UnusedSince = map[string]time.Time{}
	now := time.Now().UTC()
	for _, chain := range s.state.Chains {
		if used[chain.Backing] {
			continue
		}
		since, exists := previous[chain.Backing]
		if !exists {
			since = now
		}
		s.state.UnusedSince[chain.Backing] = since
	}
}

// Overlay Usage measures allocated bytes of each changeset, not its ancestors.
// Committed usage is immutable; active extraction usage is measured afresh.
func (s *Store) measureStorage(ctx context.Context) (StorageStats, map[string]int64, error) {
	stats := StorageStats{TargetBytes: unpackedLayerTargetBytes, GCFailure: s.state.GCFailure}
	used := s.usedLayers()
	sizes := map[string]int64{}
	for _, chain := range s.state.Chains {
		if _, counted := sizes[chain.Backing]; counted {
			continue
		}
		usage, err := s.backend.Usage(ctx, chain.Backing)
		if err != nil {
			return stats, nil, fmt.Errorf("measure layer %s: %w", chain.Backing, err)
		}
		sizes[chain.Backing] = usage.Size
		if used[chain.Backing] {
			stats.UsedBytes += usage.Size
		} else {
			stats.UnusedBytes += usage.Size
		}
	}
	for _, aliases := range s.state.Clients {
		for _, alias := range aliases {
			if alias.Target == "" || alias.Info.Kind != snapshots.KindActive {
				continue
			}
			if _, counted := sizes[alias.Backing]; counted {
				continue
			}
			usage, err := s.backend.Usage(ctx, alias.Backing)
			if err != nil {
				return stats, nil, fmt.Errorf("measure unpack %s: %w", alias.Backing, err)
			}
			sizes[alias.Backing] = usage.Size
			stats.UsedBytes += usage.Size
		}
	}
	// Failed physical deletions remain accounted for even after their backend
	// metadata is gone. A crash can also leave records whose files are gone.
	for _, path := range s.state.PendingLayerRemovals {
		usage, err := fs.DiskUsage(ctx, path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return stats, nil, err
		}
		stats.UnusedBytes += usage.Size
	}
	stats.TotalBytes = stats.UsedBytes + stats.UnusedBytes
	stats.MeasuredAt = time.Now().UTC()
	return stats, sizes, nil
}

func (s *Store) storageStats(ctx context.Context) (StorageStats, error) {
	s.Lock()
	defer s.Unlock()
	stats, _, err := s.measureStorage(ctx)
	return stats, err
}

func (s *Store) collectLayers(ctx context.Context) (GCResult, error) {
	return s.collectLayersTo(ctx, unpackedLayerTargetBytes)
}

// The target argument is internal to make small real-filesystem tests possible;
// the administrative interface deliberately does not accept configuration yet.
func (s *Store) collectLayersTo(ctx context.Context, target int64) (result GCResult, err error) {
	s.Lock()
	defer s.Unlock()
	defer func() {
		if err != nil {
			s.state.GCFailure = &GCFailure{Message: err.Error(), At: time.Now().UTC()}
			slog.Error("layer-gc", "error", err)
		} else {
			s.state.GCFailure = nil
		}
		s.save()
		result.GCFailure = s.state.GCFailure
	}()
	s.updateUnusedLayers()
	before, sizes, err := s.measureStorage(ctx)
	if err != nil {
		return result, err
	}
	if err := s.finishLayerRemovals(ctx); err != nil {
		return result, err
	}
	current, _, err := s.measureStorage(ctx)
	if err != nil {
		return result, err
	}
	total := current.TotalBytes
	// Remove leaves before parents. Among eligible leaves, oldest-unused wins;
	// parents become eligible as their last child is removed.
	for total > target {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		parents := map[string]bool{}
		for _, chain := range s.state.Chains {
			parents[chain.Parent] = true
		}
		var backing string
		var oldest time.Time
		for candidate, since := range s.state.UnusedSince {
			if parents[candidate] {
				continue
			}
			if backing == "" || since.Before(oldest) || (since.Equal(oldest) && candidate < backing) {
				backing, oldest = candidate, since
			}
		}
		if backing == "" {
			break // Protected storage may exceed the soft target.
		}
		info, err := s.backend.Stat(ctx, backing)
		if err != nil {
			return result, err
		}
		path := info.Labels[overlayUpperdirLabel]
		if !filepath.IsAbs(path) {
			return result, fmt.Errorf("layer %s has no absolute backing directory", backing)
		}
		if err := s.mutate(ctx, mutation{Kind: "remove", Key: backing}, func() {
			if s.state.PendingLayerRemovals == nil {
				s.state.PendingLayerRemovals = map[string]string{}
			}
			s.state.PendingLayerRemovals[backing] = path
			for target, chain := range s.state.Chains {
				if chain.Backing == backing {
					delete(s.state.Chains, target)
				}
			}
		}); err != nil {
			return result, fmt.Errorf("remove unused layer %s: %w", backing, err)
		}
		total -= sizes[backing]
	}
	if err := s.finishLayerRemovals(ctx); err != nil {
		return result, err
	}
	result.StorageStats, _, err = s.measureStorage(ctx)
	// Active unpacking can grow while the diff service writes outside this
	// metadata lock. Reclaimed bytes must not include that concurrent growth.
	result.ReclaimedBytes = before.UnusedBytes - result.UnusedBytes
	return result, err
}

// Overlay logs physical removal errors rather than returning them. Keep a
// durable deletion record until the backing is actually gone, so GC cannot
// report success or forget occupied bytes after such a failure or a crash.
func (s *Store) finishLayerRemovals(ctx context.Context) error {
	if len(s.state.PendingLayerRemovals) == 0 {
		return nil
	}
	if cleaner, ok := s.backend.(snapshots.Cleaner); ok {
		if err := cleaner.Cleanup(ctx); err != nil {
			return fmt.Errorf("clean removed layers: %w", err)
		}
	}
	for backing, path := range s.state.PendingLayerRemovals {
		_, err := os.Stat(path)
		if os.IsNotExist(err) {
			delete(s.state.PendingLayerRemovals, backing)
		} else if err != nil {
			return fmt.Errorf("verify removed layer %s: %w", backing, err)
		} else {
			return fmt.Errorf("layer %s backing remains after cleanup: %s", backing, path)
		}
	}
	return nil
}

func (s *Store) requestLayerGC() {
	select {
	case s.gcRequests <- struct{}{}:
	default:
	}
}

func (s *Store) startLayerGC() func() {
	s.Lock()
	s.gcRequests = make(chan struct{}, 1)
	s.Unlock()
	return startStorageGC(s.gcRequests, s.collectLayers)
}

func (s *Store) registerStorageAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /storage", storageHandler(s.storageStats))
	mux.HandleFunc("POST /gc", storageHandler(s.collectLayers))
}
