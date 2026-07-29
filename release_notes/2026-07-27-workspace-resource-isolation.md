# Workspace workloads can no longer starve Atelier

Production installs now place every workspace container in one cgroup resource pool. No matter how many workspaces are running, the pool leaves 2 GiB of memory and one logical CPU outside workspace use for Atelier and the host. Workspace swap and runaway task counts are also bounded, while lower workspace CPU and I/O weights keep the interface responsive under contention.

The Atelier server itself now receives protected memory, increased CPU priority, and OOM protection. These settings are retained when Atelier updates itself.

Rerun the Atelier installer to create the resource pool and apply the server protections. The installer now rejects cgroup v1 and hosts without the required systemd resource controllers instead of installing without guarantees. Workspaces created after that install automatically join the pool.
