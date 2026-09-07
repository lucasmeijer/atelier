package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testToken = "a-workspace-specific-test-credential"

func appPort(t *testing.T, address string) string {
	t.Helper()
	u, err := url.Parse(address)
	if err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func appRequest(t *testing.T, method, path, port string, body io.Reader) *http.Request {
	t.Helper()
	r := httptest.NewRequest(method, path, body)
	r.Header.Set(hostHeader, "preview.example:41000")
	r.Header.Set(tokenHeader, testToken)
	r.Header.Set(portHeader, port)
	r.Header.Set(protocolHeader, "http")
	return r
}

func TestAuthenticationAndDestinationValidation(t *testing.T) {
	gateway := newGateway(testToken, http.DefaultTransport)
	cases := []struct {
		name   string
		change func(*http.Request)
		status int
	}{
		{"missing token", func(r *http.Request) { r.Header.Del(tokenHeader) }, 401},
		{"wrong token", func(r *http.Request) { r.Header.Set(tokenHeader, "wrong") }, 401},
		{"duplicate token", func(r *http.Request) { r.Header.Add(tokenHeader, testToken) }, 401},
		{"missing host", func(r *http.Request) { r.Header.Del(hostHeader) }, 400},
		{"invalid host", func(r *http.Request) { r.Header.Set(hostHeader, "host/path") }, 400},
		{"missing port", func(r *http.Request) { r.Header.Del(portHeader) }, 400},
		{"duplicate port", func(r *http.Request) { r.Header.Add(portHeader, "5173") }, 400},
		{"zero", func(r *http.Request) { r.Header.Set(portHeader, "0") }, 400},
		{"negative", func(r *http.Request) { r.Header.Set(portHeader, "-1") }, 400},
		{"overflow", func(r *http.Request) { r.Header.Set(portHeader, "65536") }, 400},
		{"huge", func(r *http.Request) { r.Header.Set(portHeader, strings.Repeat("9", 100)) }, 400},
		{"fraction", func(r *http.Request) { r.Header.Set(portHeader, "5173.5") }, 400},
		{"host injection", func(r *http.Request) { r.Header.Set(portHeader, "example.com:80") }, 400},
		{"gateway recursion", func(r *http.Request) { r.Header.Set(portHeader, strconv.Itoa(gatewayPort)) }, 400},
		{"protocol", func(r *http.Request) { r.Header.Set(protocolHeader, "file") }, 400},
		{"duplicate protocol", func(r *http.Request) { r.Header.Add(protocolHeader, "https") }, 400},
		{"non-HTTP absolute URL", func(r *http.Request) { r.URL, _ = url.Parse("ftp://example.com/") }, 400},
		{"CONNECT", func(r *http.Request) { r.Method = "CONNECT" }, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := appRequest(t, "GET", "/", "5173", nil)
			tc.change(r)
			w := httptest.NewRecorder()
			gateway.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d", w.Code, tc.status)
			}
		})
	}
	for _, value := range []string{"1", "80", "443", "5173", "8000", "65535"} {
		if _, err := targetPort(value); err != nil {
			t.Fatalf("valid port %s rejected: %v", value, err)
		}
	}
}

