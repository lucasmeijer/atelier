import { repository } from "./constants.ts";

export type ReleaseChannel = "stable" | "latest";

export function isReleaseChannel(value: string | undefined): value is ReleaseChannel {
  return value === "stable" || value === "latest";
}

export function targetImageForChannel(channel: ReleaseChannel): string {
  return `ghcr.io/${repository}:${channel}`;
}
