import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/evidence", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
});

test("public journey and consent controls work", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Open-source launch factory — founder alpha/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /A launch path you can inspect before it touches the world/,
    }),
  ).toBeVisible();

  const consent = page.getByRole("dialog", { name: "Analytics consent" });
  await expect(consent).toBeVisible();
  await expect(consent.getByRole("button", { name: "Allow analytics" })).toBeVisible();
  await consent.getByRole("button", { name: "Decline" }).click();
  await expect(consent).toBeHidden();

  await page.getByRole("button", { name: "Analytics settings" }).click();
  await expect(consent).toBeVisible();
  await expect(runtimeErrors).toEqual([]);
});

test("accept then withdraw stops every later third-party analytics call", async ({ page }) => {
  const thirdPartyRequests: string[] = [];
  page.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (
      hostname === "www.googletagmanager.com" ||
      hostname.endsWith(".google-analytics.com") ||
      hostname === "va.vercel-scripts.com"
    ) {
      thirdPartyRequests.push(request.url());
    }
  });
  await page.route("https://www.googletagmanager.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "/* fixture */" }),
  );
  await page.route(/https:\/\/[^/]*google-analytics\.com\/.*/u, (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.addInitScript(() => {
    const target = window as typeof window & { __vhGtagCalls: unknown[][] };
    target.__vhGtagCalls = [];
    target.gtag = (...args: unknown[]) => target.__vhGtagCalls.push(args);
  });

  await page.goto("/");
  const consent = page.getByRole("dialog", { name: "Analytics consent" });
  await consent.getByRole("button", { name: "Allow analytics" }).click();

  await page.locator("details.prototype-lab > summary").click();
  const form = page.getByRole("form", { name: "Qualification application" });
  await form.getByLabel("Your role").focus();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const target = window as typeof window & { __vhGtagCalls: unknown[][] };
        return target.__vhGtagCalls.filter((call) => call[0] === "event").length;
      }),
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Analytics settings" }).click();
  await consent.getByRole("button", { name: "Withdraw consent" }).click();
  const callsAfterWithdrawal = await page.evaluate(() => {
    const target = window as typeof window & { __vhGtagCalls: unknown[][] };
    return target.__vhGtagCalls.length;
  });
  const requestsAfterWithdrawal = thirdPartyRequests.length;

  // This validation event is GA-bound when consent exists. It must be dropped
  // after withdrawal, together with every later loader/collection request.
  await form.getByRole("button", { name: "Apply" }).click();
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() => {
      const target = window as typeof window & { __vhGtagCalls: unknown[][] };
      return target.__vhGtagCalls.length;
    }),
  ).toBe(callsAfterWithdrawal);
  expect(thirdPartyRequests).toHaveLength(requestsAfterWithdrawal);
  expect(thirdPartyRequests.some((url) => url.includes("va.vercel-scripts.com"))).toBe(false);
});

test("the private lead path fails visibly when persistence is unavailable", async ({ page }) => {
  let submittedBody = "";
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/lead") submittedBody = request.postData() ?? "";
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Decline" }).click();
  await page.locator("details.prototype-lab > summary").click();
  const form = page.getByRole("form", { name: "Qualification application" });
  await form.getByLabel("Your role").fill("Synthetic operator");
  await form.getByLabel("Company size").selectOption("1-10");
  await form.getByLabel("Budget for solving this").selectOption("100-500");
  await form.getByLabel("When do you want this solved?").selectOption("quarter");
  await form
    .getByLabel("Work email (private prototype submission field; excluded from analytics)")
    .fill("synthetic-browser@example.test");
  await form.getByRole("button", { name: "Apply" }).click();

  await expect(form.getByRole("alert")).toHaveText(
    "Could not save your application — please retry in a moment.",
  );
  expect(JSON.parse(submittedBody)).toMatchObject({
    role: "Synthetic operator",
    contact: "synthetic-browser@example.test",
  });
});
