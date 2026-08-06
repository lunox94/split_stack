import { expect, test } from "@playwright/test";

async function openBoardStatusHarness(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/#name=Effects%20Tester&addr=effects%40example.test");
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await page.locator(".arena").evaluate((arena) => {
    const match = arena.parentElement as HTMLElement;
    match.hidden = false;
    match.style.zIndex = "10";
  });
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
}

test("keeps Special Pieces readable and cycling without narrow-screen overflow", async ({
  page,
}) => {
  await page.goto("/#name=Help%20Tester&addr=help%40example.test");
  await page.getByRole("button", { name: "How to Play" }).click();
  const heading = page.getByRole("heading", { name: "How to Play" });
  await expect(heading).toBeVisible();

  const helpScreen = heading.locator("xpath=../..");
  const illustrations = page.locator(
    '[data-help-group="pieces"] .special-piece-illustration',
  );
  await expect(illustrations).toHaveCount(3);
  await illustrations.first().scrollIntoViewIfNeeded();

  const narrow = (page.viewportSize()?.width ?? 0) <= 520;
  const expectedIllustration = narrow
    ? { width: 72, height: 64, gridWidth: 60 }
    : { width: 88, height: 72, gridWidth: 68 };
  for (const illustration of await illustrations.all()) {
    const [sampleBounds, gridBounds] = await Promise.all([
      illustration.boundingBox(),
      illustration.locator(".piece-preview-grid").boundingBox(),
    ]);
    if (sampleBounds === null || gridBounds === null) {
      throw new Error("Expected a visible Special Piece illustration");
    }
    expect(sampleBounds.width).toBeCloseTo(expectedIllustration.width, 0);
    expect(sampleBounds.height).toBeCloseTo(expectedIllustration.height, 0);
    expect(gridBounds.width).toBeCloseTo(expectedIllustration.gridWidth, 0);
  }

  const glitch = page.locator(
    '[data-help-group="pieces"] .special-piece-illustration[data-source="glitch"]',
  );
  const firstShape = await glitch.getAttribute("data-display-shape");
  await expect.poll(() => glitch.getAttribute("data-display-shape")).not.toBe(
    firstShape,
  );
  expect(
    await helpScreen.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
});

test("keeps Scramble and Blackout presentation board-local and accessible", async ({
  page,
}) => {
  await openBoardStatusHarness(page);
  const app = page.locator(".split-stack-app");
  const pane = page.locator('.player-pane[data-side="left"]');
  const board = page.getByRole("application", { name: "Your board" });
  const before = await board.boundingBox();

  await pane.evaluate((element) => {
    (element as HTMLElement).dataset.scrambled = "true";
  });
  await expect.poll(
    () => board.evaluate((element) => getComputedStyle(element, "::before").opacity),
  ).toBe("1");

  const scrambleStyle = await board.evaluate((element) => {
    const target = getComputedStyle(element);
    const perimeter = getComputedStyle(element, "::before");
    const paneStyle = getComputedStyle(element.parentElement!, "::before");
    return {
      animationDuration: perimeter.animationDuration,
      animationName: perimeter.animationName,
      borderColor: target.borderColor,
      opacity: perimeter.opacity,
      outerContent: paneStyle.content,
      transitionDuration: perimeter.transitionDuration,
    };
  });
  expect(scrambleStyle).toMatchObject({
    animationDuration: "0.65s, 0.22s",
    borderColor: "rgba(0, 0, 0, 0)",
    opacity: "1",
    outerContent: "none",
    transitionDuration: "0.15s",
  });
  expect(scrambleStyle.animationName).toContain("scramble-board-ants");
  expect(await board.boundingBox()).toEqual(before);

  await app.evaluate((element) => {
    (element as HTMLElement).dataset.reducedMotion = "true";
  });
  expect(
    await board.evaluate((element) =>
      getComputedStyle(element, "::before").animationName
    ),
  ).toBe("none");

  await app.evaluate((element) => {
    (element as HTMLElement).dataset.reducedMotion = "false";
  });
  const cover = pane.locator(".blackout-cover");
  await cover.evaluate((element) => {
    (element as HTMLElement).hidden = false;
  });
  const coverBounds = await cover.boundingBox();
  const icon = cover.locator('[data-special-icon="blackout"]');
  const iconBounds = await icon.boundingBox();
  if (coverBounds === null || iconBounds === null) {
    throw new Error("Expected visible Blackout presentation");
  }

  expect(coverBounds).toEqual(before);
  expect(iconBounds.width).toBeGreaterThanOrEqual(48);
  expect(iconBounds.width).toBeLessThanOrEqual(88);
  await expect(cover).toHaveAttribute("aria-label", "Board concealed by Blackout");
  await expect(cover).toHaveText("");
  expect(
    await icon.evaluate((element) => getComputedStyle(element).animationDuration),
  ).toBe("1.8s");
  expect(
    await icon.evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(155, 123, 255)");

  await app.evaluate((element) => {
    (element as HTMLElement).dataset.reducedFlashes = "true";
  });
  await pane.evaluate((element) => {
    (element as HTMLElement).dataset.scrambled = "false";
  });
  expect(
    await board.evaluate((element) => ({
      border: getComputedStyle(element).transitionDuration,
      perimeter: getComputedStyle(element, "::before").transitionDuration,
    })),
  ).toEqual({ border: "0s", perimeter: "0s" });
  expect(
    await icon.evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

test("reserves a permanent Barrier channel below the board", async ({
  page,
}) => {
  await openBoardStatusHarness(page);
  const pane = page.locator('.player-pane[data-side="left"]');
  const board = page.getByRole("application", { name: "Your board" });
  const channel = pane.getByRole("meter", { name: "Barrier capacity" });
  const segments = channel.locator(".barrier-capacity-segment");

  await expect(channel).toBeVisible();
  await expect(segments).toHaveCount(4);
  const [boardBounds, channelBounds] = await Promise.all([
    board.boundingBox(),
    channel.boundingBox(),
  ]);
  if (boardBounds === null || channelBounds === null) {
    throw new Error("Expected visible board and Barrier capacity channel");
  }
  expect(channelBounds.y - (boardBounds.y + boardBounds.height)).toBeCloseTo(1, 0);
  expect(channelBounds.height).toBe(4);
  expect(channelBounds.width).toBeCloseTo(boardBounds.width, 0);
  expect(
    await segments.first().evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgba(29, 43, 59, 0.96)");

  await segments.evaluateAll((items) => {
    items.slice(0, 2).forEach((item) => item.classList.add("is-filled"));
  });
  await expect.poll(
    () => segments.first().evaluate((element) =>
      getComputedStyle(element).backgroundColor
    ),
  ).toBe("rgb(87, 230, 255)");
});
