import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../../src/lib/db";

const PASSWORD = "test-password-123";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

test("real browser voice session: mic → VAD → STT → RAG → streamed answer with citation → audio playback → barge-in", async ({ page }) => {
  await login(page, "alice@vih.test");
  await page.getByTestId("start").click();
  await page.getByTestId("consent-accept").click(); // explicit consent before the mic opens

  // The fake microphone plays a spoken question; the browser VAD detects it and ends the turn.
  const q = page.getByTestId("question").first();
  await expect(q).toHaveText("How many days of annual leave do I get each year?", { timeout: 30_000 });
  const answer = page.getByTestId("answer").first();
  await expect(answer).toContainText("22 days", { timeout: 30_000 });

  // Citation → source viewer fetches the authorised passage.
  await page.getByTestId("source-link").first().click();
  await expect(page.getByTestId("source-text")).toContainText("22 days of paid annual leave");
  await page.keyboard.press("Escape");

  // Audio actually played in the browser: the client reports playback start with its own timing.
  await expect
    .poll(async () => (await prisma.turnMetric.findFirst({ where: { mode: "voice", clientEosToFirstAudioMs: { not: null } } }))?.clientEosToFirstAudioMs ?? null, { timeout: 20_000 })
    .not.toBeNull();

  // The fake mic loops the question, so the "user" speaks again while the long answer is playing:
  // barge-in must interrupt the active turn.
  await expect(page.getByTestId("interrupted").first()).toBeVisible({ timeout: 45_000 });
  await page.getByTestId("stop").click();
});

test("microphone permission denied falls back to text", async ({ page }) => {
  // Deterministic denial: the browser rejects getUserMedia exactly as when the user clicks "Block".
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
  });
  await login(page, "bob@vih.test");
  await page.evaluate(() => localStorage.setItem("voicerag.micConsent.v1", "yes"));
  await page.reload();
  await page.getByTestId("start").click();
  await expect(page.getByRole("alert").filter({ hasText: "Microphone permission was denied" })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("text-input").fill("What is the per diem for international travel?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByTestId("answer").last()).toContainText("75", { timeout: 20_000 });
});

test("permission enforcement: a user without finance access gets an abstention", async ({ page }) => {
  await login(page, "alice@vih.test");
  await page.getByTestId("text-input").fill("What is the FY27 research and development budget?");
  await page.getByRole("button", { name: "Ask" }).click();
  const answer = page.getByTestId("answer").last();
  await expect(answer).not.toHaveText("", { timeout: 20_000 });
  await expect(answer).not.toContainText("48");
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
