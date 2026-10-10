// The empty welcome screen must stay put: the transcript auto-scroll used to fire with no
// conversation and slide the mic button and heading off screen on laptop and phone heights.
import { expect, test } from "@playwright/test";

for (const vp of [{ name: "laptop", width: 1280, height: 720 }, { name: "phone", width: 390, height: 844 }]) {
  test(`welcome screen does not scroll by itself (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@vih.test");
    await page.getByLabel("Password").fill("test-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/");
    await page.waitForTimeout(2500);
    const transcript = page.getByTestId("transcript");
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole("heading", { name: "How can I help today?" })).toBeInViewport();
  });
}
