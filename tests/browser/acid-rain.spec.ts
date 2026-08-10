import { expect, test, type Page } from "@playwright/test";

async function openPractice(page: Page): Promise<void> {
  await page.goto("/#name=Acid%20Rain%20Regression&addr=acid-rain@example.test");
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
}

test("Practice Acid Rain projects spawned projectiles without stopping interaction", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openPractice(page);

  const projection = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const [{ boardModelFromSimulation }, { RULES }, { createSimulation }] = await Promise.all([
      load("/src/app/view-model.ts"),
      load("/src/config/rules.ts"),
      load("/src/domain/simulation.ts"),
    ]);
    const practice = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "acid-rain-regression",
      practice: true,
    });
    practice.activatePower("acid-rain");
    practice.tick(RULES.timing.powerImpactTicks);
    practice.dispatch("hard-drop");
    const snapshot = practice.readSnapshot();
    const board = boardModelFromSimulation(snapshot, true, false);
    return {
      activeSource: snapshot.player.active?.descriptor.source ?? null,
      activeKinds: board.cells
        .filter((cell: { readonly role: string }) => cell.role === "active")
        .map((cell: { readonly kind: string }) => cell.kind),
      tickBefore: practice.currentTick(),
      tickAfter: practice.tick(1).length + practice.currentTick(),
    };
  });

  expect(projection.activeSource).toBe("acid");
  expect(projection.activeKinds).toEqual(["acid"]);
  expect(projection.tickAfter).toBeGreaterThan(projection.tickBefore);
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Match menu" }).click();
  await expect(page.getByRole("dialog", { name: "Match menu" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("Acid Rain activation has no hard-coded three-drop presentation cue", async ({ page }) => {
  await openPractice(page);

  const cueKinds = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const [{ PresentationRouter }, { RULES }, { createSimulation }] = await Promise.all([
      load("/src/app/presentation-router.ts"),
      load("/src/config/rules.ts"),
      load("/src/domain/simulation.ts"),
    ]);
    const cues: string[] = [];
    const router = new PresentationRouter({
      schedule: (cue: { readonly kind: string }) => cues.push(cue.kind),
    }, () => 0);
    const practice = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "acid-rain-presentation",
      practice: true,
    });
    router.consumeSimulationEffects(practice.activatePower("acid-rain"), "left");
    router.consumeSimulationEffects(practice.tick(RULES.timing.powerImpactTicks), "left");
    return cues;
  });

  expect(cueKinds).not.toContain("acid-rain");
});