func TestForwarding(t *testing.T) {
	payload := strings.Repeat("request-body", 10000)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "preview.example:41000" {
			t.Errorf("Host lost: %s", r.Host)
		}
		if r.RequestURI != "//path/a%2Fb?q=a%2Bb" {
			t.Errorf("URL changed: %s", r.RequestURI)
		}
		for _, key := range []string{hostHeader, tokenHeader, portHeader, protocolHeader, "Proxy-Authorization", "X-Hop"} {
			if r.Header.Get(key) != "" {
				t.Errorf("private/hop header leaked: %s", key)
			}
		}
		if r.Header.Get("Authorization") != "Bearer app-token" {
			t.Error("app auth lost")
		}
		if r.Header.Get("Cookie") != "session=app" {
			t.Error("app cookie lost")
		}
		if r.Header.Get("X-Forwarded-Host") != r.Host || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Error("forwarded metadata lost")
		}
		if r.Header.Get("X-Atelier-Parent-Origin") != "https://outer.example" {
			t.Error("nested metadata lost")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Set-Cookie", "result=ok")
		w.Header().Set("Location", "/unchanged")
		w.WriteHeader(307)
		if _, err := w.Write(body); err != nil {
			t.Error(err)
		}
	}))
	defer app.Close()
	r := appRequest(t, "POST", "//path/a%2Fb?q=a%2Bb", appPort(t, app.URL), strings.NewReader(payload))
	r.Host = "preview.example:41000"
	r.Header.Set("Authorization", "Bearer app-token")
	r.Header.Set("Proxy-Authorization", "must-not-leak")
	r.Header.Set("Cookie", "session=app")
	r.Header.Set("X-Forwarded-Host", r.Host)
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Atelier-Parent-Origin", "https://outer.example")
	r.Header.Set("Connection", "X-Hop")
	r.Header.Set("X-Hop", "remove")
	w := httptest.NewRecorder()
	newGateway(testToken, http.DefaultTransport).ServeHTTP(w, r)
	if w.Code != 307 || w.Body.String() != payload || w.Header().Get("Location") != "/unchanged" || w.Header().Get("Set-Cookie") != "result=ok" {
		t.Fatalf("response changed: %d %v", w.Code, w.Header())
	}
}

func TestHTTPS(t *testing.T) {
	app := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "secure") }))
	defer app.Close()
	r := appRequest(t, "GET", "/", appPort(t, app.URL), nil)
	r.Header.Set(protocolHeader, "https")
	// Trust this test's certificate, without disabling verification.
	w := httptest.NewRecorder()
	newGateway(testToken, app.Client().Transport).ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "secure" {
		t.Fatalf("HTTPS failed: %d %s", w.Code, w.Body)
	}
	// The production transport does not silently accept self-signed certificates.
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	w = httptest.NewRecorder()
	newGateway(testToken, transport).ServeHTTP(w, r)
	if w.Code != 502 {
		t.Fatalf("untrusted TLS accepted: %d", w.Code)
	}
}

func TestStreamingAndCancellation(t *testing.T) {
	cancelled := make(chan struct{})
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(cancelled)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer app.Close()
	gateway := httptest.NewServer(newGateway(testToken, http.DefaultTransport))
	defer gateway.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, "GET", gateway.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header = appRequest(t, "GET", "/", appPort(t, app.URL), nil).Header
	response, err := gateway.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	chunk := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(response.Body, chunk); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(chunk, []byte("data: first\n\n")) {
		t.Fatal("stream changed")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not reach app")
	}
}

func TestUnavailableApp(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	listener.Close()
	w := httptest.NewRecorder()
	newGateway(testToken, http.DefaultTransport).ServeHTTP(w, appRequest(t, "GET", "/", port, nil))
	if w.Code != 502 || w.Header().Get(errorHeader) != "upstream" {
		t.Fatalf("expected marked connection failure, got %d %v", w.Code, w.Header())
	}
}

func TestRawQueryPreservation(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, r.URL.RawQuery)
	}))
	defer app.Close()
	for _, query := range []string{"value=a;b&keep=yes", "z=2&a=%ZZ&keep=yes", "x=a%20b&x=a+b&x=%2F"} {
		w := httptest.NewRecorder()
		newGateway(testToken, http.DefaultTransport).ServeHTTP(w, appRequest(t, "GET", "/?"+query, appPort(t, app.URL), nil))
		if w.Code != 200 || w.Body.String() != query {
			t.Fatalf("query %q changed: %d %q", query, w.Code, w.Body.String())
		}
	}
}

func TestAppCannotForgeGatewayError(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(errorHeader, "upstream")
		http.Error(w, "application failure", http.StatusBadGateway)
	}))
	defer app.Close()
	w := httptest.NewRecorder()
	newGateway(testToken, http.DefaultTransport).ServeHTTP(w, appRequest(t, "GET", "/", appPort(t, app.URL), nil))
	if w.Code != 502 || w.Header().Get(errorHeader) != "" || w.Body.String() != "application failure\n" {
		t.Fatalf("app response changed or forged gateway error survived: %d %v %q", w.Code, w.Header(), w.Body.String())
	}
}
