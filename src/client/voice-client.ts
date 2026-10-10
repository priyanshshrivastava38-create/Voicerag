// Browser voice engine (framework-agnostic). Owns the microphone, VAD, WebSocket and playback.
//
// Barge-in: when the VAD detects the user speaking while the assistant is thinking/speaking,
// playback stops locally at once (no network round trip), the active turn number is cleared so
// any in-flight audio frames for it are dropped, and `speech_start` tells the server to cancel.
import { DEFAULT_VAD, EnergyVad, type VadOptions } from "@/shared/vad";
import { MIC_SAMPLE_RATE, WS_PATH, decodeAudioFrame, type AssistantState, type ClientConfig, type ClientMsg, type ServerMsg } from "@/shared/protocol";
import { PcmPlayer } from "./player";

export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting";
export type MicState = "off" | "requesting" | "on" | "denied" | "unavailable";

export interface VoiceClientEvents {
  onServer: (msg: ServerMsg) => void;
  onState: (s: { conn: ConnState; mic: MicState; assistant: AssistantState; userSpeaking: boolean; level: number }) => void;
  onError: (code: string, message: string) => void;
}

const PRE_ROLL_FRAMES = 15; // 300 ms of audio before the VAD fired, so first syllables aren't clipped
const BARGE_IN_SENSITIVITY = 2.5; // VAD threshold multiplier while the assistant is audible (echo guard)

export class VoiceClient {
  private ws: WebSocket | null = null;
  private conn: ConnState = "disconnected";
  private mic: MicState = "off";
  private assistant: AssistantState = "idle";
  private level = 0;
  private stream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private vad: EnergyVad;
  private ring: ArrayBuffer[] = [];
  private uttId: string | null = null;
  private uttStartAt = 0;
  private lastVoiceAt = 0;
  private player = new PcmPlayer();
  private activeTurnNum = -1;
  private activeTurnId: string | null = null;
  private turnTiming = new Map<string, { lastVoiceAt: number | null; speechStartAt: number | null; reported: boolean }>();
  private ttsMode: "server" | "browser" | "none" = "server";
  private reconnectAttempts = 0;
  private wantOpen = false;
  private conversationId: string | null = null;
  private browserSpeakQueue = 0;

  constructor(
    private events: VoiceClientEvents,
    public config: ClientConfig = { speak: true, rateWpm: 180 },
    vadOptions: VadOptions = DEFAULT_VAD,
  ) {
    this.vad = new EnergyVad(vadOptions);
    this.player.onIdle = () => {
      if (this.assistant === "speaking") this.setAssistant("idle");
    };
  }

  // ---------------------------------------------------------------- connection
  async connect(conversationId: string | null = null) {
    this.wantOpen = true;
    this.conversationId = conversationId;
    try {
      await this.player.init(); // inside the user gesture that called connect()
    } catch {
      // No Web Audio output: keep going so typed questions and on-screen answers still work.
      this.events.onError("AUDIO_UNAVAILABLE", "This browser can't play audio here, so answers will appear as text only.");
    }
    this.open();
  }

  private open() {
    this.setConn(this.reconnectAttempts ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConn("connected");
      this.send({ t: "hello", config: this.config, conversationId: this.conversationId });
      for (const m of this.outbox.splice(0)) this.send(m);
    };
    ws.onmessage = (ev) => (typeof ev.data === "string" ? this.onServer(JSON.parse(ev.data) as ServerMsg) : this.onAudio(ev.data as ArrayBuffer));
    ws.onclose = (ev) => {
      this.ws = null;
      this.player.stop();
      if (!this.wantOpen) return this.setConn("disconnected");
      if (ev.code === 1008 || this.reconnectAttempts >= 6) {
        this.wantOpen = false;
        this.stopMic();
        this.setConn("disconnected");
        this.setAssistant("idle");
        // A rejected upgrade is indistinguishable from a network drop (1006): ask the API which it was.
        void fetch("/api/me")
          .then((r) => r.status === 401)
          .catch(() => false)
          .then((expired) =>
            expired
              ? this.events.onError("SESSION_EXPIRED", "Your session has expired. Sign in again to continue.")
              : this.events.onError("DISCONNECTED", "Connection to the server was lost. Check your network, then start again."),
          );
        return;
      }
      const delay = Math.min(8000, 400 * 2 ** this.reconnectAttempts++);
      this.setConn("reconnecting");
      setTimeout(() => this.wantOpen && this.open(), delay);
    };
  }

  disconnect() {
    this.wantOpen = false;
    this.stopMic();
    this.player.stop();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.ws?.close(1000);
    this.ws = null;
    this.setConn("disconnected");
    this.setAssistant("idle");
  }

