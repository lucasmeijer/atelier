package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	contentapi "github.com/containerd/containerd/api/services/content/v1"
	api "github.com/containerd/containerd/api/services/snapshots/v1"
	"github.com/containerd/containerd/v2/contrib/snapshotservice"
	"github.com/containerd/containerd/v2/core/content"
	contentproxy "github.com/containerd/containerd/v2/core/content/proxy"
	"github.com/containerd/containerd/v2/core/leases"
	"github.com/containerd/containerd/v2/core/metadata"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/core/snapshots/proxy"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/containerd/v2/plugins/services/content/contentserver"
	"github.com/containerd/containerd/v2/plugins/snapshots/overlay"
	"github.com/containerd/errdefs"
	"github.com/containerd/errdefs/pkg/errgrpc"
	digest "github.com/opencontainers/go-digest"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

func testRPC(t *testing.T, g *grpc.Server) *grpc.ClientConn {
	t.Helper()
	listener := bufconn.Listen(1024 * 1024)
	go func() {
		if err := g.Serve(listener); err != nil {
			t.Error(err)
		}
	}()
	conn, err := grpc.NewClient("passthrough:///test", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); g.Stop(); listener.Close() })
	return conn
}

type localFixture struct {
	ctx            context.Context
	s              *Store
	blobs          *blobStore
	warm           *sharedWarm
	local          *localSnapshotter
	db             *metadata.DB
	desc, manifest ocispec.Descriptor
	target         string
	request        *api.PrepareSnapshotRequest
}

