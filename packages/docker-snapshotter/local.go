package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	contentapi "github.com/containerd/containerd/api/services/content/v1"
	leaseapi "github.com/containerd/containerd/api/services/leases/v1"
	api "github.com/containerd/containerd/api/services/snapshots/v1"
	types "github.com/containerd/containerd/api/types"
	"github.com/containerd/containerd/v2/contrib/snapshotservice"
	"github.com/containerd/containerd/v2/core/content"
	contentproxy "github.com/containerd/containerd/v2/core/content/proxy"
	"github.com/containerd/containerd/v2/core/leases"
	leaseproxy "github.com/containerd/containerd/v2/core/leases/proxy"
	"github.com/containerd/containerd/v2/core/snapshots"
	"github.com/containerd/containerd/v2/core/snapshots/proxy"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/containerd/v2/pkg/oci"
	"github.com/containerd/errdefs"
	"github.com/containerd/errdefs/pkg/errgrpc"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/emptypb"
)

type localSnapshotter struct {
	api.SnapshotsServer
	hybrid  *hybridSnapshotter
	shared  grpc.ClientConnInterface
	content content.Store
	leases  leases.Manager
}

func (l *localSnapshotter) Prepare(ctx context.Context, r *api.PrepareSnapshotRequest) (*api.PrepareSnapshotResponse, error) {
	if _, err := requestedInfo([]snapshots.Opt{snapshots.WithLabels(r.Labels)}); err != nil {
		return nil, errgrpc.ToGRPC(err)
	}
	if r.Labels[refLabel] == "" {
		return l.SnapshotsServer.Prepare(ctx, r)
	}
	localParent, err := l.hybrid.privateImageRequest(ctx, r.Key, r.Parent)
	if err != nil {
		return nil, errgrpc.ToGRPC(err)
	}
	if localParent {
		return l.SnapshotsServer.Prepare(ctx, r)
	}
	ns, err := namespaces.NamespaceRequired(ctx)
	if err != nil {
		return nil, errgrpc.ToGRPC(err)
	}
	ctx = namespaces.WithNamespace(ctx, ns)
	var wire types.Descriptor
	err = l.shared.Invoke(ctx, "/"+warmService+"/Lookup", r, &wire)
	if errdefs.IsNotFound(errgrpc.ToNative(err)) {
		return l.SnapshotsServer.Prepare(ctx, r)
	}
	if err != nil {
		return nil, err
	}
	desc := oci.DescriptorFromProto(&wire)
	if err := l.register(ctx, r, desc); err != nil {
		return nil, errgrpc.ToGRPC(err)
	}
	if err := l.adopt(ctx, r); err != nil {
		if errdefs.IsNotFound(errgrpc.ToNative(err)) {
			// GC may evict unused backing between Lookup and Adopt. Content is
			// already registered; use ordinary unpack rather than fail the pull.
			return l.SnapshotsServer.Prepare(ctx, r)
		}
		return nil, err
	}
	return nil, errgrpc.ToGRPC(errdefs.ErrAlreadyExists)
}

// Content registration can overlap private snapshot creation. Recheck ownership
// and publish the shared alias under the same graph lock as private mutations.
// Adopt performs no containerd callbacks; registration must remain outside.
func (l *localSnapshotter) adopt(ctx context.Context, r *api.PrepareSnapshotRequest) error {
	l.hybrid.mu.Lock()
	defer l.hybrid.mu.Unlock()
	privateParent, err := l.hybrid.privateImageRequestLocked(ctx, r.Key, r.Parent)
	if err != nil {
		return errgrpc.ToGRPC(err)
	}
	if privateParent {
		return errgrpc.ToGRPC(fmt.Errorf("image parent became private during registration: %w", errdefs.ErrFailedPrecondition))
	}
	return l.shared.Invoke(ctx, "/"+warmService+"/Adopt", r, &emptypb.Empty{})
}

