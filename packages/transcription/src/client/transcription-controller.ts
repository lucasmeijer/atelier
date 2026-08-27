/// <reference lib="dom" />

import { observableWebSocketUrl } from "@atelier/observable-terminal/client";
import { setTextInputValue, type WorkspaceClientControllerConstructor } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

type TranscriptionState = "idle" | "loading" | "recording" | "finishing" | "error";
type AudioCapture = { media: MediaStream; context: AudioContext; processor: ScriptProcessorNode; analyser: AnalyserNode };
const transcriptionEventSchema = Type.Object({
  type: Type.String(),
  status: Type.Optional(Type.Union([Type.Literal("loading"), Type.Literal("error")])),
  message: Type.Optional(Type.String()),
  delta: Type.Optional(Type.String()),
  transcript: Type.Optional(Type.String()),
  error: Type.Optional(Type.Object({ message: Type.String() })),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
});
type TranscriptionEvent = Static<typeof transcriptionEventSchema>;

function joinedTranscript(prefix: string, committed: string, partial: string): string {
  const spoken = `${committed}${partial}`;
  if (!prefix || !spoken || /\s$/.test(prefix) || /^\s/.test(spoken)) return `${prefix}${spoken}`;
  return `${prefix} ${spoken}`;
}

export function createTranscriptionComposerController(Controller: WorkspaceClientControllerConstructor) {
  return class TranscriptionComposerController extends Controller {
    static targets = ["button", "waveform", "status"];

    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly waveformTarget: HTMLCanvasElement;
    declare readonly statusTarget: HTMLElement;

    private get input(): HTMLTextAreaElement {
      return this.element.querySelector("textarea")!;
    }

    private state: TranscriptionState = "idle";
    private socket?: WebSocket;
    private capture?: AudioCapture;
    private waveformFrame?: number;
    private readonly waveformSamples = new Float32Array(256);
    private waveformColor = "";
    private prefix = "";
    private committed = "";
    private partial = "";

    disconnect(): void {
      this.stopCapture();
      this.socket?.close();
    }

    toggle(): void {
      if (this.state === "recording") {
        this.finish();
        return;
      }
      if (this.state === "loading" || this.state === "finishing") return;
      this.start();
    }

    private start(): void {
      this.prefix = this.input.value;
      this.committed = "";
      this.partial = "";
      this.setState("loading", "Preparing transcription model…");
      this.setProgress(0);
      const socket = new WebSocket(observableWebSocketUrl("/transcription/realtime"));
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        this.received(Value.Parse(transcriptionEventSchema, JSON.parse(String(event.data))));
      });
      socket.addEventListener("error", () => this.fail("Could not connect to transcription"));
      socket.addEventListener("close", () => {
        this.stopCapture();
        if (this.state !== "error") this.setState("idle", "Dictate");
      });
    }

    private received(event: TranscriptionEvent): void {
      if (event.type === "atelier.transcription.status") {
        if (event.status === "loading") {
          this.setState("loading", event.message ?? "Preparing transcription model…");
          this.setProgress(event.progress ?? 0);
        }
        else if (event.status === "error") this.fail(event.message ?? "Transcription failed");
        return;
      }
      if (event.type === "session.created") {
        void this.startCapture();
      } else if (event.type.endsWith(".delta")) {
        this.partial += event.delta ?? "";
        this.renderTranscript();
      } else if (event.type.endsWith(".completed")) {
        const transcript = event.transcript ?? this.partial;
        this.committed += `${this.committed && transcript ? " " : ""}${transcript}`;
        this.partial = "";
        this.renderTranscript();
      } else if (event.type === "input_audio_buffer.committed") {
        this.socket?.close();
      } else if (event.type === "error") {
        this.fail(event.error?.message ?? "Transcription failed");
      }
    }

    private async startCapture(): Promise<void> {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        const context = new AudioContext();
        const source = context.createMediaStreamSource(media);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const analyser = context.createAnalyser();
        const sink = context.createGain();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        sink.gain.value = 0;
        processor.onaudioprocess = (audioEvent) => {
          if (this.socket?.readyState !== WebSocket.OPEN || this.state !== "recording") return;
          const samples = audioEvent.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(samples.length);
          for (let index = 0; index < samples.length; index += 1) {
            pcm[index] = Math.max(-32768, Math.min(32767, Math.round((samples[index] ?? 0) * 32767)));
          }
          this.socket.send(pcm.buffer);
        };
        source.connect(analyser);
        analyser.connect(processor);
        processor.connect(sink);
        sink.connect(context.destination);
        this.capture = { media, context, processor, analyser };
        this.socket?.send(JSON.stringify({
          type: "session.update",
          session: { sample_rate: context.sampleRate, language: "auto", automatic_punctuation: true },
        }));
        this.setState("recording", "Listening…");
        this.animateWaveform();
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    }

    private finish(): void {
      this.setState("finishing", "Finishing…");
      this.stopCapture();
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      else this.socket?.close();
    }

    private stopCapture(): void {
      if (this.waveformFrame !== undefined) cancelAnimationFrame(this.waveformFrame);
      this.capture?.media.getTracks().forEach((track) => track.stop());
      if (this.capture) {
        this.capture.processor.onaudioprocess = null;
        if (this.capture.context.state !== "closed") void this.capture.context.close();
      }
      this.capture = undefined;
      this.waveformFrame = undefined;
      this.waveformColor = "";
      this.waveformTarget.getContext("2d")?.clearRect(0, 0, this.waveformTarget.width, this.waveformTarget.height);
    }

    private renderTranscript(): void {
      setTextInputValue(this.input, joinedTranscript(this.prefix, this.committed, this.partial));
    }

    private animateWaveform(): void {
      if (!this.capture || this.state !== "recording") return;
      this.capture.analyser.getFloatTimeDomainData(this.waveformSamples);
      this.drawWaveform(this.waveformSamples);
      this.waveformFrame = requestAnimationFrame(() => this.animateWaveform());
    }

    private drawWaveform(samples: Float32Array): void {
      const canvas = this.waveformTarget;
      const ratio = window.devicePixelRatio || 1;
      const width = 24;
      const height = 22;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }
      const drawing = canvas.getContext("2d")!;
      drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawing.clearRect(0, 0, width, height);
      this.waveformColor ||= getComputedStyle(canvas).color;
      drawing.fillStyle = this.waveformColor;
      const bars = 5;
      const stride = Math.max(1, Math.floor(samples.length / bars));
      for (let bar = 0; bar < bars; bar += 1) {
        let peak = 0;
        for (let index = bar * stride; index < Math.min(samples.length, (bar + 1) * stride); index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
        const barHeight = Math.max(2, Math.min(height, peak * height * 3.2));
        drawing.fillRect(bar * 5, (height - barHeight) / 2, 3, barHeight);
      }
    }

    private fail(message: string): void {
      this.stopCapture();
      this.setState("error", message);
      this.socket?.close();
    }

    private setProgress(progress: number): void {
      this.buttonTarget.style.setProperty("--button-progress", String(progress));
    }

    private setState(state: TranscriptionState, label: string): void {
      const working = state === "loading" || state === "finishing";
      this.state = state;
      this.buttonTarget.dataset.state = state;
      this.buttonTarget.dataset.progressState = working ? "in-progress" : "initial";
      this.buttonTarget.disabled = working;
      this.buttonTarget.toggleAttribute("aria-busy", working);
      this.buttonTarget.ariaPressed = state === "recording" || state === "finishing" ? "true" : "false";
      this.buttonTarget.title = label;
      this.statusTarget.textContent = label;
      if (state === "finishing") this.setProgress(100);
      else if (!working) this.setProgress(0);
    }
  };
}
