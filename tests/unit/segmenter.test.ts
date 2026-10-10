import { describe, expect, it } from "vitest";
import { SpeechSegmenter } from "@/server/voice/segmenter";

function run(tokens: string[]) {
  const s = new SpeechSegmenter();
  const out: string[] = [];
  for (const t of tokens) out.push(...s.push(t));
  return [...out, ...s.flush()];
}

describe("SpeechSegmenter", () => {
  it("releases the first segment early at a clause boundary", () => {
    const s = new SpeechSegmenter();
    // The clause is released as soon as the token after the comma arrives — before the sentence ends.
    expect(s.push("Full-time employees receive 22 days,")).toEqual([]);
    expect(s.push(" accrued")).toEqual(["Full-time employees receive 22 days,"]);
    expect(s.push(" monthly")).toEqual([]);
  });

  it("splits later text into whole sentences and keeps citation markers with their sentence", () => {
    const segs = run("You get 22 days [1]. Up to five days carry over [1][2]. Ask HR.".split(/(?<= )/));
    expect(segs).toEqual(["You get 22 days [1].", "Up to five days carry over [1][2].", "Ask HR."]);
  });

  it("does not split on abbreviations or decimals", () => {
    const segs = run(["The fee is 3.5 percent, e.g. for travel. Done."]);
    expect(segs.join(" | ")).not.toMatch(/3\. \||e\.g\. \|/);
    expect(segs[segs.length - 1]).toBe("Done.");
  });

  it("cuts run-on text without punctuation", () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ") + " ";
    const segs = run([words]);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.join(" ").split(" ").length).toBe(30);
  });
});
