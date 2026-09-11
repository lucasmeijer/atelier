package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	contentapi "github.com/containerd/containerd/api/services/content/v1"
	leaseapi "github.com/containerd/containerd/api/services/leases/v1"
	api "github.com/containerd/containerd/api/services/snapshots/v1"
	contentproxy "github.com/containerd/containerd/v2/core/content/proxy"
	leaseproxy "github.com/containerd/containerd/v2/core/leases/proxy"
	"github.com/containerd/containerd/v2/core/snapshots/proxy"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/process"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/protocol"
	"github.com/lucasmeijer/atelier/packages/docker-snapshotter/internal/workspace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	localSocket := flag.String("local-socket", "", "run workspace-local snapshotter on this socket")
	localRoot := flag.String("local-root", "", "workspace volume directory for private snapshots")
	sharedSocket := flag.String("shared-socket", "", "installation client socket for local coordinator")
	containerdSocket := flag.String("containerd-socket", "/run/containerd/containerd.sock", "private containerd callback socket")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	for _, path := range []string{*localSocket, *sharedSocket, *containerdSocket, *localRoot} {
		if !filepath.IsAbs(path) {
			panic("absolute local snapshotter socket and storage paths required")
		}
	}
	run(*sharedSocket, *containerdSocket, *localSocket, *localRoot)
}

// run serves the workspace coordinator until SIGINT or SIGTERM.
// Listen before containerd starts. grpc.NewClient is lazy: readiness must not
// wait for a callback connection to the daemon that depends on this listener.
func run(sharedPath, containerdPath, socket, localRoot string) {
	process.Must(os.MkdirAll(localRoot, 0700))
	owner, err := process.LockStore(localRoot)
	process.Must(err)
	defer owner.Close()
	shared, err := grpc.NewClient("unix://"+sharedPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	process.Must(err)
	defer shared.Close()
	local, err := grpc.NewClient("unix://"+containerdPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	process.Must(err)
	defer local.Close()
	sharedSnapshots := proxy.NewSnapshotter(api.NewSnapshotsClient(shared), "shared-overlay")
	hybrid, err := workspace.NewHybrid(localRoot, sharedSnapshots, func(ctx context.Context, key string) ([]string, error) {
		return protocol.ResolveSharedLayers(ctx, shared, key)
	})
	process.Must(err)
	defer hybrid.Close()
	g := grpc.NewServer(grpc.WaitForHandlers(true))
	api.RegisterSnapshotsServer(g, workspace.NewCoordinator(hybrid, shared, contentproxy.NewContentStore(contentapi.NewContentClient(local)), leaseproxy.NewLeaseManager(leaseapi.NewLeasesClient(local))))
	// Readiness is observable as soon as the socket opens. Install shutdown
	// handling first so an immediate stop cannot take the default signal action.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)
	listener := process.Listen(socket)
	go func() { <-stop; g.GracefulStop() }()
	slog.Info("local-ready", "socket", socket)
	if err := g.Serve(listener); err != nil && err != grpc.ErrServerStopped {
		process.Must(err)
	}
}