// Snapshot proxy requests do not carry the pull lease. Find every live lease
// holding this exact manifest, and register in all of them. This handles
// overlapping pulls without arbitrarily choosing another pull's lifetime.
// Leases can disappear while being enumerated or registered. Ignore only a
// confirmed deleted lease, and require successful registration under a remaining
// holder. A pull started after the listing has the same manifest GC edges.
func (l *localSnapshotter) register(ctx context.Context, r *api.PrepareSnapshotRequest, desc ocispec.Descriptor) error {
	active, err := l.leases.List(ctx)
	if err != nil {
		return err
	}
	var holders []string
	for _, lease := range active {
		resources, err := l.leases.ListResources(ctx, lease)
		if errdefs.IsNotFound(err) {
			continue // a concurrent pull finished after List
		}
		if err != nil {
			return err
		}
		for _, resource := range resources {
			if resource.Type == "content" && resource.ID == r.Labels[manifestLabel] {
				holders = append(holders, lease.ID)
				break
			}
		}
	}
	if len(holders) == 0 {
		return fmt.Errorf("warm content has no active manifest lease: %w", errdefs.ErrFailedPrecondition)
	}
	registered := 0
	for _, lease := range holders {
		leased := leases.WithLease(ctx, lease)
		writer, err := l.content.Writer(leased, content.WithRef("atelier-warm/"+r.Key+"/"+lease), content.WithDescriptor(desc))
		if errdefs.IsAlreadyExists(err) {
			// Writer still attaches existing metadata to this lease. Unpack's early-hit
			// path skips its usual label update, so ensure it even on existing content.
			_, err = l.content.Update(leased, content.Info{Digest: desc.Digest, Labels: desc.Annotations}, "labels."+uncompressedLabel)
		} else if err == nil {
			err = writer.Commit(leased, desc.Size, desc.Digest, content.WithLabels(desc.Annotations))
			if errdefs.IsAlreadyExists(err) {
				_, err = l.content.Update(leased, content.Info{Digest: desc.Digest, Labels: desc.Annotations}, "labels."+uncompressedLabel)
			}
			err = errors.Join(err, writer.Close())
		}
		if err != nil {
			if errdefs.IsNotFound(err) {
				_, leaseErr := l.leases.ListResources(ctx, leases.Lease{ID: lease})
				if errdefs.IsNotFound(leaseErr) {
					continue
				}
				if leaseErr != nil {
					return errors.Join(err, leaseErr)
				}
			}
			return err
		}
		registered++
	}
	if registered == 0 {
		return fmt.Errorf("all manifest leases ended during registration: %w", errdefs.ErrFailedPrecondition)
	}
	slog.Info("warm-register", "digest", desc.Digest, "leases", holders)
	return nil
}

// Listen before containerd starts. grpc.NewClient is lazy: readiness must not
// wait for a callback connection to the daemon that depends on this listener.
func runLocal(sharedPath, containerdPath, socket, localRoot string) {
	must(os.MkdirAll(localRoot, 0700))
	owner, err := lockStore(localRoot)
	must(err)
	defer owner.Close()
	shared, err := grpc.NewClient("unix://"+sharedPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(err)
	defer shared.Close()
	local, err := grpc.NewClient("unix://"+containerdPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(err)
	defer local.Close()
	var sharedSnapshots snapshots.Snapshotter = proxy.NewSnapshotter(api.NewSnapshotsClient(shared), "shared-overlay")
	hybrid, err := newHybridSnapshotter(localRoot, sharedSnapshots, func(ctx context.Context, key string) ([]string, error) { return resolveSharedLayers(ctx, shared, key) })
	must(err)
	defer hybrid.Close()
	g := grpc.NewServer(grpc.WaitForHandlers(true))
	api.RegisterSnapshotsServer(g, &localSnapshotter{
		SnapshotsServer: snapshotservice.FromSnapshotter(hybrid),
		hybrid:          hybrid,
		shared:          shared, content: contentproxy.NewContentStore(contentapi.NewContentClient(local)), leases: leaseproxy.NewLeaseManager(leaseapi.NewLeasesClient(local)),
	})
	// Readiness is observable as soon as the socket opens. Install shutdown
	// handling first so an immediate stop cannot take the default signal action.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)
	listener := listen(socket)
	go func() { <-stop; g.GracefulStop() }()
	slog.Info("local-ready", "socket", socket)
	if err := g.Serve(listener); err != nil && err != grpc.ErrServerStopped {
		must(err)
	}
}
