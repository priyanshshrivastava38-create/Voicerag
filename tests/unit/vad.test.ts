import { describe, expect, it } from "vitest";
import { EnergyVad, rmsOf, type VadEvent } from "@/shared/vad";

function feed(vad: EnergyVad, rms: number, ms: number): VadEvent[] {
  const out: VadEvent[] = [];
  for (let t = 0; t < ms; t += 20) out.push(...vad.process(rms, 20));
  return out;
}

describe("EnergyVad", () => {
  it("detects start, pause, end and reports speech duration", () => {
    const vad = new EnergyVad();
    expect(feed(vad, 0.002, 400)).toEqual([]); // background noise only
    const start = feed(vad, 0.1, 600);
    expect(start[0]).toMatchObject({ type: "start" });
    const tail = feed(vad, 0.002, 700);
    expect(tail.map((e) => e.type)).toEqual(["pause", "end"]);
    const end = tail.find((e) => e.type === "end") as Extract<VadEvent, { type: "end" }>;
    expect(end.speechMs).toBeGreaterThanOrEqual(580);
    expect(end.hangoverMs).toBeGreaterThanOrEqual(540);
  });

  it("emits resume when speech continues after a pause, and does not end the turn", () => {
    const vad = new EnergyVad();
    feed(vad, 0.002, 200);
    feed(vad, 0.1, 400);
    const ev = [...feed(vad, 0.002, 300), ...feed(vad, 0.1, 200)];
    expect(ev.map((e) => e.type)).toEqual(["pause", "resume"]);
    expect(vad.speaking).toBe(true);
  });

  it("discards blips shorter than the minimum utterance", () => {
    const vad = new EnergyVad();
    feed(vad, 0.002, 200);
    const ev = [...feed(vad, 0.1, 120), ...feed(vad, 0.002, 700)];
    expect(ev.map((e) => e.type)).toEqual(["start", "pause", "abort"]);
  });

  it("is harder to trigger when the sensitivity scale is raised (echo guard during playback)", () => {
    const vad = new EnergyVad();
    feed(vad, 0.002, 200);
    vad.sensitivityScale = 4;
    expect(feed(vad, 0.03, 400)).toEqual([]);
    vad.sensitivityScale = 1;
    expect(feed(vad, 0.03, 400)[0]).toMatchObject({ type: "start" });
  });

  it("computes RMS for float and int16 input", () => {
    expect(rmsOf(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsOf(new Int16Array([16384, -16384]))).toBeCloseTo(0.5);
  });
});
