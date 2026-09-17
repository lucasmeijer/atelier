export const hostDiagnosticGroups = [
  { name: "CPU", rows: [
    { id: "cpuUsage", label: "Usage", context: "1s sample" },
    { id: "cpuThrottling", label: "Throttling", context: "during sample" },
  ] },
  { name: "Memory", rows: [
    { id: "memoryUsage", label: "Used / limit", context: "effective capacity" },
    { id: "memoryHeadroom", label: "Headroom", context: "limit minus usage" },
    { id: "swapUsage", label: "Swap", context: "used" },
    { id: "memoryStalls", label: "Stalls", context: "last 10s" },
    { id: "oomKills", label: "OOM kills", context: "since System start" },
  ] },
  { name: "Storage", rows: [
    { id: "diskSpace", label: "Disk space", context: "/data" },
    { id: "diskInodes", label: "Inodes", context: "/data" },
  ] },
] as const;

export type HostMetricId = typeof hostDiagnosticGroups[number]["rows"][number]["id"];
