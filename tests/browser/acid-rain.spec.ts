import { expect, test, type Page } from "@playwright/test";

interface PracticeAcidRainState {
  readonly tick: number | null;
  readonly activeSource: string | null;
  readonly presentationKinds: readonly string[];
}

interface PracticeAcidRainHook {
  spawn(): void;
  read(): PracticeAcidRainState;
}

async function readAcidRainState(page: Page): Promise<PracticeAcidRainState> {
  return page.evaluate(() => (
    window as unknown as { __splitStackPracticeAcidRain: PracticeAcidRainHook }
  ).__splitStackPracticeAcidRain.read());
}

async function openPractice(page: Page): Promise<void> {
  await page.goto("/#name=Acid%20Rain%20Regression&addr=acid-rain@example.test");
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
}

test("live Practice Acid Rain keeps RAF simulation and the menu responsive", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openPractice(page);

  await expect.poll(() => page.evaluate(() => typeof (
    window as unknown as { __splitStackPracticeAcidRain?: PracticeAcidRainHook }
  ).__splitStackPracticeAcidRain)).toBe("object");
  await page.evaluate(() => (
    window as unknown as { __splitStackPracticeAcidRain: PracticeAcidRainHook }
  ).__splitStackPracticeAcidRain.spawn());
  await expect.poll(() => readAcidRainState(page)).toMatchObject({
    activeSource: "acid",
  });
  const spawned = await readAcidRainState(page);
  expect(spawned.presentationKinds).not.toContain("acid-rain");

  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
  await expect.poll(async () => (await readAcidRainState(page)).tick).toBeGreaterThan(
    spawned.tick ?? -1,
  );

  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Match menu" }).click();
  await expect(page.getByRole("dialog", { name: "Match menu" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
