import { describe, expect, test } from "bun:test";
import { SharedMicrophone } from "../../src/client/microphone.ts";

function fakeStream() {
  const track = { enabled: true };
  // SAFETY: SharedMicrophone only reads active and calls getAudioTracks; the
  // test supplies their complete behavior and does not pass this stub to browser APIs.
  const stream = { active: true, getAudioTracks: () => [track] } as MediaStream;
  return { stream, track };
}

describe("SharedMicrophone", () => {
  test("reuses one permission-granted stream across dictation sessions", async () => {
    const { stream, track } = fakeStream();
    let requests = 0;
    const microphone = new SharedMicrophone(async () => {
      requests += 1;
      return stream;
    });

    const first = await microphone.acquire();
    first.release();
    expect(track.enabled).toBe(false);

    const second = await microphone.acquire();
    expect(requests).toBe(1);
    expect(track.enabled).toBe(true);
    second.release();
    expect(track.enabled).toBe(false);
  });
});
