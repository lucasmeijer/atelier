import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const assetManifestSchema = Type.Record(Type.String(), Type.String());

export type AssetManifest = Static<typeof assetManifestSchema>;

export function parseAssetManifest(source: string): AssetManifest {
  return Value.Parse(assetManifestSchema, JSON.parse(source));
}
