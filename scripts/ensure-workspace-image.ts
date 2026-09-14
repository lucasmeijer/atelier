#!/usr/bin/env bun
import { ensureDefaultWorkspaceImage } from "@atelier/workspace-image";
if (process.argv.length !== 2) throw new Error("usage: bun scripts/ensure-workspace-image.ts (uses the selected Docker context)");
console.log(await ensureDefaultWorkspaceImage({ buildOutput: "inherit" }));
