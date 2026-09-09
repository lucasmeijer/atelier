package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistryBridgePreservesUploadsAndAddress(t *testing.T) {
	root := t.TempDir()
	socket := filepath.Join(root, "registry.sock")
	backend := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" || r.URL.RawQuery != "state=a;b" {
			t.Error("registry request changed", r.Method, r.URL.String())
		}
		w.Header().Set("Location", "/v2/image/blobs/uploads/id?state=next")
		w.WriteHeader(202)
		io.Copy(w, r.Body)
	}))
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	backend.Listener = listener
	backend.Start()
	defer backend.Close()
	bridge, tcp, err := registryBridge(root, socket)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	go bridge.Serve(tcp)
	address := tcp.Addr().String()
	request, err := http.NewRequest("PATCH", "http://"+address+"/v2/image/blobs/uploads/id?state=a;b", strings.NewReader("compressed layer bytes"))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 202 || string(body) != "compressed layer bytes" || response.Header.Get("Location") != "/v2/image/blobs/uploads/id?state=next" {
		t.Fatal("registry response changed", response.Status, string(body))
	}
	if _, _, err := registryBridge(root, socket); err == nil {
		t.Fatal("occupied address was silently replaced")
	}
	bridge.Close()
	restarted, replacement, err := registryBridge(root, socket)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	defer replacement.Close()
	if replacement.Addr().String() != address {
		t.Fatal("registry address changed after restart")
	}
}
