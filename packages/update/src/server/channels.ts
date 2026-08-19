import { repository } from "./constants.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const releaseChannelSchema = Type.Union([Type.Literal("stable"), Type.Literal("latest")]);

export type ReleaseChannel = Static<typeof releaseChannelSchema>;

export function isReleaseChannel(value: string | undefined): value is ReleaseChannel {
  return Value.Check(releaseChannelSchema, value);
}

export function targetImageForChannel(channel: ReleaseChannel): string {
  return `ghcr.io/${repository}:${channel}`;
}
