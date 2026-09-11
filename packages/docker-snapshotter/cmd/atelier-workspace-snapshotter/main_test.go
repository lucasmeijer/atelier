package main

import (
	"flag"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "run-snapshotter-test-process" {
		os.Args = append(os.Args[:1], os.Args[2:]...)
		flag.CommandLine = flag.NewFlagSet(os.Args[0], flag.ExitOnError)
		main()
		return
	}
	os.Exit(m.Run())
}
func TestLocalCoordinatorBootstrapsWithoutContainerdAndOwnsListener(t *testing.T) {
	root, err := os.MkdirTemp("", "atelier-local-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(root, "local.sock")
	args := []string{"run-snapshotter-test-process", "--local-root", filepath.Join(root, "private"), "--local-socket", socket, "--shared-socket", filepath.Join(root, "shared-not-started.sock"), "--containerd-socket", filepath.Join(root, "containerd-not-started.sock")}
	start := func() *exec.Cmd {
		cmd := exec.Command(exe, args...)
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				cmd.Process.Kill()
				cmd.Wait()
			}
		})
		return cmd
	}
	ready := func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			conn, err := net.DialTimeout("unix", socket, 50*time.Millisecond)
			if err == nil {
				conn.Close()
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("local listener waited for containerd")
	}
	first := start()
	ready()
	duplicate := exec.Command(exe, args...)
	if err := duplicate.Run(); err == nil {
		t.Fatal("duplicate coordinator replaced listener")
	}
	ready()
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := first.Wait(); err == nil {
		t.Fatal("SIGKILL not observed")
	}
	second := start()
	ready()
	if err := second.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := second.Wait(); err != nil {
		t.Fatal(err)
	}
}
