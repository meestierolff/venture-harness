import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/evidence", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
});

test("landmarks, names, consent controls, and keyboard focus are usable", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  const dialog = page.getByRole("dialog", { name: "Analytics consent" });
  await expect(dialog.getByRole("button", { name: "Allow analytics" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Decline" })).toBeVisible();
  await dialog.getByRole("button", { name: "Decline" }).click();

  const form = page.getByRole("form", { name: "Qualification application" });
  for (const label of [
    "Your role",
    "Company size",
    "Budget for solving this",
    "When do you want this solved?",
    "Work email (used only to reply — never sent to analytics)",
    "Anything we should know? (optional)",
  ]) {
    await expect(form.getByLabel(label)).toBeVisible();
  }

  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveCount(1);
  const outline = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.flatMap((node) => node.target.map(String)),
    })),
  ).toEqual([]);
});
