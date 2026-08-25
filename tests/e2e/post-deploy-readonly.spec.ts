import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  if (process.env.VH_LOCAL_E2E_FIXTURE !== "1") return;

  // The local release gate deliberately runs without a live evidence store.
  // Keep this read-only surface check deterministic while leaving configured
  // deployment checks unmocked so a real persistence failure remains visible.
  await page.route("**/api/evidence", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
});

test("deployed public surface serves a read-only critical journey", async ({ page, request }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  const smoke = await request.get("/", { failOnStatusCode: false });
  expect(smoke.status(), "homepage HTTP smoke status").toBeGreaterThanOrEqual(200);
  expect(smoke.status(), "homepage HTTP smoke status").toBeLessThan(400);
  expect((await smoke.text()).length, "homepage HTTP response body").toBeGreaterThan(100);

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response, "homepage navigation response").not.toBeNull();
  expect(response!.status(), "homepage browser status").toBeLessThan(400);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("h1").first()).toBeVisible();

  const sameOriginPaths = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) => [
      ...new Set(
        links
          .map((link) => link.getAttribute("href")!)
          .filter((href) => /^\/[A-Za-z0-9]/.test(href)),
      ),
    ]);
  const secondaryPath = sameOriginPaths.find((path) => path !== "/");
  if (secondaryPath) {
    const secondary = await page.goto(secondaryPath, { waitUntil: "domcontentloaded" });
    expect(secondary, `secondary journey response for ${secondaryPath}`).not.toBeNull();
    expect(secondary!.status(), `secondary journey status for ${secondaryPath}`).toBeLessThan(400);
    await expect(page.locator("main")).toBeVisible();
  }

  expect(runtimeErrors, "browser runtime errors").toEqual([]);
});