  /** Control messages sent while (re)connecting are queued and flushed after `hello`. */
  private outbox: ClientMsg[] = [];
  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (this.wantOpen && (msg.t === "text" || msg.t === "config" || msg.t === "new_conversation")) this.outbox.push(msg);
  }

  updateConfig(c: Partial<ClientConfig>) {
    this.config = { ...this.config, ...c };
    this.send({ t: "config", config: this.config });
  }

  sendText(text: string) {
    this.interrupt("barge_in");
    this.send({ t: "text", text });
  }

  newConversation() {
    this.interrupt("user_stop");
    this.conversationId = null;
    this.send({ t: "new_conversation" });
  }

  /** Stop the assistant now (button / barge-in). */
  interrupt(reason: "barge_in" | "user_stop") {
    const busy = this.assistant !== "idle" && this.assistant !== "listening";
    this.player.stop();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.browserSpeakQueue = 0;
    this.activeTurnNum = -1; // drop any audio still in flight for the cancelled turn
    this.activeTurnId = null;
    if (busy) this.send({ t: "cancel", reason });
  }

  // ---------------------------------------------------------------- microphone
  async startMic(): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setMic("unavailable");
      this.events.onError("MIC_UNAVAILABLE", "This browser cannot capture audio here (a secure https:// or localhost page is required). Use the text box instead.");
      return false;
    }
    this.setMic("requesting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      const denied = name === "NotAllowedError" || name === "SecurityError";
      this.setMic(denied ? "denied" : "unavailable");
      this.events.onError(
        denied ? "MIC_DENIED" : "MIC_UNAVAILABLE",
        denied ? "Microphone permission was denied. Allow it in the browser's site settings, or type your question instead." : "No microphone was found or it is in use by another app. You can type your question instead.",
      );
      return false;
    }
    try {
      // Prefer a 16 kHz context (browser does high-quality resampling); fall back to native rate.
      try {
        this.micCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE, latencyHint: "interactive" });
        await this.micCtx.audioWorklet.addModule("/worklets/mic-processor.js");
        this.micCtx.createMediaStreamSource(this.stream);
      } catch {
        await this.micCtx?.close().catch(() => undefined);
        this.micCtx = new AudioContext({ latencyHint: "interactive" });
        await this.micCtx.audioWorklet.addModule("/worklets/mic-processor.js");
      }
      const src = this.micCtx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.micCtx, "mic-processor");
      this.node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => this.onFrame(ev.data.pcm, ev.data.rms);
      src.connect(this.node);
      // Worklet must be pulled by the graph; route through a muted gain so nothing is heard.
      const mute = this.micCtx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.micCtx.destination);
      if (this.micCtx.state === "suspended") await this.micCtx.resume();
      this.setMic("on");
      return true;
    } catch {
      this.stopMic();
      this.setMic("unavailable");
      this.events.onError("MIC_UNAVAILABLE", "Audio capture could not start in this browser. You can type your question instead.");
      return false;
    }
  }

  stopMic() {
    if (this.uttId) this.send({ t: "speech_abort", uttId: this.uttId });
    this.uttId = null;
    this.vad.reset();
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.micCtx?.close().catch(() => undefined);
    this.micCtx = null;
    if (this.mic === "on") this.setMic("off");
  }

  private onFrame(pcm: ArrayBuffer, rms: number) {
    this.level = rms;
    // Raise the bar while the assistant is audible so its own voice (echo) doesn't interrupt it.
    this.vad.sensitivityScale = this.assistant === "speaking" || this.player.playing ? BARGE_IN_SENSITIVITY : 1;
    const events = this.vad.process(rms, 20);
    if (!this.uttId) {
      this.ring.push(pcm);
      if (this.ring.length > PRE_ROLL_FRAMES) this.ring.shift();
    } else {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
    }
    if (rms > this.vad.threshold()) this.lastVoiceAt = performance.now();

    for (const ev of events) {
      if (ev.type === "start") {
        // Barge-in: cut playback locally first, then tell the server.
        if (this.assistant !== "idle" && this.assistant !== "listening") this.interrupt("barge_in");
        this.uttId = Math.random().toString(36).slice(2, 12);
        this.uttStartAt = performance.now() - ev.preRollMs;
        this.send({ t: "speech_start", uttId: this.uttId });
        for (const f of this.ring) if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(f);
        this.ring = [];
      } else if (ev.type === "pause" && this.uttId) {
        this.send({ t: "pause", uttId: this.uttId });
      } else if (ev.type === "resume" && this.uttId) {
        this.send({ t: "resume", uttId: this.uttId });
      } else if (ev.type === "end" && this.uttId) {
        this.send({ t: "speech_end", uttId: this.uttId, speechMs: ev.speechMs, hangoverMs: ev.hangoverMs });
        this.pendingTiming = { lastVoiceAt: this.lastVoiceAt, speechStartAt: this.uttStartAt };
        this.uttId = null;
      } else if (ev.type === "abort" && this.uttId) {
        this.send({ t: "speech_abort", uttId: this.uttId });
        this.uttId = null;
      }
    }
    this.emitState(events.length === 0);
  }
  private pendingTiming: { lastVoiceAt: number; speechStartAt: number } | null = null;

  // ---------------------------------------------------------------- server events
  private onServer(msg: ServerMsg) {
    switch (msg.t) {
      case "ready":
        this.ttsMode = msg.ttsMode;
        this.conversationId = msg.conversationId;
        break;
      case "state":
        if (msg.turnId && this.activeTurnId && msg.turnId !== this.activeTurnId) break;
        // While audio is still playing, "idle" from the server means generation finished.
        if (msg.state === "idle" && (this.player.playing || this.browserSpeakQueue > 0)) break;
        this.setAssistant(msg.state);
        break;
      case "turn_start":
        this.activeTurnNum = msg.turnNum;
        this.activeTurnId = msg.turnId;
        this.turnTiming.set(msg.turnId, {
          lastVoiceAt: msg.mode === "voice" ? this.pendingTiming?.lastVoiceAt ?? null : null,
          speechStartAt: msg.mode === "voice" ? this.pendingTiming?.speechStartAt ?? null : null,
          reported: false,
        });
        this.pendingTiming = null;
        break;
      case "speak":
        if (this.ttsMode === "browser" && msg.turnId === this.activeTurnId) this.speakInBrowser(msg.turnId, msg.text);
        break;
      case "answer_done":
        this.conversationId = msg.conversationId;
        break;
      case "error":
        this.events.onError(msg.code, msg.message);
        break;
    }
    this.events.onServer(msg);
  }

  private onAudio(buf: ArrayBuffer) {
    const f = decodeAudioFrame(buf);
    if (!f || f.turnNum !== this.activeTurnNum || !this.activeTurnId) return; // stale turn: drop
    const audibleAt = this.player.enqueue(f.pcm, f.sampleRate);
    if (this.assistant !== "speaking") this.setAssistant("speaking");
    this.reportPlayback(this.activeTurnId, audibleAt);
  }

  private reportPlayback(turnId: string, audibleAt: number) {
    const t = this.turnTiming.get(turnId);
    if (!t || t.reported) return;
    t.reported = true;
    this.send({
      t: "playback_started",
      turnId,
      lastVoiceToAudioMs: t.lastVoiceAt !== null ? Math.round(audibleAt - t.lastVoiceAt) : null,
      speechStartToAudioMs: t.speechStartAt !== null ? Math.round(audibleAt - t.speechStartAt) : null,
    });
    if (this.turnTiming.size > 50) this.turnTiming.delete(this.turnTiming.keys().next().value as string);
  }

  private speakInBrowser(turnId: string, text: string) {
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.max(0.5, Math.min(2, (this.config.rateWpm ?? 180) / 180));
    this.browserSpeakQueue++;
    u.onstart = () => {
      if (turnId !== this.activeTurnId) return;
      this.setAssistant("speaking");
      this.reportPlayback(turnId, performance.now());
    };
    u.onend = u.onerror = () => {
      this.browserSpeakQueue = Math.max(0, this.browserSpeakQueue - 1);
      if (this.browserSpeakQueue === 0 && this.assistant === "speaking") this.setAssistant("idle");
    };
    speechSynthesis.speak(u);
  }

  // ---------------------------------------------------------------- state
  private setConn(c: ConnState) {
    this.conn = c;
    this.emitState();
  }
  private setMic(m: MicState) {
    this.mic = m;
    this.emitState();
  }
  private setAssistant(a: AssistantState) {
    this.assistant = a;
    this.emitState();
  }
  private lastEmit = 0;
  private emitState(levelOnly = false) {
    // Throttle level-meter updates to ~15 fps to keep React renders cheap; state changes always emit.
    const now = performance.now();
    if (levelOnly && now - this.lastEmit < 66) return;
    this.lastEmit = now;
    this.events.onState({ conn: this.conn, mic: this.mic, assistant: this.assistant, userSpeaking: this.vad.speaking, level: this.level });
  }
}
