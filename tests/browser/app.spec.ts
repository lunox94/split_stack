import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

const APP_ORIGIN = "http://127.0.0.1:3000";

async function openApp(page: Page, identity = "Browser Tester"): Promise<void> {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await page.goto(
    `/#name=${encodeURIComponent(identity)}&addr=${encodeURIComponent(`${slug}@example.test`)}`,
  );
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
}

function localScore(page: Page): Locator {
  return page.locator('[data-side="left"] [aria-label="Score"]');
}

async function numericText(locator: Locator): Promise<number> {
  const value = Number.parseInt((await locator.textContent()) ?? "", 10);
  return Number.isFinite(value) ? value : 0;
}

async function expectScoreAbove(locator: Locator, baseline: number): Promise<void> {
  await expect
    .poll(() => numericText(locator), {
      message: `expected the score to increase above ${baseline}`,
    })
    .toBeGreaterThan(baseline);
}

async function openVersusPair(
  context: BrowserContext,
  seatAPage: Page,
): Promise<{ seatA: Page; seatB: Page }> {
  await openApp(seatAPage, "Alice");
  await seatAPage.getByRole("button", { name: "Create challenge" }).click();
  await expect(seatAPage.getByRole("status")).toContainText(/waiting for an opponent/i);

  const seatBPage = await context.newPage();
  await openApp(seatBPage, "Bob");
  const joinButton = seatBPage.getByRole("button", { name: "Join challenge" });
  await expect(joinButton).toBeEnabled();
  await joinButton.click();

  await expect(seatAPage.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatAPage.getByRole("application", { name: "Opponent board" })).toBeVisible();
  await expect(seatBPage.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
  return { seatA: seatAPage, seatB: seatBPage };
}

test("lobby keeps help opt-in and exposes the complete settings surface", async ({ page }) => {
  await openApp(page);

  await expect(page.getByRole("button", { name: "Practice", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to Play" })).toBeHidden();

  await page.getByRole("button", { name: "How to Play" }).click();
  await expect(page.getByRole("heading", { name: "How to Play" })).toBeVisible();
  await expect(page.getByText(/keep your stack below the top/i)).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Power Glossary" }).click();
  await expect(page.getByRole("heading", { name: "Power Glossary" })).toBeVisible();
  await expect(page.getByText("Blackout", { exact: true })).toBeVisible();
  await expect(page.getByText("Acid Rain", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Practice Controls" }).click();
  await expect(page.getByRole("heading", { name: "Practice Controls" })).toBeVisible();
  await expect(page.getByText(/arrows or A\/D\/S/i)).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Effects audio")).toBeChecked();
  await expect(page.getByLabel("Effects volume")).toHaveAttribute("type", "range");
  await expect(page.getByLabel("Touch controls")).toHaveValue("gestures");
  await expect(page.getByLabel("Gameplay tips")).not.toBeChecked();
});

test("Practice accepts keyboard and compact touch-button actions", async ({ page }) => {
  await openApp(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Touch controls").selectOption("buttons");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  const board = page.getByRole("application", { name: "Your board" });
  const hold = page.locator('[data-side="left"] .hud-detail').filter({ hasText: /^Hold:/ });
  await expect(board).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause practice" })).toBeVisible();

  await page.keyboard.press("c");
  await expect(hold).not.toContainText("—");

  const keyboardBaseline = await numericText(localScore(page));
  await page.keyboard.press("Space");
  await expectScoreAbove(localScore(page), keyboardBaseline);

  await page.getByRole("button", { name: "Hold piece" }).click();
  const touchBaseline = await numericText(localScore(page));
  await page.getByRole("button", { name: "Hard drop" }).click();
  await expectScoreAbove(localScore(page), touchBaseline);
});

test("versus boards stay visible, side by side, and equal at 360 by 640", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const { seatA, seatB } = await openVersusPair(context, page);

  const leftPane = seatA.locator('.player-pane[data-side="left"]');
  const rightPane = seatA.locator('.player-pane[data-side="right"]');
  const leftBoard = seatA.getByRole("application", { name: "Your board" });
  const rightBoard = seatA.getByRole("application", { name: "Opponent board" });

  await expect
    .poll(async () => {
      const [left, right] = await Promise.all([leftBoard.boundingBox(), rightBoard.boundingBox()]);
      return left !== null && right !== null && left.width > 0 && right.width > 0;
    })
    .toBe(true);

  const [leftPaneBox, rightPaneBox, leftBoardBox, rightBoardBox] = await Promise.all([
    leftPane.boundingBox(),
    rightPane.boundingBox(),
    leftBoard.boundingBox(),
    rightBoard.boundingBox(),
  ]);
  expect(leftPaneBox).not.toBeNull();
  expect(rightPaneBox).not.toBeNull();
  expect(leftBoardBox).not.toBeNull();
  expect(rightBoardBox).not.toBeNull();

  expect(leftPaneBox!.width).toBeCloseTo(180, 0);
  expect(rightPaneBox!.width).toBeCloseTo(180, 0);
  expect(rightPaneBox!.x).toBeCloseTo(leftPaneBox!.x + leftPaneBox!.width, 0);
  expect(rightPaneBox!.y).toBeCloseTo(leftPaneBox!.y, 0);
  expect(leftBoardBox!.width).toBeCloseTo(rightBoardBox!.width, 0);
  expect(leftBoardBox!.height).toBeCloseTo(rightBoardBox!.height, 0);
  expect(leftBoardBox!.x + leftBoardBox!.width).toBeLessThanOrEqual(180.5);
  expect(rightBoardBox!.x).toBeGreaterThanOrEqual(179.5);
  expect(leftBoardBox!.y).toBeGreaterThanOrEqual(0);
  expect(rightBoardBox!.y + rightBoardBox!.height).toBeLessThanOrEqual(640.5);

  await seatB.close();
});

test("a durably confirmed newer runtime replaces a duplicate and a seat release returns the peer to lobby", async ({
  context,
  page,
}) => {
  const { seatA, seatB: olderSeatB } = await openVersusPair(context, page);
  const newerSeatB = await context.newPage();
  await newerSeatB.goto("/#name=Bob&addr=bob%40example.test");
  await expect(newerSeatB.getByRole("main", { name: "Split Stack" })).toBeVisible();

  await expect(
    newerSeatB.getByRole("application", { name: "Your board" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(olderSeatB.getByText(/newer open Split Stack session/i)).toBeVisible({
    timeout: 15_000,
  });

  await newerSeatB.getByRole("button", { name: "Leave match" }).click();
  await expect(seatA.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatA.getByRole("status")).toContainText(/waiting for an opponent/i);

  await olderSeatB.close();
  await newerSeatB.close();
});

test("reduced-effects preference is applied immediately and persists", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Settings" }).click();

  const reducedEffects = page.getByLabel("Reduced effects and 30 FPS");
  await reducedEffects.check();
  await expect(page.locator(".split-stack-app")).toHaveAttribute(
    "data-reduced-effects",
    "true",
  );

  await page.reload();
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Reduced effects and 30 FPS")).toBeChecked();
  await expect(page.locator(".split-stack-app")).toHaveAttribute(
    "data-reduced-effects",
    "true",
  );
});

test("load and Practice make no external HTTP requests", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== APP_ORIGIN) {
      externalRequests.push(request.url());
    }
  });

  await openApp(page, "Offline Tester");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
  await page.keyboard.press("Space");
  await expectScoreAbove(localScore(page), 0);

  expect(externalRequests).toEqual([]);
});

test("Practice pauses for a real WebGL context loss and survives restoration", async ({ page }) => {
  await openApp(page, "Context Tester");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();

  const canLoseContext = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.game-canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (extension === null || extension === undefined) return false;
    (window as unknown as Record<string, unknown>).__splitStackWebglLoss = extension;
    extension.loseContext();
    return true;
  });
  test.skip(!canLoseContext, "WEBGL_lose_context is unavailable in this browser");

  await expect(page.getByText(/display interrupted.*WebGL recovers/i)).toBeVisible();

  const restored = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.game-canvas");
    const extension = (window as unknown as Record<string, unknown>).__splitStackWebglLoss as
      | { restoreContext(): void }
      | undefined;
    if (canvas === null || extension === undefined) return false;
    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 3_000);
      canvas.addEventListener(
        "webglcontextrestored",
        () => {
          window.clearTimeout(timeout);
          resolve(true);
        },
        { once: true },
      );
      extension.restoreContext();
    });
  });

  expect(restored).toBe(true);
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
  await expect(page.getByRole("button", { name: /practice/i })).toBeVisible();
});
