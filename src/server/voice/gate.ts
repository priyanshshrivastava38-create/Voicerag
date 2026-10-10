// Holds a speculatively pre-rendered turn's output (events and audio) server-side until the end
// of turn is confirmed, then flushes it in order and becomes a pass-through. Nothing produced for
// an utterance the user did not finish ever reaches the client.
import type { ServerMsg } from "@/shared/protocol";
import type { TurnClock } from "./clock";

export class OutputGate {
  private queue: (() => void)[] = [];
  private open = false;
  private discarded = false;

  constructor(
    private sendMsg: (m: ServerMsg) => void,
    private sendFrame: (f: Uint8Array) => void,
    private clock: TurnClock,
  ) {}

  emit = (m: ServerMsg) => {
    if (this.discarded) return;
    // Intermediate "state" updates are stale by the time a buffered turn is released.
    if (!this.open && m.t === "state") return;
    if (this.open) this.sendMsg(m);
    else this.queue.push(() => this.sendMsg(m));
  };

  audio = (f: Uint8Array) => {
    if (this.discarded) return;
    const send = () => {
      this.clock.mark("firstAudioSent");
      this.sendFrame(f);
    };
    if (this.open) send();
    else this.queue.push(send);
  };

  get buffered() {
    return this.queue.length;
  }

  release() {
    if (this.discarded) return;
    this.open = true;
    for (const f of this.queue.splice(0)) f();
  }

  discard() {
    this.discarded = true;
    this.queue = [];
  }
}
