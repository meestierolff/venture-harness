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
  await expect(page).toHaveTitle(/Launch operating-system prototype/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /One brief becomes a launch plan you can inspect, authorize, pause, and resume/,
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

test("the private lead path fails visibly when persistence is unavailable", async ({ page }) => {
  let submittedBody = "";
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/lead") submittedBody = request.postData() ?? "";
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Decline" }).click();
  const form = page.getByRole("form", { name: "Qualification application" });
  await form.getByLabel("Your role").fill("Synthetic operator");
  await form.getByLabel("Company size").selectOption("1-10");
  await form.getByLabel("Budget for solving this").selectOption("100-500");
  await form.getByLabel("When do you want this solved?").selectOption("quarter");
  await form
    .getByLabel("Work email (used only to reply — never sent to analytics)")
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
