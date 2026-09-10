# Portability fix: before/after performance

2026-09-10 · supplied ARM64 SSH host · Docker/buildx harness, not full Atelier app startup.

## Verdict

**Cold runtime acquisition improved, but warm creation regressed materially—most
severely under concurrency.** The fix preserves zero warm layer downloads and
extraction, but its additional temporary-snapshot and durable metadata operations
are expensive. Performance optimization is not finished.

## End-to-end results

Seconds; medians. Both versions run the same real Atelier image: 23 chain steps,
21 distinct compressed blobs, 1,838,086,022 layer bytes. Ordinary creation measures
fresh outer Docker/containerd provisioning → cached build/push → private pull →
child HTTP readiness. Nested readiness instead ends when the nested Docker daemon
and its fixture HTTP endpoint are ready.

| Scenario | Samples per version | Before | After | Change |
| --- | ---: | ---: | ---: | ---: |
| Runtime-cold, builder/registry warm | 2 | 55.956 | 40.274 | −28.0% |
| Fresh warm client, original owner alive | 6 | 2.213 | 3.056 | +38.1% |
| Fresh warm client after all owners deleted | 4 | 2.243 | 2.964 | +32.1% |
| Changed COPY input, expensive ancestry cached | 4 | 2.465 | 3.272 | +32.7% |
| Nested Docker + fixture HTTP ready | 2 | 2.754 | 3.640 | +32.2% |
| Four concurrent creations, per-client latency | 8 (2 batches) | 3.121 | 7.164 | +129.5% |
| Eight concurrent creations, per-client latency | 16 (2 batches) | 5.864 | 15.208 | +159.3% |
| Fresh warm client after adapter restart | 1 | 2.244 | 3.109 | +38.5% |

Ordinary warm ranges were **2.179–2.252 s before** and **3.043–3.115 s after**.
Eight-way client ranges were **3.838–5.948 s before** and **11.810–15.810 s after**.
Samples within a concurrent batch are correlated; these are descriptive medians,
not independent samples establishing reliable tail percentiles.

The cold improvement repeated in reverse order: before **55.234–56.678 s**, after
**39.771–40.777 s**. This is not the original experiment's ~100 s first-use number:
that included a first real-image build. Here BuildKit and registry were already
populated. Host page caches were not flushed.

### Pull phase

| Scenario | Before | After |
| --- | ---: | ---: |
| Runtime-cold | 53.366 | 37.490 |
| Warm owner alive | 0.411 | 1.282 |
| Warm after deletion | 0.402 | 1.142 |
| Incremental COPY | 0.545 | 1.318 |
| Nested | 0.432 | 1.300 |
| Four concurrent clients | 0.835 | 4.757 |
| Eight concurrent clients | 1.702 | 11.439 |

The extra warm latency is predominantly in pull, not cached build or provisioning.

### Concurrent batch completion

Whole-batch makespans include registration and post-readiness verification, unlike
per-client creation wall times. They exclude batch cleanup.

| Concurrency | Before, two batches | After, two batches |
| --- | --- | --- |
| 4 | 3.529 s, 3.289 s | 7.329 s, 7.348 s |
| 8 | 6.095 s, 6.170 s | 15.442 s, 16.019 s |

## Other scenarios

- **Park/resume:** uninterrupted resume to child readiness was 1.268/1.319 s
  before and 1.255/1.231 s after: no meaningful regression in this small sample.
  Parking itself took about 10.3 s in both versions. This real-image Python HTTP
  fixture incurs Docker's child stop timeout; do not compare that with the older
  small-fixture ~0.3 s park result. Private filesystem and bind markers survived.
- **Adapter restart:** health-ready in 0.071 s in each version (one sample each,
  coarse polling boundary). The existing child continued serving while the adapter
  was stopped. Fresh-client creation after restart is in the main table.
- **Concurrent cold miss:** two pre-provisioned clients pulled a new 32 MiB layer
  over 23 warm chains. Batch pull took **0.837 s before → 2.523 s after**. Both
  versions downloaded the payload twice (~67.13 MB combined), extracted it twice
  and converged on one retained chain. Both clients' file checksums matched.
  In-flight work deduplication remains unsolved.
- **Real-image export:** the fixed version streamed **1,838,130,688 archive bytes
  in 92.659 s**, approximately **19.8 MB/s**. The consumer counted bytes and hashed
  the stream rather than writing another large file to the nearly full disk.
  This includes Docker exec transport and SHA-256 consumer overhead. There is no
  valid before-speed ratio: the earlier warm export was incomplete. Offline
  portability validation remains the separate [portability check](PORTABILITY.md),
  not an assertion inferred from this timing run.
