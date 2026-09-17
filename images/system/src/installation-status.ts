export type Activity = { description: string; percent?: number };
export type InstallationStatus = {
  state: "starting" | "ready" | "failed";
  activity: Activity;
  appUrl?: string;
  supervisorUrl?: string;
  action?: { description: string; url?: string };
  diagnostics?: { description: string; lines: string[] };
};

// This is System's public installation contract. Clients need no knowledge of
// Tailscale states, routes, startup phases, or where diagnostic output lives.
export function installationStatus(input: {
  activity: Activity;
  localMode?: boolean;
  localOrigin?: string;
  failure?: string;
  stopping: boolean;
  busy: boolean;
  appResponding: boolean;
  hostname?: string;
  appliedRoute: string;
  connectionState: string;
  authUrl?: string;
  logs: string[];
}): InstallationStatus {
  const { hostname, appliedRoute } = input;
  const localSupervisor = input.localOrigin?.replace("//atelier.", "//system.atelier.");
  const supervisorUrl = !input.localMode && hostname && appliedRoute.startsWith(`${hostname}:`)
    ? `https://${hostname}:8443` : localSupervisor;
  const ready = input.appResponding && !input.busy && !input.stopping && !input.failure &&
    (input.localMode ? !!input.localOrigin : !!hostname && appliedRoute === `${hostname}:3000`);
  const state = input.failure || input.stopping ? "failed" : ready ? "ready" : "starting";
  let action: InstallationStatus["action"];
  if (!input.localMode && input.connectionState === "NeedsMachineAuth") {
    action = {
      description: "Ask your Tailscale administrator to approve this server, then leave this installer running to continue.",
      url: "https://login.tailscale.com/admin/machines",
    };
  } else if (!input.localMode && input.authUrl && input.connectionState === "NeedsLogin") {
    action = {
      description: "Atelier uses Tailscale so only your devices can reach it. Sign in to connect securely.",
      url: input.authUrl,
    };
  }
  return {
    state,
    activity: state === "failed" ? { description: input.failure ?? "Atelier services stopped" }
      : ready ? { description: "Your Atelier is ready!" }
      : action ? { description: "Waiting for your private connection" }
      : input.appResponding && !input.busy ? { description: "Connecting Atelier securely" }
      : input.activity,
    appUrl: ready ? input.localMode ? input.localOrigin : `https://${hostname}` : undefined,
    supervisorUrl,
    action: state === "failed" ? undefined : action,
    diagnostics: state === "failed" ? {
      description: supervisorUrl ? "Open the supervisor for full logs and recovery options." : "The supervisor is not reachable over your private connection yet. Recent System logs:",
      lines: supervisorUrl ? [] : input.logs.slice(-12),
    } : undefined,
  };
}
