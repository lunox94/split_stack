import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { RULES_HASH } from "../../src/config/rules-hash";
import { RULES } from "../../src/config/rules";
import { hashCanonicalHex } from "../../src/domain/hashing";
import { NETWORK_DIAGNOSTICS_STORAGE_KEY } from "../../src/network/diagnostics";

const APP_ORIGIN = "http://127.0.0.1:3000";

async function openApp(page: Page, identity = "Browser Tester"): Promise<void> {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await page.goto(
    `/#name=${encodeURIComponent(identity)}&addr=${encodeURIComponent(`${slug}@example.test`)}`,
  );
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function seedCompletedMatch(page: Page): Promise<void> {
  const challengeId = "reload-challenge";
  const matchId = `${challengeId}:round:1`;
  const seed = "00112233445566778899aabbccddeeff";
  const alice = { id: "alice@example.test", displayName: "Alice" };
  const bob = { id: "bob@example.test", displayName: "Bob" };
  const configHash = hashCanonicalHex({
    rulesVersion: RULES.rulesVersion,
    rulesHash: RULES_HASH,
    seed,
    seatAPlayerId: alice.id,
    seatBPlayerId: bob.id,
  });
  const emptyStats = {
    score: 0,
    lines: 0,
    garbageSent: 0,
    powersActivated: 0,
    tetrises: 0,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  };
  const payloads = [
    {
      schema: "split-stack/lobby/v1",
      kind: "challenge-created",
      eventId: "challenge-created",
      logicalClock: 1,
      challengeId,
      actor: alice,
      seatBVacancyId: "vacancy-b",
      rulesHash: RULES_HASH,
    },
    {
      schema: "split-stack/lobby/v1",
      kind: "seat-claimed",
      eventId: "seat-b-claimed",
      logicalClock: 2,
      challengeId,
      actor: bob,
      vacancyId: "vacancy-b",
    },
    {
      schema: "split-stack/session-claim/v1",
      kind: "session-claim",
      challengeId,
      occupancyEventId: "challenge-created",
      runtimeSessionId: "old-runtime-a",
      actor: alice,
      logicalClock: 3,
      eventId: "seat-a-session",
    },
    {
      schema: "split-stack/session-claim/v1",
      kind: "session-claim",
      challengeId,
      occupancyEventId: "seat-b-claimed",
      runtimeSessionId: "old-runtime-b",
      actor: bob,
      logicalClock: 4,
      eventId: "seat-b-session",
    },
    {
      schema: "split-stack/match-announcement/v1",
      eventId: "round-one-announcement",
      logicalClock: 5,
      challengeId,
      matchId,
      round: 1,
      rulesHash: RULES_HASH,
      configHash,
      seed,
      seedHash: hashCanonicalHex({ seed }),
      seatAPlayerId: alice.id,
      seatBPlayerId: bob.id,
      actor: alice,
    },
    {
      schema: "split-stack/result/v1",
      matchId,
      seedHash: hashCanonicalHex({ seed }),
      players: [alice, bob],
      outcome: "seat-a",
      reason: "top-out",
      durationTicks: 600,
      finalLevel: 1,
      statsByPlayer: {
        [alice.id]: { ...emptyStats, score: 2_400, lines: 12 },
        [bob.id]: { ...emptyStats, topOutTick: 600 },
      },
      completedBy: alice.id,
    },
  ];
  const updates = payloads.map((payload, index) => ({
    payload,
    serial: index + 1,
    _sender: index === 1 || index === 3 ? bob.id : alice.id,
  }));
  await page.addInitScript((records) => {
    window.localStorage.setItem("__xdcUpdatesKey__", JSON.stringify(records));
  }, updates);
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

async function enforceSingleRealtimeListener(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const lifecycle = {
      joins: 0,
      leaves: 0,
      listeners: 0,
      active: 0,
      maxActive: 0,
    };
    (window as unknown as { __splitStackRealtimeLifecycle: typeof lifecycle })
      .__splitStackRealtimeLifecycle = lifecycle;
    let failNextJoin = false;
    (
      window as unknown as {
        __splitStackFailNextRealtimeJoin: () => void;
      }
    ).__splitStackFailNextRealtimeJoin = () => {
      failNextJoin = true;
    };
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const join = host.joinRealtimeChannel?.bind(host);
        let backingChannel: WebxdcRealtimeChannel | undefined;
        if (join !== undefined) {
          host.joinRealtimeChannel = () => {
            lifecycle.joins += 1;
            if (lifecycle.active > 0) {
              throw new Error("realtime listener already exists");
            }
            if (failNextJoin) {
              failNextJoin = false;
              throw new Error("realtime channel temporarily unavailable");
            }
            const channel = (backingChannel ??= join());
            lifecycle.active += 1;
            lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active);
            let facadeActive = true;
            return {
              setListener: (listener) => {
                if (!facadeActive) throw new Error("realtime listener has left");
                lifecycle.listeners += 1;
                channel.setListener((data) => {
                  if (facadeActive) listener(data);
                });
              },
              send: (data) => {
                if (!facadeActive) throw new Error("realtime listener has left");
                channel.send(data);
              },
              leave: () => {
                if (!facadeActive) return;
                facadeActive = false;
                lifecycle.leaves += 1;
                lifecycle.active -= 1;
              },
            };
          };
        }
        installedHost = host;
      },
    });
  });
}

