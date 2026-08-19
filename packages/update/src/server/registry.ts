import { type ReleaseChannel } from "./channels.ts";
import { repository } from "./constants.ts";
import type { HttpFetcher } from "./http.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export interface ImageMetadata { digest: string; revision?: string; platformDigest?: string; selfUpdateCompatibility?: string }

interface RegistryAuth { realm: string; service?: string; scope?: string }

const registryTokenResponseSchema = Type.Object({
  token: Type.Optional(Type.String()),
  access_token: Type.Optional(Type.String()),
});

const registryIndexSchema = Type.Object({
  manifests: Type.Array(Type.Object({
    digest: Type.String(),
    platform: Type.Optional(Type.Object({
      os: Type.Optional(Type.String()),
      architecture: Type.Optional(Type.String()),
    })),
  })),
});

const registryImageManifestSchema = Type.Object({
  config: Type.Object({ digest: Type.String() }),
});

const registryManifestSchema = Type.Union([registryIndexSchema, registryImageManifestSchema]);

const registryConfigSchema = Type.Object({
  config: Type.Optional(Type.Union([
    Type.Object({
      Labels: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
    }),
    Type.Null(),
  ])),
});

export function parseWwwAuthenticate(header: string): RegistryAuth | undefined {
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const out: RegistryAuth = { realm: "" };
  for (const part of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
    if (part[1] === "realm") out.realm = part[2];
    if (part[1] === "service") out.service = part[2];
    if (part[1] === "scope") out.scope = part[2];
  }
  return out.realm ? out : undefined;
}

async function authFetch(url: string, init: RequestInit = {}, fetcher: HttpFetcher = fetch): Promise<Response> {
  const response = await fetcher(url, init);
  if (response.status !== 401) return response;
  const auth = parseWwwAuthenticate(response.headers.get("www-authenticate") ?? "");
  if (!auth) return response;
  const tokenUrl = new URL(auth.realm);
  if (auth.service) tokenUrl.searchParams.set("service", auth.service);
  if (auth.scope) tokenUrl.searchParams.set("scope", auth.scope);
  const tokenResponse = await fetcher(tokenUrl, { headers: { accept: "application/json" } });
  if (!tokenResponse.ok) throw new Error(`registry token request failed: ${tokenResponse.status}`);
  const tokenJson = Value.Parse(registryTokenResponseSchema, await tokenResponse.json());
  const token = tokenJson.token ?? tokenJson.access_token;
  if (!token) throw new Error("registry token response did not include a token");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetcher(url, { ...init, headers });
}

function currentArch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

export function selectManifestFromIndex(index: Static<typeof registryIndexSchema>, platform = { os: "linux", architecture: currentArch() }): string {
  const manifest = index.manifests.find((candidate) => candidate.platform?.os === platform.os && candidate.platform?.architecture === platform.architecture);
  if (!manifest) throw new Error(`no ${platform.os}/${platform.architecture} manifest found`);
  return manifest.digest;
}

export async function fetchChannelImageMetadata(channel: ReleaseChannel, fetcher: HttpFetcher = fetch): Promise<ImageMetadata> {
  const manifestUrl = `https://ghcr.io/v2/${repository}/manifests/${channel}`;
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  let response = await authFetch(manifestUrl, { headers: { accept } }, fetcher);
  if (!response.ok) throw new Error(`registry manifest request failed: ${response.status}`);
  const rootDigest = response.headers.get("docker-content-digest") ?? "";
  const rootManifest = Value.Parse(registryManifestSchema, await response.json());
  let platformDigest: string | undefined;
  let imageManifest: Static<typeof registryImageManifestSchema>;
  if ("manifests" in rootManifest) {
    platformDigest = selectManifestFromIndex(rootManifest);
    response = await authFetch(`https://ghcr.io/v2/${repository}/manifests/${platformDigest}`, { headers: { accept } }, fetcher);
    if (!response.ok) throw new Error(`registry platform manifest request failed: ${response.status}`);
    imageManifest = Value.Parse(registryImageManifestSchema, await response.json());
  } else imageManifest = rootManifest;
  const configResponse = await authFetch(`https://ghcr.io/v2/${repository}/blobs/${imageManifest.config.digest}`, { headers: { accept: "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json" } }, fetcher);
  if (!configResponse.ok) throw new Error(`registry config request failed: ${configResponse.status}`);
  const labels = Value.Parse(registryConfigSchema, await configResponse.json()).config?.Labels ?? {};
  return {
    digest: platformDigest ?? rootDigest,
    platformDigest,
    revision: labels["org.opencontainers.image.revision"],
    selfUpdateCompatibility: labels["com.atelier.self-update-compatibility"],
  };
}
