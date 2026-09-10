# Docker runtime performance scenarios

This is the performance matrix for the private Docker runtimes, shared snapshotter,
content/diff services, and shared build/registry path. The correctness contract is
in [Observable behavior we care about](README.md#observable-behavior-we-care-about).
These scenarios are measurement targets, not latency SLAs.

## Scenarios

| Scenario | Setup and readiness boundary | What to measure/protect |
| --- | --- | --- |
| Cold first use | Fresh runtime backing/content; build and acquire an image, then run a child to HTTP readiness | Separate builder-cold from runtime-cold. Report build/push, pull, unpack and total wall time; transferred bytes and retained disk. |
| Fresh warm workspace, original owner alive | New private Docker/containerd metadata; image layers retained by another running workspace | Provision → cached build/push → pull → child HTTP-ready. No image-layer downloads or extraction; metadata work may scale with layer count. |
| Fresh warm workspace after owners are deleted | Remove containers, prune images, retire all earlier clients; create another client | Same readiness and reuse properties as the ordinary warm case; include private-data reclamation separately. |
| Incremental customization | Change COPY input while retaining expensive RUN/build ancestry | Re-solve the current context; acquire/extract only new layers/chains. Report reused/new chains, layer bytes, build/push, pull and total wall. |
| Nested creator | Warm image acquisition followed by another private gateway and Docker/containerd daemon becoming ready | Distinct readiness from ordinary child HTTP. Reuse the installation cache rather than copying an image store or creating another cache at each depth. |
| Concurrent warm creation | Simultaneously create multiple fresh clients against retained image layers | Per-client latency, slowest client, batch makespan and throughput at stated concurrency; verify zero layer download/extraction and watch shared metadata contention. |
| Concurrent cold miss | Multiple clients request the same unseen layer over warm ancestry | Total layer transfers, duplicate extraction, completion latency and retained-copy count. Correct convergence does not imply in-flight work deduplication. |
| Park/resume | Preserve a client's private state, stop its runtime, restart it and its child | Park latency and uninterrupted resume → child-ready latency; no image reacquisition, markers preserved. |
| Shared-service restart | Restart the adapter with retained images and an existing running child | Adapter readiness, child availability and fresh-client warm acquisition after restart. File reads must not depend on a live adapter. |
| Portable export/publication | Save a complete warm image or first-push it to an unrelated empty registry | Bytes and throughput for a complete image; validate offline load/run separately. Incomplete archives are failures, not faster results. |
| Preloaded default/dev startup | Start Atelier with its selected deterministic default already present | No redundant build/publication/pull. Measure separately from provisioning an image that is absent. |

Use both a small fixture and the real Atelier image: layer count and image size
stress different costs. The earlier real-image fixture has 23 chain steps and
21 distinct compressed layer blobs (about 1.84 GB).

## Measurement rules

- Measure uninterrupted wall time from request to the declared readiness boundary;
  do not sum independently reported phase medians.
- State which of builder, registry, runtime, private metadata and host page caches
  are cold. A runtime-cold pull is not a cold installation build.
- Report sample counts and spread. Small exploratory samples are not reliable tail
  percentiles or statistically conclusive wins.
- Compare the same image, host, Docker/containerd versions, logging, fixture,
  storage conditions and readiness boundary. Prefer alternating comparison blocks.
- Count registry layer response bytes separately from manifests/configs and from
  local socket traffic. Concurrent request windows overlap: count the batch once.
- Count actual diff reuse/extraction, not only snapshot creation. The portable path
  creates temporary snapshots even when it skips extraction.
- Separate retained shared compressed/unpacked storage from private daemon data
  and from BuildKit/registry copies. Include free disk and background workloads.
- Keep diagnostics and cleanup outside creation timings unless explicitly measuring
  cleanup. State whether client registration is included.
- These probes do not establish full Atelier app/agent readiness unless the actual
  application and agent startup are part of the measured boundary.

## Recorded runs

The original experiment's detailed timing tables lived on the experimental host
under `/root/docker-snapshotter/MEASUREMENTS.md` and `REPORT.md`, not in the source
tree. Before this document, the README listed reuse/lifecycle correctness scenarios
and the workspace-image README described caching behavior, but there was no complete
performance-specific matrix here.

The [2026-09-10 portability-fix comparison](PERFORMANCE-RESULTS.md) measures cold,
warm, deletion, COPY changes, nesting, 4-/8-way concurrency, restart, park/resume,
concurrent cold misses and export. It identifies a substantial warm/concurrent
regression despite retaining zero warm layer downloads and extraction.

The local-coordinator comparison repeats the controlled
ARM64 matrix against that portable baseline: warm creation improves 23% and
eight-way client latency improves 57%, with zero physical temporary warm image
snapshots and complete portable content.
