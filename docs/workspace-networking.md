# Workspace networking

## Security boundary

Atelier is a single-user application intended to run inside a trusted network, such as a Tailnet. Workspace-app links are not secrets and do not have independent authentication: anyone who can reach one through the deployment network boundary can use it. Operators are responsible for ensuring that Atelier and its managed app-origin range are not unintentionally public.

Atelier uses one networking model for workspace app ports:

```text
workspace gateway:2999 -> published on host 127.0.0.1:<allocated-port>
Atelier -> gateway -> workspace 127.0.0.1:<requested-app-port>
```

Workspace containers publish only their authenticated gateway port on the Docker host loopback interface. Atelier allocates and pins that host port in Docker’s container configuration, so both controlled and automatic restarts retain the same ingress endpoint. VS Code and browser previews both use that gateway. Atelier never connects to workspace container IPs, Docker DNS names, Docker bridge addresses, or `host.docker.internal` for workspace app ingress.

## Supported shapes

Docker-on-macOS is not a supported deployment shape for this model. Docker Desktop's host networking is not equivalent to Linux host networking: it lets a container reach services in the Docker Desktop Linux VM host namespace, but it does not reliably expose services listening in that host-networked container back to the macOS host, and Docker discards `-p` port publishing when `--network host` is used. Supporting Docker-on-macOS would require an additional UI forwarding sidecar or a separate `host.docker.internal`-based workspace access path, which would reintroduce the split networking model this design avoids.

### Atelier as a host app on macOS

No special networking setup is required:

```text
Atelier on macOS -> 127.0.0.1:<published-port> -> Docker Desktop port forward -> workspace container
```

Docker Desktop forwards published container ports from the macOS host into its Linux VM. The workspace container's private Docker IP is not reachable from macOS, so published loopback ports are the portable address.

### Atelier in Docker on Linux

Run the Atelier container with host networking:

```sh
docker run --network host ... atelier:latest
```

Then `127.0.0.1` inside the Atelier container is the host network namespace:

```text
Atelier container -> 127.0.0.1:<published-port> -> workspace container
```

Do not run the Atelier container on Docker's default bridge network for this model. In that case `127.0.0.1` would be the Atelier container itself, not the Docker host.

### Atelier in an Atelier workspace

An Atelier development server in a workspace uses that workspace's nested Docker daemon. Its inner workspace gateway ports are still published on the surrounding workspace's loopback interface, so the inner server can reach them normally.

Browser-facing app identity is independent from an active listener. A stable canonical app link retains a logical browser-origin assignment while listeners and external publication are leased only while the app is active. Origin assignments are never transferred to another app, preventing stale addresses and browser storage from crossing app identities. In a nested Atelier, the inner ingress leases a local origin reachable through the surrounding workspace’s gateway and redirects through that workspace's canonical app route. The outer ingress then supplies the browser-reachable origin. This preserves root-relative URLs and WebSockets without keeping inactive listeners or externally published resources alive.

Browser navigation carries its target origin in a query parameter scoped to the owning Browser view (`atelierBrowserOrigin.browser-<uuid>`). Each browser proxy reads and removes only its own parameter. Routing metadata for an inner Browser passes through the outer Browser unchanged, so an inner target port cannot retarget the surrounding workspace’s preview. Initial URLs and rewritten redirects use the same encoding.

## Workspace gateway

A small Go binary, `/usr/local/bin/atelier-workspace-gateway`, runs as the workspace container's main process after initialization, under Docker's `--init` signal-forwarder and child-process reaper. It binds port **2999**, writes the startup readiness marker only after binding, and exits with the container. Stopping or restarting a workspace stops or restarts its gateway; gateway failure terminates the container rather than silently leaving previews broken. Docker's existing restart policy applies.

Workspace web apps can use **any TCP port from 1 through 65535 except 2999**, including privileged ports and services bound only to IPv4 loopback (`127.0.0.1`). The gateway always connects to `127.0.0.1:<port>` inside the workspace. It never resolves a caller-supplied hostname or routes to another container, the Docker host, or the internet. This is web-app ingress, not general-purpose TCP/UDP publishing. Only explicitly requested app routes are exposed; services are not scanned or automatically published.

Ingress sends the destination port, HTTP/HTTPS protocol, app Host, and a per-workspace credential in reserved `X-Atelier-Gateway-*` headers. Browser-supplied values are removed and replaced with trusted routing metadata. The gateway authenticates and validates the request, strips its metadata and proxy credentials, then forwards it using Go's standard reverse proxy. App authorization, streaming, and WebSocket upgrades are preserved. Ingress applies the workspace app-port Host policy and narrow redirect/cookie translation described below. HTTPS upstreams require certificates trusted by the gateway; certificate verification is not disabled.

The credential is generated at workspace creation, stored in a mode-0600 host-side workspace file, and copied to `/etc/atelier-workspace-gateway-token` inside the container. It is not an environment variable, URL parameter, or browser credential. Workspaces already allow privileged/root access, so this protects gateway access from other network callers, not from code executing inside that same workspace.

### Localhost-compatible app previews

All workspace HTTP apps use one local-origin policy, with no per-app settings:

- `Host` and `X-Forwarded-Host` are `localhost:<app-port>`.
- `X-Forwarded-Proto` and `X-Forwarded-Port` describe the actual local app target.
- The RFC `Forwarded` header is removed so it cannot contradict those values.
- For HTTP and WebSockets, an `Origin` exactly matching the receiving preview
  origin is translated to the local app origin. Foreign, opaque (`null`), and
  missing Origins, and `Referer`, are unchanged.

This gives frameworks checking Host and frameworks checking forwarded headers
one consistent view. Next.js Server Actions and Webpack's Host/Origin checks both
work with this policy. No framework detection or alternate-host retries are used.