async function installMonotonicOffset(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const realNow = performance.now.bind(performance);
    let offsetMs = 0;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => realNow() + offsetMs,
    });
    (
      window as unknown as {
        __splitStackAdvanceMonotonic: (milliseconds: number) => void;
      }
    ).__splitStackAdvanceMonotonic = (milliseconds) => {
      offsetMs += milliseconds;
    };
  });
}

async function advanceMonotonic(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((amount) => {
    (
      window as unknown as {
        __splitStackAdvanceMonotonic: (milliseconds: number) => void;
      }
    ).__splitStackAdvanceMonotonic(amount);
  }, milliseconds);
}

async function setVisibilityState(
  page: Page,
  visibilityState: "hidden" | "visible",
): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibilityState);
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
  await expect(page.getByLabel("Effects", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Effects volume")).toHaveAttribute("type", "range");
  await expect(page.getByLabel("Music", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Music volume")).toHaveAttribute("type", "range");
  await expect(page.getByLabel("Touch controls")).toHaveValue("gestures");
  await expect(page.getByLabel("Gameplay tips")).not.toBeChecked();
  await page.getByRole("button", { name: "Clear diagnostics" }).click();
  await expect(page.getByText("Diagnostics cleared.")).toBeVisible();
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

test("gesture controls accept a hard-drop flick over the opponent board", async ({
  context,
  page,
}) => {
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });

  await expect(seatA.locator(".split-stack-app")).toHaveCSS("touch-action", "none");

  const opponentBoard = seatA.getByRole("application", { name: "Opponent board" });
  const bounds = await opponentBoard.boundingBox();
  expect(bounds).not.toBeNull();
  const x = Math.floor(bounds!.x + bounds!.width / 2);
  const startY = Math.floor(bounds!.y + bounds!.height * 0.25);
  const baseline = await numericText(localScore(seatA));

  await seatA.mouse.move(x, startY);
  await seatA.mouse.down();
  await seatA.mouse.move(x, startY + Math.max(90, bounds!.height * 0.3), { steps: 2 });
  await seatA.mouse.up();

  await expectScoreAbove(localScore(seatA), baseline);
  await seatB.close();
});

test("replaces a silent competitive channel without registering a second listener", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installMonotonicOffset(context);
  await enforceSingleRealtimeListener(context);

  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(seatA.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await expect(seatB.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await Promise.all([advanceMonotonic(seatA, 4_000), advanceMonotonic(seatB, 4_000)]);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });

  await seatB.close();
  await advanceMonotonic(seatA, RULES.network.missingPeerMs + 1);
  await expect(seatA.getByText(/connection unstable/i)).toBeVisible({ timeout: 5_000 });
  await advanceMonotonic(
    seatA,
    RULES.network.reconnectingMs - RULES.network.missingPeerMs,
  );
  await expect(seatA.getByText(/reconnecting/i)).toBeVisible({ timeout: 5_000 });

  await expect
    .poll(
      () =>
        seatA.evaluate(
          () =>
            (
              window as unknown as {
                __splitStackRealtimeLifecycle: { joins: number };
              }
            ).__splitStackRealtimeLifecycle.joins,
        ),
      { timeout: 5_000 },
    )
    .toBe(2);
  expect(
    await seatA.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: {
              joins: number;
              leaves: number;
              listeners: number;
              active: number;
              maxActive: number;
            };
          }
        ).__splitStackRealtimeLifecycle,
    ),
  ).toEqual({ joins: 2, leaves: 1, listeners: 2, active: 1, maxActive: 1 });

  await seatA.evaluate(() => {
    (
      window as unknown as {
        __splitStackFailNextRealtimeJoin: () => void;
      }
    ).__splitStackFailNextRealtimeJoin();
  });
  await setVisibilityState(seatA, "hidden");
  await setVisibilityState(seatA, "visible");
  await advanceMonotonic(seatA, RULES.network.reconnectingMs);

  await expect
    .poll(
      () =>
        seatA.evaluate(
          () =>
            (
              window as unknown as {
                __splitStackRealtimeLifecycle: { joins: number };
              }
            ).__splitStackRealtimeLifecycle.joins,
        ),
      { timeout: 5_000 },
    )
    .toBe(4);
  expect(pageErrors).toEqual([]);
  expect(
    await seatA.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: {
              joins: number;
              leaves: number;
              listeners: number;
              active: number;
              maxActive: number;
            };
          }
        ).__splitStackRealtimeLifecycle,
    ),
  ).toEqual({ joins: 4, leaves: 2, listeners: 3, active: 1, maxActive: 1 });
  expect(
    await seatA.evaluate((storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (serialized === null) return [];
      const snapshot = JSON.parse(serialized) as {
        incidents: Array<{ events: Array<{ kind: string }> }>;
      };
      const latest = snapshot.incidents[snapshot.incidents.length - 1];
      return latest?.events.map((event) => event.kind) ?? [];
    }, NETWORK_DIAGNOSTICS_STORAGE_KEY),
  ).toContain("channel-replacement-failed");
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

