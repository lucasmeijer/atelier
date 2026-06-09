import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		promptPaths: [join(here, "prompts")],
	}));
}