func newLocalFixture(t *testing.T) *localFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(namespaces.WithNamespace(context.Background(), "moby"), 10*time.Second)
	t.Cleanup(cancel)
	root := t.TempDir()
	backend, err := overlay.NewSnapshotter(filepath.Join(root, "overlay"), overlay.WithUpperdirLabel)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	s := &Store{backend: backend, path: filepath.Join(root, "aliases.json"), state: State{Clients: map[string]map[string]Alias{"A": {}, "B": {}}, Chains: map[string]Chain{}, Retired: map[string]bool{}}}
	blobs, err := openBlobs(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("verified compressed representation")
	desc := ocispec.Descriptor{Digest: digest.FromBytes(payload), Size: int64(len(payload)), MediaType: ocispec.MediaTypeImageLayerGzip}
	applied := ocispec.Descriptor{Digest: digest.FromString("uncompressed"), Size: 1024, MediaType: ocispec.MediaTypeImageLayer}
	if err := content.WriteBlob(ctx, blobs, "layer", bytes.NewReader(payload), desc); err != nil {
		t.Fatal(err)
	}
	blobs.applied[diffCacheKey(desc)] = applied
	seed := &Client{s, "A"}
	if _, err := seed.Prepare(ctx, "extract", "", snapshots.WithLabels(map[string]string{refLabel: applied.Digest.String()})); err != nil {
		t.Fatal(err)
	}
	if err := seed.Commit(ctx, "seed", "extract"); err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := json.Marshal(ocispec.Manifest{Layers: []ocispec.Descriptor{desc}})
	if err != nil {
		t.Fatal(err)
	}
	manifest := ocispec.Descriptor{Digest: digest.FromBytes(manifestBytes), Size: int64(len(manifestBytes)), MediaType: ocispec.MediaTypeImageManifest}
	if err := content.WriteBlob(ctx, blobs, "manifest", bytes.NewReader(manifestBytes), manifest); err != nil {
		t.Fatal(err)
	}
	warm := &sharedWarm{client: &Client{s, "B"}, blobs: blobs}
	sharedServer := grpc.NewServer()
	registerWarm(sharedServer, warm)
	registerImageLayers(sharedServer, warm.client)
	api.RegisterSnapshotsServer(sharedServer, snapshotservice.FromSnapshotter(warm.client))
	shared := testRPC(t, sharedServer)
	hybrid, err := newHybridSnapshotter(filepath.Join(root, "private"), proxy.NewSnapshotter(api.NewSnapshotsClient(shared), "shared-overlay"), func(ctx context.Context, key string) ([]string, error) { return resolveSharedLayers(ctx, shared, key) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hybrid.Close() })
	local := &localSnapshotter{hybrid: hybrid, SnapshotsServer: snapshotservice.FromSnapshotter(hybrid), shared: shared}
	localServer := grpc.NewServer()
	api.RegisterSnapshotsServer(localServer, local)
	localConn := testRPC(t, localServer)
	bdb, err := bolt.Open(filepath.Join(root, "meta.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bdb.Close() })
	db := metadata.NewDB(bdb, &clientContent{blobStore: blobs, prefix: "B/"}, map[string]snapshots.Snapshotter{"shared-overlay": proxy.NewSnapshotter(api.NewSnapshotsClient(localConn), "shared-overlay")})
	if err := db.Init(ctx); err != nil {
		t.Fatal(err)
	}
	contentServer := grpc.NewServer()
	contentapi.RegisterContentServer(contentServer, contentserver.New(db.ContentStore()))
	local.content = contentproxy.NewContentStore(contentapi.NewContentClient(testRPC(t, contentServer)))
	local.leases = metadata.NewLeaseManager(db)
	for _, id := range []string{"pull-one", "pull-two"} {
		lease, err := local.leases.Create(ctx, leases.WithID(id))
		if err != nil {
			t.Fatal(err)
		}
		if err := content.WriteBlob(leases.WithLease(ctx, lease.ID), db.ContentStore(), id, bytes.NewReader(manifestBytes), manifest, content.WithLabels(map[string]string{"containerd.io/gc.ref.content.l.0": desc.Digest.String()})); err != nil {
			t.Fatal(err)
		}
	}
	return &localFixture{ctx: ctx, s: s, blobs: blobs, warm: warm, local: local, db: db, desc: desc, manifest: manifest, target: applied.Digest.String(), request: &api.PrepareSnapshotRequest{Key: "extract", Labels: map[string]string{refLabel: applied.Digest.String(), manifestLabel: manifest.Digest.String(), layerLabel: desc.Digest.String()}}}
}

func TestLocalWarmRegistersBeforeAdoptionThroughMetadata(t *testing.T) {
	f := newLocalFixture(t)
	if _, err := f.db.ContentStore().Info(f.ctx, f.desc.Digest); !errdefs.IsNotFound(err) {
		t.Fatalf("private content initially present: %v", err)
	}
	sequence := f.s.state.Sequence
	// Cross the same private metadata snapshotter interface containerd exposes.
	_, err := f.db.Snapshotter("shared-overlay").Prepare(leases.WithLease(f.ctx, "pull-one"), "unpack", "", snapshots.WithLabels(f.request.Labels))
	if !errdefs.IsAlreadyExists(err) {
		t.Fatalf("expected early hit: %v", err)
	}
	if _, err := f.db.Snapshotter("shared-overlay").Stat(f.ctx, f.target); err != nil {
		t.Fatal(err)
	}
	if f.s.state.Sequence != sequence {
		t.Fatal("allocated physical warm snapshot")
	}
	info, err := f.db.ContentStore().Info(f.ctx, f.desc.Digest)
	if err != nil || info.Labels[uncompressedLabel] != f.target {
		t.Fatalf("incomplete content metadata: %+v %v", info, err)
	}
	for _, id := range []string{"pull-one", "pull-two"} {
		resources, err := f.local.leases.ListResources(f.ctx, leases.Lease{ID: id})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, r := range resources {
			if r.Type == "content" && r.ID == f.desc.Digest.String() {
				found = true
			}
		}
		if !found {
			t.Fatalf("blob not protected by %s", id)
		}
	}
	// Original owner deletion cannot invalidate the adopted layer.
	if err := f.s.retire(f.ctx, "A"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.GarbageCollect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ContentStore().Info(f.ctx, f.desc.Digest); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Snapshotter("shared-overlay").Stat(f.ctx, f.target); err != nil {
		t.Fatal(err)
	}
}

func TestWarmLookupIsReadOnlyAndRejectsUnverifiedRepresentation(t *testing.T) {
	f := newLocalFixture(t)
	if _, err := f.warm.Lookup(f.ctx, f.request); err != nil {
		t.Fatal(err)
	}
	if len(f.s.state.Clients["B"]) != 0 {
		t.Fatal("lookup created alias")
	}
	// An alternative compressed blob can describe the same diff, but cannot hit
	// until that exact media type/digest has been verified by the applier.
	delete(f.blobs.applied, diffCacheKey(f.desc))
	if _, err := f.warm.Lookup(f.ctx, f.request); !errdefs.IsNotFound(err) {
		t.Fatalf("unverified hit: %v", err)
	}
	if _, err := f.warm.Adopt(f.ctx, f.request); !errdefs.IsNotFound(err) {
		t.Fatalf("unverified adoption: %v", err)
	}
	if len(f.s.state.Clients["B"]) != 0 {
		t.Fatal("failed adoption created alias")
	}
}
func TestWarmAdoptionRetirementCancellationAndConcurrentRetry(t *testing.T) {
	f := newLocalFixture(t)
	canceled, cancel := context.WithCancel(f.ctx)
	cancel()
	if _, err := f.warm.Adopt(canceled, f.request); err == nil {
		t.Fatal("canceled adoption succeeded")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.warm.Adopt(f.ctx, f.request); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(f.s.state.Clients["B"]) != 1 {
		t.Fatal("adoption was not idempotent")
	}
	if err := f.s.retire(f.ctx, "B"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.warm.Adopt(f.ctx, f.request); !errdefs.IsFailedPrecondition(err) {
		t.Fatalf("resurrected retired client: %v", err)
	}
}

func TestLocalMissingLeaseFailsWithoutAlias(t *testing.T) {
	f := newLocalFixture(t)
	for _, id := range []string{"pull-one", "pull-two"} {
		if err := f.local.leases.Delete(f.ctx, leases.Lease{ID: id}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := f.local.Prepare(f.ctx, f.request)
	if err == nil || !strings.Contains(err.Error(), "no active manifest lease") {
		t.Fatalf("unexpected result: %v", err)
	}
	if len(f.s.state.Clients["B"]) != 0 {
		t.Fatal("registration failure adopted snapshot")
	}
}

// A lease ending between discovery and Writer is an expected external race.
// Other content errors must not be mistaken for an expired lease.
type endingLeaseContent struct {
	content.Store
	manager leases.Manager
	once    sync.Once
}

func (s *endingLeaseContent) Writer(ctx context.Context, opts ...content.WriterOpt) (content.Writer, error) {
	var deleteErr error
	s.once.Do(func() { id, _ := leases.FromContext(ctx); deleteErr = s.manager.Delete(ctx, leases.Lease{ID: id}) })
	if deleteErr != nil {
		return nil, deleteErr
	}
	return s.Store.Writer(ctx, opts...)
}
func TestLocalConcurrentPullFinishingDuringRegistration(t *testing.T) {
	f := newLocalFixture(t)
	f.local.content = &endingLeaseContent{Store: f.local.content, manager: f.local.leases}
	if _, err := f.local.Prepare(f.ctx, f.request); !errdefs.IsAlreadyExists(errgrpc.ToNative(err)) {
		t.Fatalf("remaining pull failed: %v", err)
	}
	info, err := f.db.ContentStore().Info(f.ctx, f.desc.Digest)
	if err != nil || info.Labels[uncompressedLabel] != f.target {
		t.Fatalf("missing registered content: %+v %v", info, err)
	}
}

func TestWarmUsesExactAlternateCompressionAndRechecksBlob(t *testing.T) {
	f := newLocalFixture(t)
	payload := []byte("different compressed encoding of the same diff")
	alt := ocispec.Descriptor{Digest: digest.FromBytes(payload), Size: int64(len(payload)), MediaType: ocispec.MediaTypeImageLayerGzip}
	if err := content.WriteBlob(f.ctx, f.blobs, "alt", bytes.NewReader(payload), alt); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(ocispec.Manifest{Layers: []ocispec.Descriptor{alt}})
	if err != nil {
		t.Fatal(err)
	}
	manifest := ocispec.Descriptor{Digest: digest.FromBytes(data), Size: int64(len(data)), MediaType: ocispec.MediaTypeImageManifest}
	if err := content.WriteBlob(f.ctx, f.blobs, "alt-manifest", bytes.NewReader(data), manifest); err != nil {
		t.Fatal(err)
	}
	f.request.Labels[layerLabel] = alt.Digest.String()
	f.request.Labels[manifestLabel] = manifest.Digest.String()
	if _, err := f.warm.Lookup(f.ctx, f.request); !errdefs.IsNotFound(err) {
		t.Fatalf("used original compression's verification: %v", err)
	}
	f.blobs.applied[diffCacheKey(alt)] = f.blobs.applied[diffCacheKey(f.desc)]
	candidate, err := f.warm.Lookup(f.ctx, f.request)
	if err != nil || candidate.Digest != alt.Digest.String() {
		t.Fatalf("wrong blob returned: %+v %v", candidate, err)
	}
	if err := f.blobs.Delete(f.ctx, alt.Digest); err != nil {
		t.Fatal(err)
	}
	if _, err := f.warm.Adopt(f.ctx, f.request); !errdefs.IsNotFound(err) {
		t.Fatalf("adopted missing export blob: %v", err)
	}
	if len(f.s.state.Clients["B"]) != 0 {
		t.Fatal("failed adoption mutated aliases")
	}
}

type pausedContent struct {
	content.Store
	entered, release chan struct{}
}

func (p *pausedContent) Writer(ctx context.Context, opts ...content.WriterOpt) (content.Writer, error) {
	select {
	case p.entered <- struct{}{}:
	default:
	}
	select {
	case <-p.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return p.Store.Writer(ctx, opts...)
}
func TestLocalCallbackOverlapsPrivateSnapshotGC(t *testing.T) {
	f := newLocalFixture(t)
	sequence := f.s.state.Sequence
	paused := &pausedContent{Store: f.local.content, entered: make(chan struct{}, 1), release: make(chan struct{})}
	f.local.content = paused
	sn := f.db.Snapshotter("shared-overlay")
	done := make(chan error, 1)
	go func() {
		_, err := sn.Prepare(leases.WithLease(f.ctx, "pull-one"), "unpack", "", snapshots.WithLabels(f.request.Labels))
		done <- err
	}()
	select {
	case <-paused.entered:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	if _, err := sn.Prepare(f.ctx, "garbage", ""); err != nil {
		t.Fatal(err)
	}
	if err := sn.Remove(f.ctx, "garbage"); err != nil {
		t.Fatal(err)
	}
	gc := make(chan error, 1)
	go func() { _, err := f.db.GarbageCollect(context.Background()); gc <- err }()
	close(paused.release)
	select {
	case err := <-done:
		if !errdefs.IsAlreadyExists(err) {
			t.Fatal(err)
		}
	case <-f.ctx.Done():
		t.Fatal("callback deadlocked")
	}
	select {
	case err := <-gc:
		if err != nil {
			t.Fatal(err)
		}
	case <-f.ctx.Done():
		t.Fatal("GC deadlocked")
	}
	if f.s.state.Sequence != sequence {
		t.Fatal("private snapshot lifecycle mutated installation backing")
	}
}

func TestLocalWarmCannotShadowPrivateSnapshot(t *testing.T) {
	f := newLocalFixture(t)
	if _, err := f.local.Prepare(f.ctx, &api.PrepareSnapshotRequest{Key: "private"}); err != nil {
		t.Fatal(err)
	}
	request := &api.PrepareSnapshotRequest{Key: "private", Labels: f.request.Labels}
	if _, err := f.local.Prepare(f.ctx, request); !errdefs.IsAlreadyExists(errgrpc.ToNative(err)) {
		t.Fatalf("warm request shadowed private key: %v", err)
	}
	if _, err := f.warm.client.Stat(f.ctx, "private"); !errdefs.IsNotFound(err) {
		t.Fatalf("warm request installed competing shared alias: %v", err)
	}
	request = &api.PrepareSnapshotRequest{Key: "invalid", Labels: map[string]string{refLabel: f.target, sharedParentLabel: "forged"}}
	if _, err := f.local.Prepare(f.ctx, request); !errdefs.IsInvalidArgument(errgrpc.ToNative(err)) {
		t.Fatalf("warm path accepted reserved labels: %v", err)
	}
}

func TestLocalMetadataNamespacesAndBackgroundGC(t *testing.T) {
	f := newLocalFixture(t)
	sn := f.db.Snapshotter("shared-overlay")
	first := f.ctx
	second := namespaces.WithNamespace(context.Background(), "other")
	// Namespace isolation belongs to containerd's metadata snapshotter. Its
	// globally unique backend keys remain usable when GC drops the namespace.
	roots := map[string]string{"containerd.io/gc.root": "test"}
	a, err := sn.Prepare(first, "same-name", "", snapshots.WithLabels(roots))
	if err != nil {
		t.Fatal(err)
	}
	b, err := sn.Prepare(second, "same-name", "", snapshots.WithLabels(roots))
	if err != nil {
		t.Fatal(err)
	}
	if a[0].Source == b[0].Source {
		t.Fatal("metadata namespaces shared a private writable directory")
	}
	if _, err := sn.Stat(first, "same-name"); err != nil {
		t.Fatal(err)
	}
	if _, err := sn.Stat(second, "same-name"); err != nil {
		t.Fatal(err)
	}
	var backendNames []string
	if err := f.local.hybrid.Walk(context.Background(), func(_ context.Context, i snapshots.Info) error {
		backendNames = append(backendNames, i.Name)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(backendNames) != 2 {
		t.Fatalf("global GC cannot see both namespaces: %v", backendNames)
	}
	if err := sn.Remove(first, "same-name"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.GarbageCollect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a[0].Source); !os.IsNotExist(err) {
		t.Fatalf("background GC stranded first private upper: %v", err)
	}
	if _, err := os.Stat(b[0].Source); err != nil {
		t.Fatalf("GC removed other namespace private upper: %v", err)
	}
	if _, err := sn.Stat(second, "same-name"); err != nil {
		t.Fatal(err)
	}
	if err := sn.Remove(second, "same-name"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.GarbageCollect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b[0].Source); !os.IsNotExist(err) {
		t.Fatalf("background GC stranded second private upper: %v", err)
	}
	// The supervisor's local startup API probe is also intentionally unnamespaced.
	if _, err := f.local.Prepare(context.Background(), &api.PrepareSnapshotRequest{Key: "startup-probe"}); err != nil {
		t.Fatal(err)
	}
	if err := f.local.hybrid.Remove(context.Background(), "startup-probe"); err != nil {
		t.Fatal(err)
	}
}

func TestLocalWarmRegistrationCannotRacePrivateOwnership(t *testing.T) {
	f := newLocalFixture(t)
	paused := &pausedContent{Store: f.local.content, entered: make(chan struct{}, 1), release: make(chan struct{})}
	f.local.content = paused
	done := make(chan error, 1)
	go func() { _, err := f.local.Prepare(f.ctx, f.request); done <- err }()
	select {
	case <-paused.entered:
	case <-f.ctx.Done():
		t.Fatal("warm registration never started")
	}
	if _, err := f.local.Prepare(f.ctx, &api.PrepareSnapshotRequest{Key: f.request.Key}); err != nil {
		t.Fatal(err)
	}
	close(paused.release)
	select {
	case err := <-done:
		if !errdefs.IsAlreadyExists(errgrpc.ToNative(err)) {
			t.Fatalf("private owner not respected: %v", err)
		}
	case <-f.ctx.Done():
		t.Fatal("warm adoption deadlocked")
	}
	if _, err := f.warm.client.Stat(f.ctx, f.request.Key); !errdefs.IsNotFound(err) {
		t.Fatalf("warm adoption published competing shared alias: %v", err)
	}
	info, err := f.local.hybrid.Stat(f.ctx, f.request.Key)
	if err != nil || info.Kind != snapshots.KindActive {
		t.Fatalf("private winner changed: %+v %v", info, err)
	}
}

func TestWarmLookupPinsExactCompressedRepresentation(t *testing.T) {
	f := newLocalFixture(t)
	if _, err := f.warm.Lookup(f.ctx, f.request); err != nil {
		t.Fatal(err)
	}
	if !f.blobs.ownership.Blobs[f.desc.Digest].Clients["B"] || !f.blobs.ownership.Blobs[f.manifest.Digest].Clients["B"] {
		t.Fatal("warm lookup did not durably pin layer and manifest")
	}
	reopened, err := openBlobs(filepath.Dir(f.blobs.path))
	if err != nil {
		t.Fatal(err)
	}
	result := collectContentAt(t, reopened, 0, time.Now().Add(30*24*time.Hour))
	if result.PinnedBytes != f.desc.Size+f.manifest.Size {
		t.Fatalf("warm content not protected: %+v", result)
	}
}
