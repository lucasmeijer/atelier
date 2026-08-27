import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { atelierServerModule } from "../src/server/index.ts";

let dataHome: string;
let previousDataHome: string | undefined;

beforeEach(async () => {
  previousDataHome = process.env.XDG_DATA_HOME;
  dataHome = await mkdtemp(join(tmpdir(), "atelier-keypress-probe-test-"));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  await rm(dataHome, { recursive: true, force: true });
});

describe("keypress probe settings", () => {
  test("renders and updates explicit Off and On choices", async () => {
    const settings = atelierServerModule.settingsContributions![0]!;
    const initial = await settings.render();
    expect(initial).toContain('role="group" aria-label="Keylogging probe"');
    expect(initial).toContain('value="false" aria-pressed="true">Off</button>');
    expect(initial).toContain('value="true" aria-pressed="false">On</button>');

    const enabledBody = new FormData();
    enabledBody.set("enabled", "true");
    const enabledResponse = await settings.handleAction!({
      request: new Request("http://test/settings/keypress-probe", { method: "POST", body: enabledBody }),
      url: new URL("http://test/settings/keypress-probe"),
    });
    expect(await enabledResponse!.text()).toContain('value="true" aria-pressed="true">On</button>');

    const disabledBody = new FormData();
    disabledBody.set("enabled", "false");
    const disabledResponse = await settings.handleAction!({
      request: new Request("http://test/settings/keypress-probe", { method: "POST", body: disabledBody }),
      url: new URL("http://test/settings/keypress-probe"),
    });
    expect(await disabledResponse!.text()).toContain('value="false" aria-pressed="true">Off</button>');
  });
});
