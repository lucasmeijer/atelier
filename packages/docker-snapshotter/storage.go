package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// Both collectors run after recovery, coalesce mutation bursts, and periodically
// retry. Each collector owns its lock and persists/logs its own failures.
func startStorageGC[T any](requests chan struct{}, collect func(context.Context) (T, error)) func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-requests:
				timer := time.NewTimer(time.Second)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
				select {
				case <-requests:
				default:
				}
			}
			if _, err := collect(ctx); err != nil {
				// Failure is already visible in logs and System health; retry next cycle.
				continue
			}
		}
	}()
	select {
	case requests <- struct{}{}:
	default:
	}
	return func() { cancel(); <-done }
}

func storageHandler[T any](read func(context.Context) (T, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		stats, err := read(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(stats); err != nil {
			slog.Error("storage response", "path", r.URL.Path, "error", err)
		}
	}
}