test("versus boards remain equal and side by side in landscape", async ({ context, page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  const { seatA, seatB } = await openVersusPair(context, page);
  const left = seatA.getByRole("application", { name: "Your board" });
  const right = seatA.getByRole("application", { name: "Opponent board" });

  const [leftBox, rightBox] = await Promise.all([left.boundingBox(), right.boundingBox()]);
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(leftBox!.width).toBeCloseTo(rightBox!.width, 0);
  expect(leftBox!.height).toBeCloseTo(rightBox!.height, 0);
  expect(rightBox!.x).toBeGreaterThan(leftBox!.x + leftBox!.width - 1);
  expect(rightBox!.y).toBeCloseTo(leftBox!.y, 0);
  expect(rightBox!.x + rightBox!.width).toBeLessThanOrEqual(640.5);
  expect(rightBox!.y + rightBox!.height).toBeLessThanOrEqual(360.5);

  await seatB.close();
});

test("a third participant joins an active challenge as a read-only spectator", async ({
  context,
  page,
}) => {
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready", exact: true }).click();

  const spectator = await context.newPage();
  await spectator.goto("/#name=Charlie&addr=charlie%40example.test");
  await expect(spectator.getByRole("application", { name: "Seat A board" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(spectator.getByRole("application", { name: "Seat B board" })).toBeVisible();
  await expect(spectator.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await spectator.close();
  await seatB.close();
});

test("leaving an active match records a forfeit before releasing the seat", async ({
  context,
  page,
}) => {
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });

  await seatB.getByRole("button", { name: "Leave match" }).click();

  await expect(seatA.getByRole("heading", { name: "Victory" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(seatA.getByRole("button", { name: "Rematch" })).toBeHidden();
  await expect(seatB.getByRole("heading", { name: "Split Stack" })).toBeVisible();

  await seatB.close();
});

test("leaving during a failed realtime join closes the challenge and cancels its retry", async ({
  context,
  page,
}) => {
  test.setTimeout(35_000);
  await enforceSingleRealtimeListener(context);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();
  await expect(page.getByRole("status")).toContainText(/waiting for an opponent/i);

  const seatB = await context.newPage();
  await openApp(seatB, "Bob");
  const joinButton = seatB.getByRole("button", { name: "Join challenge" });
  await expect(joinButton).toBeEnabled();
  await page.evaluate(() => {
    (
      window as unknown as {
        __splitStackFailNextRealtimeJoin: () => void;
      }
    ).__splitStackFailNextRealtimeJoin();
  });
  await joinButton.click();

  await expect(
    page.getByText("Live play is unavailable here. You can still use Practice."),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Leave match" }).click();
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await expect(seatB.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: 15_000,
  });

  const joinsAfterLeave = await page.evaluate(
    () =>
      (
        window as unknown as {
          __splitStackRealtimeLifecycle: { joins: number };
        }
      ).__splitStackRealtimeLifecycle.joins,
  );
  await page.waitForTimeout(RULES.network.reconnectingMs + 500);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: { joins: number };
          }
        ).__splitStackRealtimeLifecycle.joins,
    ),
  ).toBe(joinsAfterLeave);
  expect(pageErrors).toEqual([]);

  await seatB.close();
});

test("a durably confirmed newer runtime replaces a duplicate and a seat release returns the peer to lobby", async ({
  context,
  page,
}) => {
  await enforceSingleRealtimeListener(context);
  const { seatA, seatB: olderSeatB } = await openVersusPair(context, page);
  const olderSeatBErrors: string[] = [];
  olderSeatB.on("pageerror", (error) => olderSeatBErrors.push(error.message));
  await olderSeatB.evaluate(() => {
    (
      window as unknown as {
        __splitStackFailNextRealtimeJoin: () => void;
      }
    ).__splitStackFailNextRealtimeJoin();
  });
  const newerSeatB = await context.newPage();
  await newerSeatB.goto("/#name=Bob&addr=bob%40example.test");
  await expect(newerSeatB.getByRole("main", { name: "Split Stack" })).toBeVisible();

  await expect(
    newerSeatB.getByRole("application", { name: "Your board" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(olderSeatB.getByText(/newer open Split Stack session/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      () =>
        olderSeatB.evaluate(
          () =>
            (
              window as unknown as {
                __splitStackRealtimeLifecycle: { joins: number };
              }
            ).__splitStackRealtimeLifecycle.joins,
        ),
      { timeout: 10_000 },
    )
    .toBe(3);

  await newerSeatB.getByRole("button", { name: "Leave match" }).click();
  await expect(seatA.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatA.getByRole("status")).toContainText(/waiting for an opponent/i);
  expect(olderSeatBErrors).toEqual([]);

  await olderSeatB.close();
  await newerSeatB.close();
});

test("a completed competitive match reloads into results and keeps rematch available", async ({ page }) => {
  await seedCompletedMatch(page);
  await page.goto("/#name=Alice&addr=alice%40example.test");
  await expect(page.getByRole("main", { name: "Split Stack" })).toBeVisible();

  const victory = page.getByRole("heading", { name: "Victory" });
  const rematch = page.getByRole("button", { name: "Rematch" });
  await expect(victory).toBeVisible({ timeout: 15_000 });
  await expect(rematch).toBeVisible();

  await page.reload();

  await expect(victory).toBeVisible({ timeout: 15_000 });
  await expect(rematch).toBeVisible();
  await rematch.click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
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