- **Storage:** after the warm/incremental/race suite, the shared content store held
  1,871,912,960 allocated bytes and OverlayFS backing held 5,671,780,352 bytes.
  These include modified/race images, are shared across clients, and exclude the
  separate registry and BuildKit caches. The large benchmark backing was removed
  after evidence capture.

## Why warm creation regressed

The logs confirm **zero registry layer GETs** across all measured warm-owner,
after-deletion, nested and 4-/8-way warm-creation windows. Every such client reused
all **23 chains** in both versions. The fixed path is not secretly downloading or
extracting the whole image.

The difference is the work required to reach reuse:

| Representative single-client warm pull | Before | After |
| --- | ---: | ---: |
| Early alias reuse | 23 | 0 |
| Temporary image snapshot prepares | 0 | 23 |
| Cached diff reuse | 0 | 23 |
| Image snapshot commits | 0 | 23 |
| Total Prepare RPC duration | 100 ms | 340 ms |
| Total Commit RPC duration | none | 342 ms |
| Total cached Apply RPC duration | none | 7 ms |

These request-duration totals are from `before-w10-0` and `after-w11-0`, restricted
to their pull windows. They are not exclusive CPU times. Shared-content Info RPCs
in that after sample totaled only ~1.4 ms. The snapshot transaction path adds about
**0.58 s** of RPC duration in this representative pull, consistent with the extra
physical snapshot operations, journaling/fsync and shared metadata lock contention.
This is strong diagnostic evidence, not a CPU/lock profile isolating every cost.

Incremental trials preserved 21 chains and created two new chains in both versions.
Before fetched two tiny layer blobs (~430 bytes); after fetched one or two
(~163–431 bytes), depending on compressed-content reuse. That small byte saving
was outweighed by the metadata overhead on the 21 reused chains.

**Next optimization target:** preserve complete content registration, but avoid
allocating and journaling disposable physical snapshots on a verified cache hit.
The same matrix should be rerun after that change. Do not recover speed by returning
to incomplete image metadata or archives.

## Method, controls and limits

- Before is branch commit `f3cc5137`; after is the portability fix in this change
  (measured before it was committed).
  Both adapter binaries were cross-compiled with the same local Go toolchain.
  Binary SHA-256 values are in the raw environment record.
- Host: 8 ARM64 Neoverse-N1 vCPUs, approximately 15 GiB RAM, ext4; Docker 29.1.3,
  standalone containerd 2.2.2. Existing Atelier containers remained running.
- The original experiment's image, Docker binaries, contexts, child HTTP fixture
  and cached BuildKit were reused. The adapter and matching private daemon
  configuration were the comparison variable; builder/registry routing was held
  constant. This is not a full installed Atelier/agent/gateway startup benchmark.
- Cold runs used isolated empty benchmark backing/content, in before/after then
  after/before order. Warm tests used common retained image backing and alternating
  before/after/after/before blocks. No clients survived mode switches.
- Only benchmark-owned backing was deleted. No host cache drop or system-wide
  prune was performed. Free disk was about 8.2 GB before population and ~1 GB
  during warm tests. Both variants therefore ran under the same tight-space
  conditions; absolute timings should not be generalized to other storage.
- Client registration is outside per-client creation timing. Diagnostic capture
  and cleanup are outside creation timings. Debug/RPC logging is enabled in both
  versions and its overhead is included.
- A first harness attempt reused client IDs between 4- and 8-way batches and was
  correctly rejected by retirement tombstones. That partial block was excluded.
  The corrected paired runs carry `run: balanced-v2`; the two initial valid cold
  trials were retained. Raw failed-attempt evidence is not hidden.
- Concurrent registry windows overlap. Zero warm bytes is safe to establish from
  every window; nonzero cold-race transfer is counted once across the whole batch.
- No 30-client run, small-image repeat, full nested Atelier app, first push to an
  empty registry throughput test, or preloaded-default startup timing was included.
  See the [scenario matrix](PERFORMANCE.md) for the wider performance contract.

## Reproduction and evidence

The completed run is under `/root/docker-perf-comparison` on the SSH host:

- `compare.py`: paired cold/warm/incremental/nested/concurrent/lifecycle/export run;
- `supplement.py`: restart and simultaneous cold-layer checks;
- `cold-repeat.py`: reverse-order cold trials;
- `analyze.py`, `measurements.jsonl`, `summary.json`: raw records and analysis;
- `logs/`, `results/`, `harness/`: service logs, state captures and fixtures.

The harness depends on the original fixtures and pinned binaries under
`/root/docker-snapshotter`, plus its existing registry and cached BuildKit. It is
an explicit experimental-host runner, not a portable one-command benchmark suite.

A workspace-independent copy is retained under
`/persistent/docker-rewrite-evidence/performance/`, including the evidence archive
and machine-readable summary. The old registry/BuildKit containers were returned
to their original stopped state after the measurements.
