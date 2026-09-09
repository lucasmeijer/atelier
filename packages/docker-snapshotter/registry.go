package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"path/filepath"
)

// Docker and BuildKit speak TCP to registries. Keep the owner-side bridge on
// loopback; inherited clients still receive only the registry's Unix socket.
func registryBridge(root, socket string) (*http.Server, net.Listener, error) {
	path := filepath.Join(root, "registry-address")
	address := "127.0.0.1:0"
	saved, err := os.ReadFile(path)
	if err == nil {
		address = string(saved)
		host, port, err := net.SplitHostPort(address)
		if err != nil || host != "127.0.0.1" || port == "0" {
			return nil, nil, fmt.Errorf("invalid persisted registry address %q", address)
		}
	} else if !os.IsNotExist(err) {
		return nil, nil, err
	}
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(path+".tmp", []byte(listener.Addr().String()), 0600); err != nil {
		listener.Close()
		return nil, nil, err
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		listener.Close()
		return nil, nil, err
	}
	proxy := &httputil.ReverseProxy{
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}},
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "http"
			r.Out.URL.Host = "localhost"
			r.Out.Host = "localhost"
			r.Out.URL.RawQuery = r.In.URL.RawQuery
		},
	}
	return &http.Server{Handler: proxy}, listener, nil
}