The browser keeps its public preview URL. Atelier carries that identity separately
in `X-Atelier-Public-Origin` for nested routing and response adaptation. Public
ingress derives it from the canonical app lease and overwrites caller-supplied
metadata. `X-Atelier-Origin-Context` carries the same-origin decision between
nested hops, preventing a foreign Origin that happens to name an intermediate
localhost address from becoming same-origin. Nested metadata comes from the
surrounding trusted Atelier ingress, like the existing parent-routing metadata.

Local `Location` headers are mapped back only for the current app's protocol and
port; redirects cannot publish other services. Explicit local cookie domains
become host-only. For translated requests, matching `Access-Control-Allow-Origin`
and `Timing-Allow-Origin` values are mapped back, with `Vary: Origin` preserved or
added. Bodies, unrelated origins, wildcard values, and other cookie/CORS attributes
are unchanged.

Source-edit reloads were verified with React/Vite, SvelteKit, Next.js, and Webpack.
Webpack's separate generated-URL issue remains: its client embeds the workspace
port and needs a socket-URL hint to reach the public preview port. Header
translation does not rewrite URLs embedded in HTML or JavaScript.

### Bun transport and environment proxies

Bun 1.4's `fetch` honors `NO_PROXY` even with an explicit proxy, and an empty `proxy` string does not suppress `HTTP_PROXY`. Ingress therefore uses the gateway URL as both the HTTP destination and explicit proxy. Whether Bun sends an origin-form request directly or an absolute-form proxy request, it reaches the **same authenticated gateway**. The gateway ignores the URL authority when choosing an upstream and uses only the validated local-port metadata. A separate app-Host header preserves the intended Host in both forms. No global environment changes are needed.

Bun WebSockets connect directly to the gateway with routing headers and no proxy; unlike `fetch`, that client does not implicitly select an environment proxy. Go handles the app-side HTTP or HTTPS upgrade. There is no CONNECT handshake in this gateway protocol.

The gateway preserves raw query strings, including semicolons, leaving query parsing to the app. Transport failures carry a reserved `X-Atelier-Gateway-Error: upstream` response marker; the gateway strips this marker from app responses. Ingress consumes marked failures, retries GET/HEAD startup requests, and records persistent failures in ingress status. Application-generated 502 responses pass through without retries.

### Existing workspaces and verification

Workspaces created with older images must be recreated to gain the gateway. There is deliberately no legacy port-publishing fallback or live-container migration. A missing published gateway produces an actionable error.

Run `bun run test:gateway` with Go 1.26+ installed for the real Bun-ingress/Go-gateway protocol integration. It covers both bypass-all and bypass-none proxy environments, streaming uploads, SSE and cancellation, text/binary WebSockets, subprotocols, cookies, authentication, and shutdown. Go tests also cover HTTPS trust, invalid destinations, connection errors, and credential isolation. The image build runs the Go tests before compiling a static binary in a separate build stage; Go is not installed in the workspace runtime image.

## Remote HTTPS

When Atelier is reached over HTTPS, every active browser-origin port must also be reachable with a trusted HTTPS certificate. The supported automatic configuration uses `ATELIER_TAILSCALE_SERVE=1` with an HTTPS `ATELIER_PUBLIC_URL`; Atelier publishes and retracts active origins through Tailscale Serve. An operator using another trusted-network reverse proxy must equivalently terminate HTTPS and forward the managed origin range (41000–41999 by default) to the same local ports. Publishing only Atelier's main port is insufficient because each app origin intentionally has a separate browser origin.

## Why not container IPs?

Container IPs are not a portable control-plane address.

On native Linux, Docker creates real host bridge interfaces and host routes such as `172.17.0.0/16 dev docker0`. A host process can often connect directly to an unpublished container IP.

On Docker Desktop for macOS, Linux containers and their bridge networks live inside a hidden Linux VM. The macOS host does not have a route to those container subnets. Docker documents this as a known limitation: the Docker bridge network is not reachable from the macOS host, and per-container IP addressing is not available from macOS.

Relying on container IPs would therefore work on Linux and fail on macOS.

## Why not Docker bridge-published ports?

Binding ports to Docker bridge interfaces is Linux-specific and interacts with host firewalls. On a locked-down Linux host, UFW may block traffic from containers to host-bound bridge addresses unless explicit rules are installed. Docker Desktop for macOS also cannot bind host ports to the Linux VM's bridge gateway address from the macOS host.

That makes bridge addresses a poor default for workspace app ingress.

## Experiments

We tested with small `nginx:alpine` workspace-like containers on:

- macOS with Docker Desktop, Docker server 29.4.1
- Linux host `atelier-1`, Docker 29.1.3, UFW active

Observed results:

| Experiment | macOS Docker Desktop | Linux `atelier-1` |
| --- | --- | --- |
| Host app connects to unpublished container IP | failed / timed out | succeeded |
| Container on same Docker network connects to unpublished port | succeeded | succeeded |
| Host app connects to `127.0.0.1:<published-port>` | succeeded | succeeded |
| Default-network container connects back to host-published port | platform/firewall-dependent | failed with UFW |
| Host app connects to port bound on Docker bridge address | not available | succeeded |
| Container connects to port bound on Docker bridge address | not portable | failed with UFW |
| Host-networked Atelier-like container connects to `127.0.0.1:<published-port>` | not the target shape | succeeded |

The host-networked Linux test also created the workspace-like container through the Docker socket from inside an Atelier-like container, then connected back to its loopback-published port through `127.0.0.1`.

## Consequence

Workspace app ingress has no Atelier runtime knob. The constants are:

```text
publish host: 127.0.0.1
connect host: 127.0.0.1
```

The deployment invariant is external:

```text
If Atelier runs in Docker on Linux, run it with --network host.
```
