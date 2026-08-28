import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { renderTranscriptionComposerControl } from "../../../packages/transcription/src/server/composer.ts";

let browser: Browser;
let browserContext: BrowserContext;
let workspaceClient: string;
let composerStyle: string;

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "apps/web/scripts/build-assets.ts"], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exitCode !== 0) throw new Error(`workspace client build failed:\n${stdout}${stderr}`);
  // SAFETY: The generated asset manifest establishes a string path for the workspace entrypoint.
  const manifest = await Bun.file(new URL("../public/assets-manifest.json", import.meta.url)).json() as Record<string, string>;
  workspaceClient = await Bun.file(new URL(`../public${manifest["/workspace.js"]}`, import.meta.url)).text();
  const styles = await Promise.all([
    Bun.file(new URL("../public/design-system.css", import.meta.url)).text(),
    Bun.file(new URL("../../../packages/agent/src/client/style.css", import.meta.url)).text(),
    Bun.file(new URL("../../../packages/transcription/src/client/style.css", import.meta.url)).text(),
  ]);
  composerStyle = styles.join("\n");
  const executablePath = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/local/bin/chromium";
  browser = await chromium.launch({ executablePath, headless: true });
  browserContext = await browser.newContext();
});

afterAll(async () => {
  await browserContext?.close();
  await browser?.close();
});

describe("transcription composer browser behavior", () => {
  test("shows transcription errors outside the Composer without clipping them", async () => {
    const page = await browserContext.newPage();
    const errorControl = renderTranscriptionComposerControl()
      .replace('data-state="idle"', 'data-state="error"')
      .replace(">Dictate</span>", ">Microphone access denied</span>");
    await page.setContent(`<style>${composerStyle}</style><div class="composer" style="margin-top:100px"><div class="composer-surface"><form><div class="composer-input-area"><textarea class="composer-input"></textarea>${errorControl}</div></form></div></div>`);

    const surfaceBox = await page.locator(".composer-surface").boundingBox();
    const status = page.locator(".transcription-status");
    const statusBox = await status.boundingBox();
    if (!surfaceBox || !statusBox) throw new Error("transcription error geometry was unavailable");
    expect(statusBox.y).toBeLessThan(surfaceBox.y);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width);
    expect(await status.evaluate((element) => new Promise<number>((resolve) => {
      const observer = new IntersectionObserver(([entry]) => {
        observer.disconnect();
        // SAFETY: IntersectionObserver callbacks always include the observed element's entry.
        resolve(entry!.intersectionRatio);
      });
      observer.observe(element);
    }))).toBe(1);
    await page.close();
  });

  test("finishes an active transcription before submitting", async () => {
    const page = await browserContext.newPage();
    let submissions = 0;
    await page.addInitScript(() => {
      class FakeWebSocket extends EventTarget {
        static readonly OPEN = 1;
        readonly readyState = FakeWebSocket.OPEN;

        constructor(_url: string) {
          super();
          window.addEventListener("fake-transcription-message", () => {
            this.dispatchEvent(new MessageEvent("message", { data: document.body.dataset.transcriptionEvent }));
          });
        }

        send(): void {}

        close(): void {
          this.dispatchEvent(new CloseEvent("close"));
        }
      }
      Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
    });
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div data-controller="transcription-composer"><form method="post" action="/send" data-action="submit->transcription-composer#submit"><textarea name="text">Existing</textarea>${renderTranscriptionComposerControl()}<button type="submit">Send</button></form></div><script type="module" src="/workspace-test.js"></script>`,
    }));
    await page.route("**/workspace-test.js", (route) => route.fulfill({ contentType: "text/javascript", body: workspaceClient }));
    await page.route("http://atelier.test/send", (route) => {
      submissions += 1;
      return route.fulfill({ status: 204 });
    });
    await page.goto("http://atelier.test/");

    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    expect(submissions).toBe(0);

    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "session.created" });
      window.dispatchEvent(new Event("fake-transcription-message"));
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "input_audio_buffer.committed" });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });
    expect(submissions).toBe(0);

    const submission = page.waitForRequest("http://atelier.test/send");
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "final words",
      });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });
    expect((await submission).method()).toBe("POST");
    expect(await page.getByRole("textbox").inputValue()).toBe("Existing final words");
    await page.close();
  });
});
