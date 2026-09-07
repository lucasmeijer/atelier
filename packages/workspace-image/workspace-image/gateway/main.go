// workspace-gateway is the sole published ingress into a workspace. It accepts
// authenticated HTTP requests (including WebSocket upgrades), never arbitrary
// network destinations. App ports are resolved inside the workspace namespace.
package main

import (
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Keep in sync with packages/shared/src/workspace-gateway.ts.
const gatewayPort = 2999
const hostHeader = "X-Atelier-Gateway-Host"
const tokenHeader = "X-Atelier-Gateway-Token"
const portHeader = "X-Atelier-Gateway-Port"
const protocolHeader = "X-Atelier-Gateway-Protocol"
const errorHeader = "X-Atelier-Gateway-Error"

func targetPort(value string) (int, error) {
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, errors.New("port must be a decimal integer")
		}
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 || port == gatewayPort {
		return 0, fmt.Errorf("port must be 1–65535, except reserved gateway port %d", gatewayPort)
	}
	return port, nil
}

func newGateway(token string, transport http.RoundTripper) http.Handler {
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1, // Preserve incremental responses, including SSE.
		Rewrite: func(r *httputil.ProxyRequest) {
			// ServeHTTP validates these before invoking the reverse proxy. Use In:
			// hop-by-hop removal may have removed client-supplied headers from Out.
			port, _ := targetPort(r.In.Header.Get(portHeader))
			// Routing never depends on the query; leave parsing to the app.
			// ReverseProxy otherwise removes values it cannot parse (e.g. semicolons).
			r.Out.URL.RawQuery = r.In.URL.RawQuery
			r.Out.URL.Scheme = r.In.Header.Get(protocolHeader)
			r.Out.URL.Host = net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
			r.Out.Host = r.In.Header.Get(hostHeader)
			r.Out.Header.Del(hostHeader)
			r.Out.Header.Del(tokenHeader)
			r.Out.Header.Del(portHeader)
			r.Out.Header.Del(protocolHeader)
			r.Out.Header.Del("Proxy-Authorization")
			// Ingress, not the gateway, owns browser-facing forwarding metadata.
			for _, name := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port"} {
				if values := r.In.Header.Values(name); len(values) > 0 {
					r.Out.Header[name] = append([]string(nil), values...)
				}
			}
		},
		ModifyResponse: func(r *http.Response) error {
			// Only gateway transport failures may carry this marker, not app 502s.
			r.Header.Del(errorHeader)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// Do not log request headers: they contain the workspace credential.
			log.Printf("upstream %s: %v", r.URL.Host, err)
			w.Header().Set(errorHeader, "upstream")
			http.Error(w, "Workspace app upstream error: "+err.Error(), http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.Header.Values(tokenHeader)) != 1 || subtle.ConstantTimeCompare([]byte(r.Header.Get(tokenHeader)), []byte(token)) != 1 {
			http.Error(w, "Workspace gateway authentication required", http.StatusUnauthorized)
			return
		}
		// Bun fetch may send absolute-form when explicitly proxying to this same
		// endpoint. The URL authority NEVER selects the destination: only the
		// validated port header does. This makes proxy bypass rules immaterial.
		if r.Method == http.MethodConnect || (r.URL.Scheme != "" && r.URL.Scheme != "http") {
			http.Error(w, "Expected an HTTP request", http.StatusBadRequest)
			return
		}
		if len(r.Header.Values(portHeader)) != 1 {
			http.Error(w, "Exactly one destination port is required", http.StatusBadRequest)
			return
		}
		if _, err := targetPort(r.Header.Get(portHeader)); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		host := r.Header.Get(hostHeader)
		origin, err := url.Parse("http://" + host)
		if len(r.Header.Values(hostHeader)) != 1 || host == "" || err != nil || origin.Host != host || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
			http.Error(w, "A valid app Host is required", http.StatusBadRequest)
			return
		}
		protocol := r.Header.Get(protocolHeader)
		if len(r.Header.Values(protocolHeader)) != 1 || (protocol != "http" && protocol != "https") {
			http.Error(w, "Destination protocol must be http or https", http.StatusBadRequest)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func main() {
	listen := flag.String("listen", fmt.Sprintf("0.0.0.0:%d", gatewayPort), "gateway listener (port 0 for protocol tests)")
	tokenFile := flag.String("token-file", "/etc/atelier-workspace-gateway-token", "workspace credential file")
	readyFile := flag.String("ready-file", "/.atelier/ready", "startup readiness marker")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("unexpected gateway arguments")
	}
	credential, err := os.ReadFile(*tokenFile)
	if err != nil {
		log.Fatal(err)
	}
	token := strings.TrimSpace(string(credential))
	if len(token) < 32 {
		log.Fatal("workspace gateway credential is too short")
	}
	transport := &http.Transport{
		// Deliberately no ProxyFromEnvironment: destinations are always local.
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		DisableCompression:    true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	server := &http.Server{
		Handler:           newGateway(token, transport),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	listener, err := net.Listen("tcp4", *listen)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*readyFile, []byte(listener.Addr().String()+"\n"), 0644); err != nil {
		log.Fatal(err)
	}
	log.Printf("workspace gateway ready on %s", listener.Addr())
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		// Container shutdown closes all connections, including hijacked WebSockets,
		// on process exit. Do not wait indefinitely for an app's stream to end.
		if err := server.Close(); err != nil {
			log.Printf("gateway shutdown: %v", err)
		}
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
