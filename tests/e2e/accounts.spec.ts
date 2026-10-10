// Real-user onboarding: an administrator creates an account, the new person signs in with the
// one-time password, is forced to choose their own, and can then use the assistant.
import { expect, test } from "@playwright/test";

const ADMIN_PASSWORD = "test-password-123";

test("admin creates an account; new user must set a password before using the assistant", async ({ page, browser }) => {
  const email = `newhire.${Date.now()}@vih.test`;

  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@vih.test");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");

  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Users & access" })).toBeVisible();
  await page.getByLabel("Full name").fill("New Hire");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("checkbox", { name: "all-staff", exact: true }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  const temp = (await page.getByTestId("temp-password").textContent())!.trim();
  expect(temp).toHaveLength(14);
  await expect(page.getByTestId("user-row").filter({ hasText: email })).toContainText("Awaiting first sign-in");

  // The new person, in a separate browser session.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto("/login");
  await p2.getByLabel("Email").fill(email);
  await p2.getByLabel("Password").fill(temp);
  await p2.getByRole("button", { name: "Sign in" }).click();
  await p2.waitForURL("/account/password");

  // Until the password is changed, the assistant and its API are off limits.
  await p2.goto("/");
  await p2.waitForURL("/account/password");
  expect((await p2.request.get("/api/conversations")).status()).toBe(403);

  await p2.getByLabel("Temporary password").fill(temp);
  await p2.getByLabel("New password", { exact: true }).fill("correct horse battery");
  await p2.getByLabel("Confirm new password").fill("correct horse battery");
  await p2.getByRole("button", { name: "Save password" }).click();
  await p2.waitForURL("/");
  await expect(p2.getByRole("heading", { name: "Knowledge Assistant" })).toBeVisible();
  expect((await p2.request.get("/api/conversations")).status()).toBe(200);

  // Members cannot reach user administration.
  expect((await p2.request.get("/api/admin/users")).status()).toBe(403);
  await ctx.close();
});
