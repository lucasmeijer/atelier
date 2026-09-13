package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/platforms"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "atelier-image-transfer:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: atelier-image-transfer export [--platform linux/arm64] IMAGE | atelier-image-transfer import")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	address := flags.String("address", "/run/containerd/containerd.sock", "local containerd socket")
	namespace := flags.String("namespace", "moby", "containerd namespace")
	var platform string
	if args[0] == "export" {
		flags.StringVar(&platform, "platform", platforms.DefaultString(), "platform to select from an image index")
	}
	if args[0] != "export" && args[0] != "import" {
		return fmt.Errorf("unknown command %q", args[0])
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if (args[0] == "export" && flags.NArg() != 1) || (args[0] == "import" && flags.NArg() != 0) {
		return fmt.Errorf("export requires IMAGE; import reads an archive from stdin")
	}
	ctx = namespaces.WithNamespace(ctx, *namespace)
	client, err := containerd.New(*address)
	if err != nil {
		return err
	}
	defer client.Close()
	if args[0] == "export" {
		return exportImage(ctx, client, flags.Arg(0), platform, os.Stdout)
	}
	archive, err := readArchive(os.Stdin)
	if err != nil {
		return err
	}
	ref, err := importImage(ctx, client, archive)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, ref)
	return nil
}
