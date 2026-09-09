package main

import (
	"context"
	"flag"
	"io"
	"net"
	"net/http"
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

func TestDaemonReadinessAndRestoredClients(t *testing.T) {
	root := t.TempDir()
	socketDir := filepath.Join(root, "sockets")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(socketDir, "admin.sock"))
	}}}
	defer client.CloseIdleConnections()
	readHealth := func() string {
		response, err := client.Get("http://localhost/health")
		if err != nil {
			return ""
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	start := func(identity string, extra ...string) *exec.Cmd {
		args := append([]string{"run-snapshotter-test-process", "--root", filepath.Join(root, "store"), "--socket-dir", socketDir, "--instance-id", identity}, extra...)
		cmd := exec.Command(exe, args...)
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
	ready := func(identity string) {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if readHealth() == identity {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("adapter did not become ready")
	}
	stop := func(cmd *exec.Cmd) {
		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
			t.Fatal(err)
		}
		if err := cmd.Wait(); err != nil {
			t.Fatal(err)
		}
		client.CloseIdleConnections()
	}
	// An installation can start before it has created any workspaces.
	empty := start("empty")
	ready("empty")
	duplicate := start("duplicate")
	if err := duplicate.Wait(); err == nil {
		t.Fatal("duplicate owner succeeded")
	}
	if readHealth() != "empty" {
		t.Fatal("duplicate owner replaced the healthy listener")
	}
	stop(empty)

	first := start("first", "--clients", "a,b")
	ready("first")
	request, err := http.NewRequest(http.MethodPost, "http://localhost/retire?client=a", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatal(response.Status)
	}
	stop(first)

	restarted := start("restarted")
	ready("restarted")
	if _, err := os.Stat(filepath.Join(socketDir, "b.sock")); err != nil {
		t.Fatal("live client was not restored:", err)
	}
	if _, err := os.Stat(filepath.Join(socketDir, "a.sock")); !os.IsNotExist(err) {
		t.Fatal("retired client socket restored:", err)
	}
	stop(restarted)
}
