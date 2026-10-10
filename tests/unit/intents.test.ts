import { describe, expect, it } from "vitest";
import { looksInternal, topicIntent } from "@/server/rag/intents";
import { resolveMixedAbstention } from "@/server/rag/prompt";

describe("topic intent", () => {
  it("recognises capability questions and the collection they name", () => {
    expect(topicIntent("what you can do for engineering")).toEqual({ isTopic: true, slug: "engineering" });
    expect(topicIntent("What can you help me with for HR?")).toMatchObject({ isTopic: true, slug: "hr" });
    expect(topicIntent("What do you know about IT security?")).toMatchObject({ isTopic: true, slug: "it-security" });
    expect(topicIntent("What can you do?")).toEqual({ isTopic: true, slug: null });
  });
  it("does not treat factual questions as capability questions", () => {
    expect(topicIntent("How many approvals does a pull request need?").isTopic).toBe(false);
    expect(topicIntent("How quickly must a SEV1 page be acknowledged?").isTopic).toBe(false);
  });
});

describe("internal vs general questions", () => {
  it("never lets VIH-internal questions fall back to general knowledge", () => {
    for (const q of ["What is the dental insurance coverage limit?", "Who is the CEO of VIH Metaverse?", "What's the R&D budget?", "Which VPN client should I install?", "Can I bring my dog to the office?", "What is the hotel cap per night?", "How many approvals are needed to merge to main?"]) {
      expect(looksInternal(q), q).toBe(true);
    }
  });
  it("allows general guidance for non-VIH questions", () => {
    for (const q of ["tell me roadmap for creating a voicebot for my client", "What is retrieval-augmented generation?", "How do I write a good product requirements document?"]) {
      expect(looksInternal(q), q).toBe(false);
    }
  });
});

describe("contradictory answers", () => {
  it("drops the abstention sentence when a cited answer is present", () => {
    const r = resolveMixedAbstention("New engineers shadow one rotation before going on-call [1]. I don't have enough information in the knowledge base to answer that.");
    expect(r).toEqual({ text: "New engineers shadow one rotation before going on-call [1].", changed: true });
  });
  it("handles markers written after the full stop", () => {
    const r = resolveMixedAbstention("Status updates are posted every 30 minutes until resolution. [1] I don't have enough information in the knowledge base to answer that.");
    expect(r).toEqual({ text: "Status updates are posted every 30 minutes until resolution [1].", changed: true });
  });
  it("keeps a pure abstention, even with a stray marker", () => {
    expect(resolveMixedAbstention("I don't have enough information in the knowledge base to answer that.").changed).toBe(false);
    expect(resolveMixedAbstention("I don't have enough information in the knowledge base to answer that. [1]").changed).toBe(false);
  });
});
