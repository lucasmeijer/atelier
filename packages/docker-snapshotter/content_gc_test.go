package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/containerd/containerd/v2/core/content"
	"github.com/containerd/containerd/v2/core/metadata"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/containerd/v2/plugins/content/local"
	"github.com/containerd/errdefs"
	digest "github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	bolt "go.etcd.io/bbolt"
)

func newContentStore(t *testing.T) *blobStore {
	t.Helper()
	b, err := openBlobs(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func putContent(t *testing.T, b *blobStore, client, payload string) ocispec.Descriptor {
	t.Helper()
	desc := ocispec.Descriptor{Digest: digest.FromString(payload), Size: int64(len(payload))}
	if err := content.WriteBlob(context.Background(), &clientContent{blobStore: b, prefix: client + "/"}, "upload", bytes.NewBufferString(payload), desc); err != nil {
		t.Fatal(err)
	}
	return desc
}

func collectContentAt(t *testing.T, b *blobStore, target int64, now time.Time) ContentGCResult {
	t.Helper()
	result, err := b.collectContentTo(context.Background(), target, now)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertContentPresent(t *testing.T, b *blobStore, d ocispec.Descriptor, present bool) {
	t.Helper()
	_, err := b.Store.Info(context.Background(), d.Digest)
	if present && err != nil {
		t.Fatal(err)
	}
	if !present && !errdefs.IsNotFound(err) {
		t.Fatalf("expected %s absent, got %v", d.Digest, err)
	}
}

func TestContentGCAgeThenSizeAndProtectedContent(t *testing.T) {
	b := newContentStore(t)
	old := putContent(t, b, "old", "old!")
	younger := putContent(t, b, "younger", "young")
	newest := putContent(t, b, "newest", "newest")
	pinned := putContent(t, b, "parked", "protected")
	now := time.Now().UTC()
	for client, age := range map[string]time.Duration{"old": 8 * 24 * time.Hour, "younger": 2 * 24 * time.Hour, "newest": time.Hour} {
		if err := b.retire(context.Background(), client); err != nil {
			t.Fatal(err)
		}
		for d, record := range b.ownership.Blobs {
			if (client == "old" && d == old.Digest) || (client == "younger" && d == younger.Digest) || (client == "newest" && d == newest.Digest) {
				record.UnusedSince = now.Add(-age)
				b.ownership.Blobs[d] = record
			}
		}
	}
	result := collectContentAt(t, b, 1000, now)
	if result.ReclaimedBytes != old.Size {
		t.Fatalf("age collection: %+v", result)
	}
	assertContentPresent(t, b, old, false)
	assertContentPresent(t, b, younger, true)
	// Age is not a minimum residence time: size pressure can evict younger blobs.
	result = collectContentAt(t, b, pinned.Size+newest.Size, now)
	if result.ReclaimedBytes != younger.Size || result.TotalBytes != pinned.Size+newest.Size {
		t.Fatalf("size collection: %+v", result)
	}
	assertContentPresent(t, b, younger, false)
	assertContentPresent(t, b, newest, true)
	result = collectContentAt(t, b, 0, now.Add(100*24*time.Hour))
	if result.PinnedBytes != pinned.Size || result.ReclaimableBytes != 0 || result.TotalBytes != pinned.Size {
		t.Fatalf("soft target: %+v", result)
	}
	assertContentPresent(t, b, pinned, true)
}

func TestContentGCPinsSurvivePruneRetirementAndRestart(t *testing.T) {
	ctx := context.Background()
	b := newContentStore(t)
	d := putContent(t, b, "A", "retained compressed blob")
	c := &clientContent{blobStore: b, prefix: "B/"}
	// Metadata-only acquisition must pin too; no upload or ReaderAt is necessary.
	if _, err := c.Info(ctx, d.Digest); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, d.Digest); err != nil {
		t.Fatal(err)
	}
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	reopened, err := openBlobs(filepath.Dir(b.path))
	if err != nil {
		t.Fatal(err)
	}
	result := collectContentAt(t, reopened, 0, time.Now().Add(30*24*time.Hour))
	if result.PinnedBytes != d.Size {
		t.Fatalf("lost B's pin: %+v", result)
	}
	if err := reopened.retire(ctx, "B"); err != nil {
		t.Fatal(err)
	}
	since := reopened.ownership.Blobs[d.Digest].UnusedSince
	if since.IsZero() {
		t.Fatal("last-owner release did not start retention clock")
	}
	collectContentAt(t, reopened, 1000, since.Add(unownedContentRetention-time.Nanosecond))
	assertContentPresent(t, reopened, d, true)
	collectContentAt(t, reopened, 1000, since.Add(unownedContentRetention))
	assertContentPresent(t, reopened, d, false)
}

func TestContentGCExistingStoreProtectsAllPotentialConsumers(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	raw, err := local.NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("pre-existing blob")
	d := ocispec.Descriptor{Digest: digest.FromBytes(payload), Size: int64(len(payload))}
	if err := content.WriteBlob(ctx, raw, "old-upload", bytes.NewReader(payload), d); err != nil {
		t.Fatal(err)
	}
	b, err := openBlobs(root, "A", "parked")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	b, err = openBlobs(root, "new-client")
	if err != nil {
		t.Fatal(err)
	}
	collectContentAt(t, b, 0, time.Now().Add(90*24*time.Hour))
	assertContentPresent(t, b, d, true)
	if err := b.retire(ctx, "parked"); err != nil {
		t.Fatal(err)
	}
	collectContentAt(t, b, 0, time.Now())
	assertContentPresent(t, b, d, false)
}

func TestContentGCProtectsUploadsAndUnknownDigestCommits(t *testing.T) {
	ctx := context.Background()
	b := newContentStore(t)
	c := &clientContent{blobStore: b, prefix: "A/"}
	w, err := c.Writer(ctx, content.WithRef("unknown-digest"))
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("upload without descriptor")
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	result := collectContentAt(t, b, 0, time.Now().Add(30*24*time.Hour))
	if result.IngestBytes != int64(len(payload)) || result.ReclaimedBytes != 0 {
		t.Fatalf("upload accounting: %+v", result)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	// Resuming must calculate the digest over the entire upload, not just new writes.
	w, err = c.Writer(ctx, content.WithRef("unknown-digest"))
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Commit(ctx, int64(len(payload)), ""); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	result = collectContentAt(t, b, 0, time.Now())
	if result.PinnedBytes != int64(len(payload)) || result.IngestBytes != 0 {
		t.Fatalf("commit accounting: %+v", result)
	}
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Info(ctx, digest.FromBytes(payload)); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("retired client acquired blob: %v", err)
	}
	collectContentAt(t, b, 0, time.Now())
}

type deletingContentStore struct {
	content.Store
	delete func(context.Context, digest.Digest) error
}

func (s *deletingContentStore) Delete(ctx context.Context, d digest.Digest) error {
	return s.delete(ctx, d)
}

func TestContentGCDeletionFailureAndInterruptedDeleteRecovery(t *testing.T) {
	ctx := context.Background()
	b := newContentStore(t)
	d := putContent(t, b, "A", "retry deletion")
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	raw := b.Store
	b.Store = &deletingContentStore{Store: raw, delete: func(context.Context, digest.Digest) error { return errors.New("disk refused deletion") }}
	if _, err := b.collectContentTo(ctx, 0, time.Now()); err == nil {
		t.Fatal("expected deletion failure")
	}
	reopened, err := openBlobs(filepath.Dir(b.path))
	if err != nil {
		t.Fatal(err)
	}
	stats, err := reopened.contentStorageStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.GCFailure == nil || stats.ReclaimableBytes != d.Size {
		t.Fatalf("failure/bytes not retained: %+v", stats)
	}
	// Simulate abrupt termination after deleting a blob but before saving its record.
	if err := reopened.Store.Delete(ctx, d.Digest); err != nil {
		t.Fatal(err)
	}
	reopened, err = openBlobs(filepath.Dir(b.path))
	if err != nil {
		t.Fatal(err)
	}
	result := collectContentAt(t, reopened, 0, time.Now())
	if result.GCFailure != nil || result.TotalBytes != 0 || len(reopened.ownership.Blobs) != 0 {
		t.Fatalf("recovery: %+v", result)
	}
	reopened, err = openBlobs(filepath.Dir(b.path))
	if err != nil {
		t.Fatal(err)
	}
	if reopened.ownership.GCFailure != nil {
		t.Fatal("successful retry did not clear durable failure")
	}
}

func TestContentGCAcquisitionCannotRaceEviction(t *testing.T) {
	ctx := context.Background()
	b := newContentStore(t)
	d := putContent(t, b, "A", "racing acquisition")
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	raw := b.Store
	deleting, release := make(chan struct{}), make(chan struct{})
	b.Store = &deletingContentStore{Store: raw, delete: func(ctx context.Context, d digest.Digest) error {
		close(deleting)
		<-release
		return raw.Delete(ctx, d)
	}}
	gcDone := make(chan error, 1)
	go func() { _, err := b.collectContentTo(ctx, 0, time.Now()); gcDone <- err }()
	<-deleting
	acquired := make(chan error, 1)
	go func() { _, err := (&clientContent{blobStore: b, prefix: "B/"}).Info(ctx, d.Digest); acquired <- err }()
	close(release)
	if err := <-gcDone; err != nil {
		t.Fatal(err)
	}
	if err := <-acquired; !errdefs.IsNotFound(err) {
		t.Fatalf("acquired an evicted blob: %v", err)
	}
}

func TestContentGCPinFailureDoesNotPublishOwnership(t *testing.T) {
	ctx := context.Background()
	b := newContentStore(t)
	d := putContent(t, b, "A", "pin must be durable")
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	path := b.ownershipPath
	b.ownershipPath = filepath.Join(path, "not-a-directory")
	c := &clientContent{blobStore: b, prefix: "B/"}
	for range 2 {
		if _, err := c.Info(ctx, d.Digest); err == nil {
			t.Fatal("acquisition ignored persistence failure")
		}
	}
	b.ownershipPath = path
	if _, err := c.Info(ctx, d.Digest); err != nil {
		t.Fatal(err)
	}
	reopened, err := openBlobs(filepath.Dir(b.path))
	if err != nil {
		t.Fatal(err)
	}
	collectContentAt(t, reopened, 0, time.Now())
	assertContentPresent(t, reopened, d, true)
}

func TestContentStorageAPIMeasuresWithoutCollecting(t *testing.T) {
	b := newContentStore(t)
	d := putContent(t, b, "A", "old unowned payload")
	if err := b.retire(context.Background(), "A"); err != nil {
		t.Fatal(err)
	}
	record := b.ownership.Blobs[d.Digest]
	record.UnusedSince = time.Now().Add(-8 * 24 * time.Hour)
	b.ownership.Blobs[d.Digest] = record
	mux := http.NewServeMux()
	b.registerContentStorageAPI(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/content/storage", nil))
	var stats ContentStorageStats
	if err := json.Unmarshal(response.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || stats.ReclaimableBytes != d.Size || stats.TargetBytes != 10_000_000_000 || stats.RetentionDays != 7 {
		t.Fatalf("measurement: %d %+v", response.Code, stats)
	}
	assertContentPresent(t, b, d, true)
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("POST", "/content/gc", nil))
	var result ContentGCResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || result.ReclaimedBytes != d.Size {
		t.Fatalf("collection: %d %+v", response.Code, result)
	}
	assertContentPresent(t, b, d, false)
}

func TestContentGCAllAcquisitionPathsPinBeforeSuccess(t *testing.T) {
	for _, method := range []string{"info", "reader", "existing-writer"} {
		t.Run(method, func(t *testing.T) {
			ctx := context.Background()
			b := newContentStore(t)
			d := putContent(t, b, "A", "shared acquisition")
			if err := b.retire(ctx, "A"); err != nil {
				t.Fatal(err)
			}
			c := &clientContent{blobStore: b, prefix: "B/"}
			switch method {
			case "info":
				if _, err := c.Info(ctx, d.Digest); err != nil {
					t.Fatal(err)
				}
			case "reader":
				r, err := c.ReaderAt(ctx, d)
				if err != nil {
					t.Fatal(err)
				}
				if err := r.Close(); err != nil {
					t.Fatal(err)
				}
			case "existing-writer":
				if _, err := c.Writer(ctx, content.WithRef("reuse"), content.WithDescriptor(d)); !errdefs.IsAlreadyExists(err) {
					t.Fatalf("existing writer: %v", err)
				}
			}
			reopened, err := openBlobs(filepath.Dir(b.path))
			if err != nil {
				t.Fatal(err)
			}
			collectContentAt(t, reopened, 0, time.Now().Add(30*24*time.Hour))
			assertContentPresent(t, reopened, d, true)
		})
	}
}

func TestContentGCWorkerExpiresContentAfterStartup(t *testing.T) {
	b := newContentStore(t)
	d := putContent(t, b, "A", "startup collection")
	if err := b.retire(context.Background(), "A"); err != nil {
		t.Fatal(err)
	}
	record := b.ownership.Blobs[d.Digest]
	record.UnusedSince = time.Now().Add(-8 * 24 * time.Hour)
	b.ownership.Blobs[d.Digest] = record
	stop := b.startContentGC()
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		stats, err := b.contentStorageStats(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if stats.TotalBytes == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("startup GC did not expire unowned content")
}

func TestContentGCPrivateMetadataCollectionDoesNotPinForeignContent(t *testing.T) {
	ctx := namespaces.WithNamespace(context.Background(), "moby")
	b := newContentStore(t)
	foreign := putContent(t, b, "A", "unowned foreign content")
	if err := b.retire(ctx, "A"); err != nil {
		t.Fatal(err)
	}
	database, err := bolt.Open(filepath.Join(t.TempDir(), "metadata.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	db := metadata.NewDB(database, &clientContent{blobStore: b, prefix: "B/"}, nil)
	if err := db.Init(ctx); err != nil {
		t.Fatal(err)
	}
	payload := []byte("private metadata content")
	own := ocispec.Descriptor{Digest: digest.FromBytes(payload), Size: int64(len(payload))}
	if err := content.WriteBlob(ctx, db.ContentStore(), "local", bytes.NewReader(payload), own); err != nil {
		t.Fatal(err)
	}
	if err := db.ContentStore().Delete(ctx, own.Digest); err != nil {
		t.Fatal(err)
	}
	// This invokes the real containerd backing-store Walk/Delete cleanup path.
	if _, err := db.GarbageCollect(ctx); err != nil {
		t.Fatal(err)
	}
	result := collectContentAt(t, b, 0, time.Now())
	if result.PinnedBytes != own.Size || result.ReclaimedBytes != foreign.Size {
		t.Fatalf("private GC acquired foreign pins: %+v", result)
	}
	assertContentPresent(t, b, foreign, false)
	assertContentPresent(t, b, own, true)
}
