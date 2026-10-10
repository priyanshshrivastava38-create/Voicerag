import { describe, expect, it, vi } from "vitest";
import { TtlLru } from "@/lib/lru";
import { decodeAudioFrame, encodeAudioFrame } from "@/shared/protocol";
import { percentile, summarize } from "@/shared/stats";
import { pcmToWav, wavToPcm } from "@/server/providers/types";
import { decodeTextFromPcm, encodeTextAsPcm } from "@/server/providers/mock";

describe("audio framing", () => {
  it("round-trips audio frames with turn number and sample rate", () => {
    const pcm = Int16Array.from([1, -2, 3, 32767, -32768]);
    const f = encodeAudioFrame(7, 3, 22050, pcm);
    const d = decodeAudioFrame(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer)!;
    expect(d).toMatchObject({ turnNum: 7, seq: 3, sampleRate: 22050 });
    expect(Array.from(d.pcm)).toEqual(Array.from(pcm));
    expect(decodeAudioFrame(new ArrayBuffer(4))).toBeNull();
  });
  it("round-trips WAV encoding", () => {
    const pcm = Int16Array.from({ length: 100 }, (_, i) => i * 10);
    const w = wavToPcm(pcmToWav(pcm, 16000));
    expect(w.sampleRate).toBe(16000);
    expect(Array.from(w.pcm)).toEqual(Array.from(pcm));
  });
  it("mock speech encoding round-trips text", () => {
    expect(decodeTextFromPcm(encodeTextAsPcm("How many days of leave?"))).toBe("How many days of leave?");
  });
});

describe("TtlLru", () => {
  it("evicts least-recently-used entries beyond capacity and counts hits/misses", () => {
    const c = new TtlLru<number>("t", 2, 10_000);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    c.set("c", 3); // evicts b (a was used more recently)
    expect(c.get("b")).toBeUndefined();
    expect(c.stats()).toMatchObject({ hits: 1, misses: 1, evictions: 1, size: 2 });
  });
  it("expires entries after the TTL", () => {
    vi.useFakeTimers();
    const c = new TtlLru<number>("t", 10, 1000);
    c.set("a", 1);
    vi.advanceTimersByTime(1001);
    expect(c.get("a")).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("percentiles", () => {
  it("uses nearest rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
    expect(summarize([3, null, 1, 2])).toMatchObject({ n: 3, p50: 2, max: 3, min: 1 });
    expect(summarize([]).p50).toBeNull();
  });
});
