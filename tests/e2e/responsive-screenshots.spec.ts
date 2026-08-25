import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/evidence", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
});

for (const route of ["/"] as const) {
  test(`${route} has no horizontal overflow and records a review screenshot`, async ({
    page,
  }, testInfo) => {
    await page.goto(route);
    await page.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByRole("main")).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

    const name = "home";
    const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(`${name}-${testInfo.project.name}`, {
      path,
      contentType: "image/png",
    });
  });
}
