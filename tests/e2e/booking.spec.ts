import { expect, test } from "@playwright/test";
import { resetDb, seedEntries } from "./helpers/db";
import { receivedRequests, resetMock } from "./helpers/jira-mock";

test.beforeEach(async () => {
  await resetDb();
  await resetMock();
});

test("timer stop → book worklog to Jira", async ({ page }) => {
  // A timer that has been running for 30 minutes on a concrete issue. 30 min is
  // well over the 1-minute floor, so stopping keeps the entry (bookable).
  await seedEntries([
    {
      description: "TXR-1 e2e worklog",
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
  ]);

  await page.goto("/");

  // Stop the running timer through the UI.
  await page.getByRole("button", { name: "Timer stoppen" }).click();

  // The stopped entry is now bookable → the header booking button appears.
  const bookButton = page.getByRole("button", { name: "Nach Jira buchen (1)" });
  await expect(bookButton).toBeVisible();
  await bookButton.click();

  // The submit dialog previews exactly one planned worklog.
  await expect(page.getByText("Worklogs (1)")).toBeVisible();
  await page.getByRole("button", { name: "Jetzt buchen" }).click();

  await expect(page.getByText(/Erfolgreich gebucht: 1 Worklog/)).toBeVisible();

  // Jira actually received the worklog POST with the right issue + duration.
  const posts = (await receivedRequests()).filter(
    (r) => r.method === "POST" && r.path === "/rest/api/2/issue/TXR-1/worklog",
  );
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0].body)).toMatchObject({ timeSpent: "30m" });
});
