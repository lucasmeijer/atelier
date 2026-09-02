import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { renderTranscriptionComposerControl } from "../../../packages/transcription/src/server/composer.ts";
import { buildWebTestAssets, type WebTestAssets } from "./support/web-test-assets.ts";

let browser: Browser;
let browserContext: BrowserContext;
let testAssets: WebTestAssets;
let workspaceClientPath: string;
let composerStyle: string;

beforeAll(async () => {
  testAssets = await buildWebTestAssets();
  workspaceClientPath = testAssets.path("/workspace.js");
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

async function installFakeTranscriptionSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const track = { enabled: false };
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ active: true, getAudioTracks: () => [track] }) } });
    class FakeAudioNode { connect(): void {} }
    class FakeAnalyser extends FakeAudioNode {
      fftSize = 0;
      smoothingTimeConstant = 0;
      getFloatTimeDomainData(samples: Float32Array): void { samples.fill(0); }
    }
    class FakeAudioContext {
      readonly sampleRate = 16_000;
      readonly destination = new FakeAudioNode();
      state = "running";
      createMediaStreamSource(): FakeAudioNode { return new FakeAudioNode(); }
      createScriptProcessor(): FakeAudioNode & { onaudioprocess: null } { return Object.assign(new FakeAudioNode(), { onaudioprocess: null }); }
      createAnalyser(): FakeAnalyser { return new FakeAnalyser(); }
      createGain(): FakeAudioNode & { gain: { value: number } } { return Object.assign(new FakeAudioNode(), { gain: { value: 1 } }); }
      close(): Promise<void> { this.state = "closed"; return Promise.resolve(); }
    }
    Object.defineProperty(window, "AudioContext", { value: FakeAudioContext });

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
}

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

  test("keeps the latest transcribed words visible as the Composer fills", async () => {
    const page = await browserContext.newPage();
    await testAssets.serve(page);
    await installFakeTranscriptionSocket(page);
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div data-controller="transcription-composer"><textarea aria-label="Message" style="box-sizing:border-box;width:220px;height:60px;overflow-y:auto"></textarea>${renderTranscriptionComposerControl()}</div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/");

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.focus();
    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    expect(await composer.evaluate((input: HTMLTextAreaElement) => ({
      focused: document.activeElement === input,
      readOnly: input.readOnly,
    }))).toEqual({ focused: false, readOnly: true });
    expect(await page.getByRole("button", { name: "Dictate with microphone" }).isEnabled()).toBe(true);
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: Array.from({ length: 80 }, (_, index) => `word${index}`).join(" "),
      });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });

    const scroll = await composer.evaluate((input: HTMLTextAreaElement) => ({
      top: input.scrollTop,
      maximum: input.scrollHeight - input.clientHeight,
    }));
    expect(scroll.maximum).toBeGreaterThan(0);
    expect(Math.abs(scroll.top - scroll.maximum)).toBeLessThanOrEqual(1);
    await page.close();
  });

  test("stops transcription into the captured caret and resumes hardware-keyboard typing", async () => {
    const page = await browserContext.newPage();
    await testAssets.serve(page);
    await installFakeTranscriptionSocket(page);
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div data-controller="transcription-composer"><textarea aria-label="Message">Before after</textarea>${renderTranscriptionComposerControl()}</div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/");

    const input = page.getByRole("textbox", { name: "Message" });
    await input.focus();
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));
    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "session.created" });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });
    await page.waitForFunction(() => document.querySelector(".transcription-button")?.getAttribute("data-state") === "recording");

    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    expect(await page.getByRole("button", { name: "Dictate with microphone" }).getAttribute("data-state")).toBe("finishing");
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "dictated" });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });

    expect(await input.inputValue()).toBe("Before dictated after");
    expect(await input.evaluate((element: HTMLTextAreaElement) => ({ focused: document.activeElement === element, caret: element.selectionStart }))).toEqual({ focused: true, caret: 15 });
    await page.close();
  });

  test("does not focus the Composer after transcription when focus would open a software keyboard", async () => {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await testAssets.serve(page);
    await installFakeTranscriptionSocket(page);
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div data-controller="transcription-composer"><textarea aria-label="Message"></textarea>${renderTranscriptionComposerControl()}</div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.goto("http://atelier.test/");

    const input = page.getByRole("textbox", { name: "Message" });
    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "session.created" });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });
    await page.waitForFunction(() => document.querySelector(".transcription-button")?.getAttribute("data-state") === "recording");
    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "dictated" });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });

    expect(await input.inputValue()).toBe("dictated");
    expect(await input.evaluate((element) => document.activeElement === element)).toBe(false);
    await context.close();
  });

  test("starts from anywhere and sends with Command-Enter without focusing the Composer", async () => {
    const page = await browserContext.newPage();
    await testAssets.serve(page);
    await installFakeTranscriptionSocket(page);
    let submissions = 0;
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<main data-controller="atelier-shortcuts"><button type="button" autofocus>Outside Composer</button><input aria-label="Other editor"><div data-controller="transcription-composer"><form method="post" action="/send" data-controller="submit-shortcut" data-action="submit->transcription-composer#submit keydown->submit-shortcut#keydown submit->submit-shortcut#submit"><textarea name="text" aria-label="Message"></textarea>${renderTranscriptionComposerControl()}<button type="submit">Send</button></form></div></main><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("http://atelier.test/send", (route) => {
      submissions += 1;
      return route.fulfill({ status: 204 });
    });
    await page.goto("http://atelier.test/");

    await page.getByRole("button", { name: "Outside Composer" }).dispatchEvent("keydown", {
      key: "\\", code: "Backslash", metaKey: true, altKey: true, bubbles: true, cancelable: true,
    });
    await page.waitForFunction(() => document.querySelector(".transcription-button")?.getAttribute("data-state") === "loading");
    expect(await page.getByRole("button", { name: "Dictate with microphone" }).getAttribute("data-state")).toBe("loading");
    expect(await page.getByRole("textbox", { name: "Message" }).evaluate((input: HTMLTextAreaElement) => ({
      focused: document.activeElement === input,
      readOnly: input.readOnly,
    }))).toEqual({ focused: false, readOnly: true });

    expect(await page.getByRole("button", { name: "Outside Composer" }).evaluate((button) => document.activeElement === button)).toBe(true);
    await page.getByRole("textbox", { name: "Other editor" }).focus();
    await page.keyboard.press("Meta+Enter");
    expect(await page.getByRole("button", { name: "Dictate with microphone" }).getAttribute("data-state")).toBe("loading");

    await page.getByRole("button", { name: "Outside Composer" }).focus();
    await page.keyboard.press("Meta+Enter");
    await page.waitForFunction(() => document.querySelector(".transcription-button")?.getAttribute("data-state") === "finishing");
    expect(await page.getByRole("button", { name: "Dictate with microphone" }).getAttribute("data-state")).toBe("finishing");
    expect(submissions).toBe(0);

    const submission = page.waitForRequest("http://atelier.test/send");
    await page.evaluate(() => {
      document.body.dataset.transcriptionEvent = JSON.stringify({ type: "session.created" });
      window.dispatchEvent(new Event("fake-transcription-message"));
      document.body.dataset.transcriptionEvent = JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "final words",
      });
      window.dispatchEvent(new Event("fake-transcription-message"));
    });
    expect((await submission).method()).toBe("POST");
    expect(await page.getByRole("textbox", { name: "Message" }).inputValue()).toBe("final words");
    expect(await page.getByRole("textbox", { name: "Message" }).evaluate((input: HTMLTextAreaElement) => input.readOnly)).toBe(false);
    await page.close();
  });

  test("sends an already typed prompt while the transcription model is still loading", async () => {
    const page = await browserContext.newPage();
    await testAssets.serve(page);
    await installFakeTranscriptionSocket(page);
    await page.route("http://atelier.test/", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div data-controller="transcription-composer"><form method="post" action="/send" data-action="submit->transcription-composer#submit"><textarea name="text">Typed prompt</textarea>${renderTranscriptionComposerControl()}<button type="submit">Send</button></form></div><script type="module" src="${workspaceClientPath}"></script>`,
    }));
    await page.route("http://atelier.test/send", (route) => route.fulfill({ status: 204 }));
    await page.goto("http://atelier.test/");

    await page.getByRole("button", { name: "Dictate with microphone" }).click();
    await page.waitForFunction(() => document.querySelector(".transcription-button")?.getAttribute("data-state") === "loading");

    const submission = page.waitForRequest("http://atelier.test/send");
    await page.getByRole("button", { name: "Send" }).click();

    const request = await submission;
    expect(request.method()).toBe("POST");
    expect(request.postData()).toContain("text=Typed+prompt");
    expect(await page.getByRole("button", { name: "Dictate with microphone" }).getAttribute("data-state")).toBe("idle");
    await page.close();
  });
});
