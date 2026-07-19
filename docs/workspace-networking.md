# Workspace networking

Atelier uses one networking model for workspace app ports:

```text
workspace container:<container-port> -> published on host 127.0.0.1:<allocated-port>
Atelier -> http://127.0.0.1:<allocated-port>
```

Workspace containers publish the supported app ports, such as VS Code and preview ports, on the Docker host loopback interface. Atelier never connects to workspace container IPs, Docker DNS names, Docker bridge addresses, or `host.docker.internal` for workspace app ingress.

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

An Atelier development server in a workspace uses that workspace's nested Docker daemon. Its inner workspace ports are still published on the surrounding workspace's loopback interface, so the inner server can reach them normally.

The browser-facing origin needs one additional rule. A workspace app normally redirects from its canonical route to a dedicated public proxy port in the `41000-41999` range. That inner port is not independently exposed through the outer Atelier. The outer app proxy therefore identifies its public origin and workspace to the inner Atelier. The inner Atelier listens for its app on an available outer preview port (`3001-3010`) and redirects through the outer workspace's canonical port route. The outer Atelier then supplies the browser-reachable isolated origin, preserving root-relative URLs and WebSockets.

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
