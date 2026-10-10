import { expect, test } from "@playwright/test";

test("real providers: spoken question in Chromium is answered with a citation and spoken back", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("alice@vih.test");
  await page.getByLabel("Password").fill(process.env.VOICERAG_SEED_PASSWORD ?? "change-me-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
  await page.getByTestId("start").click();
  const consent = page.getByTestId("consent-accept");
  if (await consent.isVisible().catch(() => false)) await consent.click();
  await expect(page.getByTestId("question").first()).toContainText(/annual leave/i, { timeout: 60_000 });
  await expect(page.getByTestId("answer").first()).toContainText(/22/, { timeout: 90_000 });
  await expect(page.getByTestId("source-link").first()).toContainText("Leave and Time Off Policy");
  // Latency chips are rendered from real server measurements for this turn.
  const turn = page.getByTestId("turn").first();
  await expect(turn).toContainText(/EOS→audio \d+ ms/, { timeout: 60_000 });
  console.log("turn:", (await turn.innerText()).replace(/\s+/g, " ").slice(0, 400));
  await page.getByTestId("stop").click();
});
