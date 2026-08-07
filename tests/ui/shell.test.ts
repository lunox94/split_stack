// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "../../src/persistence/settings";
import { calculateRendererLayout } from "../../src/render/renderer";
import { SPECIAL_ICON_PATHS } from "../../src/render/special-icons";
import {
  createAppShell,
  hideGameplayPowerTip,
  positionGameplayTip,
  positionHudToViewport,
  positionMatchMenuButton,
  renderTimedEffects,
  setHudGarbage,
  setElementHidden,
  setHudPower,
  setMatchMenu,
  setPowerMeterAccessibility,
  showHelp,
  showGameplayPowerTip,
} from "../../src/ui/shell";

describe("application shell", () => {
  it("separates the fast Home actions from the sectioned Lobby", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.home).not.toBe(shell.lobby);
    expect(shell.home.hidden).toBe(false);
    expect(shell.lobby.hidden).toBe(true);
    expect(shell.home.querySelector(".brand-title")?.textContent).toBe("Split Stack");
    expect(shell.createButton.textContent).toBe("Create challenge");
    expect(shell.practiceButton.textContent).toBe("Practice");
    expect(shell.lobbyButton.textContent).toContain("Lobby");
    expect(shell.home.contains(shell.joinButton)).toBe(false);
    expect([...shell.lobbyButton.parentElement!.children]).toEqual([
      shell.createButton.closest(".home-challenge-action"),
      shell.lobbyButton,
      shell.practiceButton,
    ]);

    shell.show("lobby");

    expect(shell.home.hidden).toBe(true);
    expect(shell.lobby.hidden).toBe(false);
    expect(shell.lobby.querySelector("h2")?.textContent).toBe("Lobby");
    expect(shell.lobbyBackButton.textContent).toBe("Home");
    expect(shell.yourActivity.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Your activity");
    expect(shell.openChallenges.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Open challenges");
    expect(shell.startingSoon.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Starting soon");
    expect(shell.liveGames.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Live games");
    expect(shell.history.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Recent results");
    expect(shell.standings.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Standings");
    expect(shell.practiceLeaderboard.closest("section")?.querySelector("h3")?.textContent)
      .toBe("Practice leaderboard");
    for (const body of [
      shell.yourActivity,
      shell.openChallenges,
      shell.startingSoon,
      shell.liveGames,
      shell.history,
      shell.standings,
      shell.practiceLeaderboard,
    ]) {
      const region = body.closest("section");
      expect(region?.getAttribute("aria-labelledby"))
        .toBe(region?.querySelector("h3")?.id);
      expect(body.querySelector('[data-empty-state="true"]')).not.toBeNull();
    }
    expect(shell.openChallenges.textContent).toContain("No one is waiting");
    expect(shell.liveGames.textContent).toContain("No games are live");
    expect(shell.standings.textContent).toContain("No competitive standings");
  });

  it("consolidates waiting actions without duplicating Lobby or status copy", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.createButton.hidden).toBe(false);
    expect(shell.homeWaiting.hidden).toBe(true);

    shell.setHomeChallengeWaiting(true);
    shell.setLobbyActivityCounts(2, 3);
    shell.setPracticeRecords({
      personalBest: 82_400,
      chatRecord: { score: 103_750, playerName: "Marta" },
    });

    expect(shell.createButton.hidden).toBe(true);
    expect(shell.homeWaiting.hidden).toBe(false);
    expect(shell.homeWaiting.querySelector('[role="status"]')?.getAttribute("aria-live"))
      .toBe("polite");
    expect(
      [...shell.home.querySelectorAll("[role=status]")]
        .filter((status) => status.textContent?.includes("Waiting for an opponent")),
    ).toHaveLength(1);
    expect(shell.cancelChallengeButton.textContent).toBe("Cancel challenge");
    expect(shell.cancelChallengeButton.classList).toContain("destructive");
    expect(shell.viewLobbyButton.textContent).toContain("Lobby");
    expect(shell.viewLobbyButton.textContent).toContain("2 waiting · 3 live");
    expect(shell.lobbyButton.hidden).toBe(true);
    const visibleLobbyActions = [...shell.home.querySelectorAll("button")].filter(
      (action) =>
        action.textContent?.includes("Lobby") &&
        !action.hidden &&
        action.closest("[hidden]") === null,
    );
    expect(visibleLobbyActions).toEqual([shell.viewLobbyButton]);
    expect(shell.practiceButton.hidden).toBe(false);
    expect(shell.homeWaiting.contains(shell.practiceButton)).toBe(false);
    expect(
      shell.homeWaiting.compareDocumentPosition(shell.practiceButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(shell.personalPracticeRecord.closest("section")?.getAttribute("aria-label"))
      .toBe("Practice records");
    expect(shell.lobbyActivity.textContent).toBe("2 waiting · 3 live");
    expect(shell.lobbySummary.textContent).toBe("2 waiting · 3 live");
    expect(shell.lobbyButton.getAttribute("aria-label"))
      .toBe("Lobby · 2 waiting · 3 live");
    expect(shell.personalPracticeRecord.textContent).toBe("Your best: 82400");
    expect(shell.chatPracticeRecord.textContent).toBe("Chat record: 103750 · Marta");

    shell.setPracticeRecords({ personalBest: 82_400 });
    shell.setHomeChallengeWaiting(false);

    expect(shell.chatPracticeRecord.textContent).toBe("No Practice record yet");
    expect(shell.createButton.hidden).toBe(false);
    expect(shell.homeWaiting.hidden).toBe(true);
    expect(shell.lobbyButton.hidden).toBe(false);
  });

  it("keeps live-controller and setup recovery actionable on Home", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.homeRecovery.hidden).toBe(true);

    shell.setHomeRecovery({ kind: "active-elsewhere" });
    expect(shell.homeRecovery.hidden).toBe(false);
    expect(shell.homeRecoveryMessage.textContent).toBe(
      "Game active in another session",
    );
    expect(shell.retryConnectionButton.hidden).toBe(true);
    expect(shell.exitSetupButton.hidden).toBe(true);

    shell.setHomeRecovery({ kind: "interrupted", remainingSeconds: 42 });
    expect(shell.homeRecoveryMessage.textContent).toBe(
      "Game interrupted · waiting for reconnection (42s)",
    );
    expect(shell.exitSetupButton.hidden).toBe(true);
    expect(shell.endInterruptedMatchButton.hidden).toBe(true);

    shell.setHomeRecovery({ kind: "interrupted", remainingSeconds: 0 });
    expect(shell.homeRecoveryMessage.textContent).toBe(
      "Game interrupted · no controller reconnected",
    );
    expect(shell.endInterruptedMatchButton.hidden).toBe(false);
    expect(shell.endInterruptedMatchButton.textContent).toBe("End interrupted match");
    expect(shell.endInterruptedMatchButton.classList).toContain("destructive");
    expect(shell.exitSetupButton.hidden).toBe(true);

    shell.setHomeRecovery({ kind: "confirming", exit: "withdraw" });
    expect(shell.homeRecoveryMessage.textContent).toBe(
      "Still confirming the active game session…",
    );
    expect(shell.retryConnectionButton.hidden).toBe(false);
    expect(shell.retryConnectionButton.textContent).toBe("Retry connection");
    expect(shell.exitSetupButton.hidden).toBe(false);
    expect(shell.exitSetupButton.textContent).toBe("Withdraw");

    shell.setHomeRecovery({ kind: "confirming", exit: "cancel" });
    expect(shell.exitSetupButton.textContent).toBe("Cancel pairing");

    shell.setHomeRecovery(null);
    expect(shell.homeRecovery.hidden).toBe(true);
  });

  it("uses a global actionable interruption for pairings and mutual rematches", () => {
    const trigger = document.createElement("button");
    const mount = document.createElement("div");
    document.body.append(trigger, mount);
    const shell = createAppShell(document, mount);
    trigger.focus();

    expect(shell.pairingInterruption.hidden).toBe(true);
    expect(shell.pairingInterruption.getAttribute("role")).toBe("dialog");
    expect(shell.pairingInterruption.getAttribute("aria-modal")).toBe("true");

    shell.setPairingInterruption({ kind: "pairing", opponentName: "Alice" });

    expect(shell.pairingInterruption.hidden).toBe(false);
    expect(shell.pairingInterruption.dataset.kind).toBe("pairing");
    expect(shell.pairingInterruptionHeading.textContent).toBe("Opponent found");
    expect(shell.pairingInterruptionMessage.textContent).toBe(
      "Alice joined your challenge.",
    );
    expect(shell.goToMatchButton.textContent).toBe("Go to match");
    expect(shell.cancelPairingButton.textContent).toBe("Cancel pairing");
    expect(document.activeElement).toBe(shell.goToMatchButton);

    shell.cancelPairingButton.focus();
    shell.cancelPairingButton.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(shell.goToMatchButton);

    shell.setPairingInterruption({ kind: "rematch", opponentName: "Bob" });

    expect(shell.pairingInterruptionHeading.textContent).toBe("Rematch ready");
    expect(shell.pairingInterruptionMessage.textContent).toBe(
      "Bob accepted the rematch.",
    );
    expect(shell.cancelPairingButton.textContent).toBe("Cancel rematch");

    shell.setPairingInterruption(null);

    expect(shell.pairingInterruption.hidden).toBe(true);
    expect(shell.pairingInterruption.dataset.kind).toBeUndefined();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
    mount.remove();
  });

  it("provides independent competitive and Practice result actions", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.rematchButton).toBe(shell.requestRematchButton);
    expect(shell.resultsLeaveButton).toBe(shell.resultsHomeButton);
    expect(shell.requestRematchButton.textContent).toBe("Request rematch");
    expect(shell.newChallengeButton.textContent).toBe("New challenge");
    expect(shell.resultsHomeButton.textContent).toBe("Home");
    expect(shell.resultsCompetitiveActions.hidden).toBe(false);
    expect(shell.resultsPracticeActions.hidden).toBe(true);
    expect(shell.resultsCompetitiveActions.getAttribute("role")).toBe("group");
    expect(shell.resultsCompetitiveActions.getAttribute("aria-label"))
      .toBe("Competitive result actions");

    shell.setCompetitiveResult({
      round: 3,
      scores: [
        { playerName: "Marta", score: 48_200 },
        { playerName: "Luis", score: 41_750 },
      ],
      seriesScore: "Marta leads 2–1",
      headToHeadScore: "Marta leads 3–2",
      notice: "Standings unchanged.",
    });
    shell.setRematchAction("accept");

    expect(shell.resultsSummary.hidden).toBe(false);
    expect(shell.resultsRound.textContent).toBe("Round 3");
    expect(shell.resultsScoreboard.textContent).toContain("Marta: 48200");
    expect(shell.resultsScoreboard.textContent).toContain("Luis: 41750");
    expect(shell.resultsSeries.textContent).toBe("Series: Marta leads 2–1");
    expect(shell.resultsHeadToHead.textContent).toBe(
      "Head-to-head: Marta leads 3–2",
    );
    expect(shell.resultsNotice.textContent).toBe("Standings unchanged.");
    expect(shell.requestRematchButton.textContent).toBe("Accept rematch");
    expect(shell.requestRematchButton.disabled).toBe(false);

    shell.setRematchAction("pending");
    expect(shell.requestRematchButton.textContent).toBe("Rematch requested");
    expect(shell.requestRematchButton.disabled).toBe(true);

    shell.setResultsMode("practice");

    expect(shell.results.dataset.resultsMode).toBe("practice");
    expect(shell.resultsCompetitiveActions.hidden).toBe(true);
    expect(shell.resultsPracticeActions.hidden).toBe(false);
    expect(shell.resultsSummary.hidden).toBe(true);
    expect(shell.practiceAgainButton.textContent).toBe("Practice again");
    expect(shell.practiceCreateChallengeButton.textContent).toBe("Create challenge");
    expect(shell.practiceHomeButton.textContent).toBe("Home");

    shell.setResultsMode("competitive");

    expect(shell.resultsCompetitiveActions.hidden).toBe(false);
    expect(shell.resultsPracticeActions.hidden).toBe(true);
    expect(shell.resultsSummary.hidden).toBe(false);

    shell.setCompetitiveResult(null);
    shell.setRematchAction("hidden");
    expect(shell.resultsSummary.hidden).toBe(true);
    expect(shell.requestRematchButton.hidden).toBe(true);
  });

  it("builds a labeled board-attached HUD with a seven-segment inner power rail", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const hud = shell.left.pane.querySelector<HTMLElement>(".player-hud");

    expect(hud?.dataset.side).toBe("left");
    expect(
      [...(hud?.querySelectorAll(".hud-stat-label") ?? [])].map(
        (label) => label.textContent,
      ),
    ).toEqual(["Score", "Level", "Lines"]);
    expect(hud?.querySelectorAll(".power-meter-segment")).toHaveLength(7);
    expect(hud?.querySelector(".upcoming-power-icon")).not.toBeNull();
    expect(shell.left.score.hasAttribute("aria-label")).toBe(false);
    expect(shell.left.upcomingPower.getAttribute("role")).toBe("img");
    expect(shell.left.incoming.getAttribute("role")).toBe("img");
    expect(shell.left.statuses.getAttribute("role")).toBe("group");
    expect(shell.left.barrierCapacity.getAttribute("role")).toBe("meter");
    expect(shell.left.barrierCapacitySegments).toHaveLength(4);
    expect(
      shell.left.barrierCapacitySegments.filter((segment) =>
        segment.classList.contains("is-filled")
      ),
    ).toHaveLength(0);
    expect(
      hud?.querySelector('[data-special-icon="garbage-core"]'),
    ).not.toBeNull();
    expect(hud?.querySelector(".hold-preview")?.classList).toContain("is-unboxed");
    expect(hud?.querySelector(".next-preview")?.classList).toContain("is-unboxed");
  });

  it("exposes full stat names while providing CSS-addressable short labels", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const stats = shell.left.root.querySelectorAll<HTMLElement>(".hud-stat");

    expect(stats).toHaveLength(3);
    expect([...stats].map((stat) => ({
      full: stat.querySelector(".hud-stat-label-full")?.textContent,
      short: stat.querySelector(".hud-stat-label-short")?.textContent,
      accessible: stat.querySelector(".hud-stat-accessible-label")?.textContent,
    }))).toEqual([
      { full: "Score", short: "SCR", accessible: "Score" },
      { full: "Level", short: "LVL", accessible: "Level" },
      { full: "Lines", short: "LNS", accessible: "Lines" },
    ]);
    for (const stat of stats) {
      expect(stat.querySelector(".hud-stat-label-full")?.getAttribute("aria-hidden"))
        .toBe("true");
      expect(stat.querySelector(".hud-stat-label-short")?.getAttribute("aria-hidden"))
        .toBe("true");
      expect(stat.querySelector(".hud-stat-value")?.hasAttribute("aria-label"))
        .toBe(false);
    }
  });

  it("anchors permanent HUD bands and responsive labels to the board frame", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const roomy = calculateRendererLayout(1280, 720, "practice");

    positionHudToViewport(shell.left, roomy.left);

    expect(shell.left.root.style.left).toBe(`${roomy.left.boardX}px`);
    expect(shell.left.root.style.top).toBe(`${roomy.left.boardY}px`);
    expect(shell.left.root.style.width).toBe(`${roomy.left.boardWidth}px`);
    expect(shell.left.root.style.getPropertyValue("--hud-top-height")).toBe("72px");
    expect(shell.left.pane.dataset.hudCompact).toBe("false");
    expect(shell.left.pane.dataset.hudLabels).toBe("full");
    expect(shell.left.pane.dataset.hudTop).toBeUndefined();
    expect(shell.left.pane.dataset.statusPlacement).toBeUndefined();

    const constrained = calculateRendererLayout(640, 360, "practice");
    positionHudToViewport(shell.left, constrained.left);

    expect(shell.left.root.style.getPropertyValue("--hud-top-height")).toBe("64px");
    expect(shell.left.pane.dataset.hudCompact).toBe("true");
    expect(shell.left.pane.dataset.hudLabels).toBe("short");
  });

  it("places gameplay tips around the complete frame before using a board inset", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const above = calculateRendererLayout(400, 800, "versus");

    positionGameplayTip(shell, above);
    expect(shell.match.dataset.tipPlacement).toBe("above");
    expect(shell.match.style.getPropertyValue("--tip-frame-top"))
      .toBe(`${above.frame.y}px`);

    const outer = calculateRendererLayout(800, 400, "practice");
    positionGameplayTip(shell, outer);
    expect(shell.match.dataset.tipPlacement).toBe("outer");

    const inset = calculateRendererLayout(360, 640, "practice");
    positionGameplayTip(shell, inset);
    expect(shell.match.dataset.tipPlacement).toBe("inside");
  });

  it("keeps the match menu in the PvP corridor or clear Practice whitespace", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const versus = calculateRendererLayout(1280, 720, "versus");

    positionMatchMenuButton(shell, versus);

    expect(shell.matchActions.style.left).toBe("640px");
    expect(shell.matchActions.style.top).toBe("18px");
    expect(shell.match.dataset.menuPlacement).toBe("corridor");

    const practice = calculateRendererLayout(640, 360, "practice");
    positionMatchMenuButton(shell, practice);

    expect(shell.matchActions.style.left).toBe("217.5px");
    expect(shell.matchActions.style.top).toBe("14px");
    expect(shell.match.dataset.menuPlacement).toBe("outer");

    const constrained = calculateRendererLayout(320, 520, "practice");
    positionHudToViewport(shell.left, constrained.left);
    positionMatchMenuButton(shell, constrained);

    expect(shell.match.dataset.menuPlacement).toBe("header");
    expect(Number(shell.left.root.style.getPropertyValue("--hud-preview-scale")))
      .toBeLessThan(1);
  });

  it("renders discrete charge and pulses when the upcoming power advances", () => {
    const shell = createAppShell(document, document.createElement("div"));

    setHudPower(shell.left, "nuke", "Nuke", 3, 0);

    expect(
      shell.left.upcomingPower.querySelector('[data-power-icon="nuke"]'),
    ).not.toBeNull();
    expect(
      shell.left.upcomingPower.querySelector('[data-power-icon="nuke"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      shell.left.meterSegments
        .filter((segment) => segment.classList.contains("is-filled"))
        .map((segment) => segment.dataset.charge),
    ).toEqual(["1", "2", "3"]);
    expect(shell.left.meter.getAttribute("aria-valuenow")).toBe("3");
    expect(shell.left.upcomingPower.dataset.chargeState).toBe("charging");

    setHudPower(shell.left, "nuke", "Nuke", 6, 0);
    expect(shell.left.upcomingPower.dataset.chargeState).toBe("near");

    setHudPower(shell.left, "nuke", "Nuke", 7, 0);
    expect(shell.left.upcomingPower.dataset.chargeState).toBe("ready");

    setHudPower(shell.left, "collapse", "Collapse", 1, 1);

    expect(
      shell.left.upcomingPower.querySelector('[data-power-icon="collapse"]'),
    ).not.toBeNull();
    expect(shell.left.meter.classList).toContain("is-activating");
  });

  it("uses the Garbage Core glyph for empty, warned, and ready garbage states", () => {
    const shell = createAppShell(document, document.createElement("div"));

    setHudGarbage(shell.left, 0, false);
    expect(shell.left.incoming.dataset.state).toBe("empty");
    expect(shell.left.incoming.getAttribute("aria-label")).toBe(
      "Incoming garbage: 0",
    );

    setHudGarbage(shell.left, 3, false);
    expect(shell.left.incoming.dataset.state).toBe("warning");
    expect(shell.left.incomingCount.textContent).toBe("3");
    expect(shell.left.incoming.getAttribute("aria-label")).toContain("queued");

    setHudGarbage(shell.left, 3, true);
    expect(shell.left.incoming.dataset.state).toBe("ready");
    expect(shell.left.incoming.getAttribute("aria-label")).toContain("ready to rise");

    const countText = vi.spyOn(shell.left.incomingCount, "textContent", "set");
    const accessibleLabel = vi.spyOn(shell.left.incoming, "setAttribute");
    setHudGarbage(shell.left, 3, true);
    expect(countText).not.toHaveBeenCalled();
    expect(accessibleLabel).not.toHaveBeenCalled();
  });

  it("shows the four earliest active effects and queues later visuals as metadata", () => {
    const shell = createAppShell(document, document.createElement("div"));
    expect(shell.left.statuses.hasAttribute("aria-live")).toBe(false);

    renderTimedEffects(shell.left, [
      {
        id: "scramble",
        label: "Scramble",
        remainingTicks: 300,
        totalTicks: 600,
        accent: "#ff8ade",
      },
      {
        id: "barrier",
        label: "Barrier",
        remainingTicks: 840,
        totalTicks: 1_200,
        accent: "#57e6ff",
      },
      {
        id: "ghost-jam",
        label: "Ghost Jam",
        remainingTicks: 600,
        totalTicks: 900,
        accent: "#ad8cff",
      },
      {
        id: "blackout",
        label: "Blackout",
        remainingTicks: 480,
        totalTicks: 900,
        accent: "#9b7bff",
      },
      {
        id: "monomino-rush",
        label: "Monomino Rush",
        remainingTicks: 180,
        totalTicks: 480,
        accent: "#77e65c",
      },
    ]);

    const rows = shell.left.statuses.querySelectorAll<HTMLElement>(
      ".timed-effect",
    );
    expect(rows).toHaveLength(4);
    expect([...rows].map((row) => row.dataset.effect)).toEqual([
      "scramble",
      "barrier",
      "ghost-jam",
      "blackout",
    ]);
    expect(shell.left.statuses.dataset.effectLayout).toBe("4");
    expect(shell.left.statuses.dataset.queuedEffects).toBe("1");
    expect(rows[0]?.textContent).toContain("Scramble");
    expect(rows[0]?.textContent).toContain("5s");
    expect(rows[0]?.style.getPropertyValue("--effect-accent")).toBe("#ff8ade");
    expect(rows[1]?.textContent).toContain("Barrier");
    expect(rows[1]?.textContent).not.toContain("Barrier 3");
    expect(rows[1]?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"))
      .toBe("840");
    expect(shell.left.statuses.querySelector(".timed-effect-overflow")).toBeNull();
    expect(shell.left.statuses.children).toHaveLength(4);

    const firstRow = rows[0];
    renderTimedEffects(shell.left, [
      {
        id: "scramble",
        label: "Scramble",
        remainingTicks: 240,
        totalTicks: 600,
        accent: "#ff8ade",
      },
    ]);
    expect(shell.left.statuses.querySelector(".timed-effect")).toBe(firstRow);
    expect(firstRow?.textContent).toContain("4s");
  });

  it("keeps full timer names and whole seconds inside each progressbar", () => {
    const shell = createAppShell(document, document.createElement("div"));

    renderTimedEffects(shell.left, [
      {
        id: "ghost-jam",
        label: "Ghost Jam With A Deliberately Long Name",
        remainingTicks: 90,
        totalTicks: 900,
        accent: "#ad8cff",
      },
    ]);

    const progress = shell.left.statuses.querySelector<HTMLElement>(
      '[role="progressbar"]',
    );
    expect(progress).not.toBeNull();
    expect(progress?.querySelector(".timed-effect-name")?.textContent).toBe(
      "Ghost Jam With A Deliberately Long Name",
    );
    expect(progress?.querySelector(".timed-effect-time")?.textContent).toBe("2s");
    expect(progress?.getAttribute("aria-label")).toBe(
      "Ghost Jam With A Deliberately Long Name, 2 seconds remaining",
    );
    expect(progress?.getAttribute("aria-valuetext")).toBe("2 seconds remaining");
    expect(shell.left.statuses.hasAttribute("aria-live")).toBe(false);
  });

  it("presents readiness as a centered state with both players visible", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.readyButton.closest(".ready-panel")).not.toBeNull();
    expect(shell.readyButton.textContent).toBe("Ready up");
    expect(shell.readyButton.getAttribute("aria-pressed")).toBe("false");
    expect(shell.localReadyStatus.textContent).toContain("Not ready");
    expect(shell.opponentReadyStatus.textContent).toContain("Not ready");
    expect(shell.cancelReadyButton.hidden).toBe(true);
    expect(shell.leavePairingButton.textContent).toBe("Leave pairing");

    shell.setReadiness(true, false);

    expect(shell.readyButton.textContent).toBe("✓ You’re ready");
    expect(shell.readyButton.getAttribute("aria-pressed")).toBe("true");
    expect(shell.localReadyStatus.textContent).toContain("Ready");
    expect(shell.opponentReadyStatus.textContent).toContain("Not ready");
    expect(shell.cancelReadyButton.hidden).toBe(false);

    shell.setReadiness(true, false, {
      localName: "Alice",
      opponentName: "Bob",
    });
    shell.setPairingExitMode("withdraw");

    expect(shell.localReadyStatus.textContent).toBe("Alice (You) · Ready");
    expect(shell.opponentReadyStatus.textContent).toBe("Bob · Not ready");
    expect(shell.leavePairingButton.textContent).toBe("Withdraw");
    expect(shell.leavePairingButton.dataset.exitMode).toBe("withdraw");

    shell.setPairingExitMode("leave");
    expect(shell.leavePairingButton.textContent).toBe("Leave pairing");

    shell.setOverlayMessage("Match starts in 3");
    expect(shell.readinessPanel.hidden).toBe(true);
    expect(shell.overlayText.hidden).toBe(false);
    expect(shell.overlayText.textContent).toBe("Match starts in 3");
  });

  it("uses one compact match-menu trigger for Practice and live play", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.match.querySelectorAll(".match-actions > button")).toHaveLength(1);
    expect(shell.matchMenuButton.getAttribute("aria-label")).toBe("Match menu");
    expect(shell.matchMenuButton.getAttribute("aria-haspopup")).toBe("dialog");
    expect(shell.matchMenu.getAttribute("aria-describedby")).toBe(
      shell.matchMenuMessage.id,
    );

    setMatchMenu(shell, "practice", true);

    expect(shell.matchMenu.hidden).toBe(false);
    expect(shell.matchMenuButton.getAttribute("aria-expanded")).toBe("true");
    expect(shell.matchMenuMessage.textContent).toContain("Practice is paused");
    expect(shell.matchMenuCloseButton.textContent).toBe("Resume");
    expect(shell.leaveMatchButton.textContent).toBe("Leave match");

    setMatchMenu(shell, "competitive", true);

    expect(shell.matchMenuMessage.textContent).toContain("keeps running");
    expect(shell.matchMenuCloseButton.textContent).toBe("Return to match");

    setMatchMenu(shell, "competitive", false);

    expect(shell.matchMenu.hidden).toBe(true);
    expect(shell.matchMenuButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a simple nonmodal upcoming-power tip with the familiar icon", () => {
    const shell = createAppShell(document, document.createElement("div"));

    showGameplayPowerTip(
      shell,
      "acid-rain",
      "Acid Rain",
      "Use three drops that dissolve their selected columns.",
    );

    expect(shell.gameplayTip.hidden).toBe(false);
    expect(shell.gameplayTip.dataset.power).toBe("acid-rain");
    expect(
      shell.gameplayTip.querySelector('[data-power-icon="acid-rain"]'),
    ).not.toBeNull();
    expect(shell.gameplayTip.textContent).toContain("Upcoming power · Acid Rain");
    expect(shell.gameplayTip.textContent).toContain("Use three drops");
    expect(shell.gameplayTipAnnouncement.getAttribute("role")).toBe("status");
    expect(shell.gameplayTipAnnouncement.textContent).toContain(
      "Upcoming power · Acid Rain. Use three drops",
    );

    hideGameplayPowerTip(shell);

    expect(shell.gameplayTip.hidden).toBe(true);
  });

  it("renders Hold and a large-first five-piece queue as real miniatures", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const marked = {
      source: "base",
      shape: "T",
      specialCellIndex: 0,
      specialKind: "glitch-core",
    } as const;
    const glitch = {
      source: "glitch",
      shape: "Z",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "J", "L", "O", "S", "T", "Z"],
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    } as const;

    shell.left.setPiecePreviews(
      marked,
      [
        glitch,
        { source: "cross", shape: "cross" },
        { source: "oversize", shape: "T" },
        { source: "base", shape: "O" },
        { source: "base", shape: "S" },
      ],
      {
        colorPalette: "standard",
        reducedMotion: false,
        reducedFlashes: false,
        elapsedMs: 150,
      },
    );

    expect(shell.left.hold.querySelectorAll(".piece-preview-cell")).toHaveLength(4);
    const heldCell = shell.left.hold.querySelector<HTMLElement>(
      ".piece-preview-cell",
    );
    expect(heldCell?.dataset.shape).toBe("T");
    expect(heldCell?.dataset.pattern).toBe("crosses");
    expect(heldCell?.style.getPropertyValue("--piece-color")).toBe("#b65cff");
    expect(
      shell.left.hold.querySelector('[data-special-icon="glitch-core"] path')
        ?.getAttribute("d"),
    ).toBe(SPECIAL_ICON_PATHS["glitch-core"]);

    const slots = shell.left.preview.querySelectorAll<HTMLElement>(
      ".piece-preview-slot",
    );
    expect(slots).toHaveLength(5);
    expect(slots[0]?.classList.contains("is-primary")).toBe(true);
    expect(slots[0]?.dataset.displayShape).toBe("J");
    expect(slots[0]?.dataset.glitch).toBe("cycling");
    expect(slots[1]?.querySelectorAll(".piece-preview-cell")).toHaveLength(8);
    expect(slots[2]?.dataset.source).toBe("oversize");
    expect(slots[2]?.querySelectorAll(".piece-preview-cell")).toHaveLength(7);
    expect(shell.left.preview.querySelector(".piece-preview-badge")).toBeNull();
  });

  it("keeps a Glitch preview concealed without cycling for accessibility modes", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const glitch = {
      source: "glitch",
      shape: "Z",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "J", "L", "O", "S", "T", "Z"],
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    } as const;

    shell.left.setPiecePreviews(null, [glitch], {
      colorPalette: "standard",
      reducedMotion: true,
      reducedFlashes: false,
      elapsedMs: 150,
    });

    const primary = shell.left.preview.querySelector<HTMLElement>(
      ".piece-preview-slot.is-primary",
    );
    expect(primary?.dataset.glitch).toBe("static");
    expect(primary?.dataset.displayShape).toBe("concealed");
    expect(primary?.getAttribute("aria-label")).toBe(
      "Glitch Piece, shape concealed",
    );
  });

  it("shows independent music and effects controls", () => {
    const mount = document.createElement("div");
    const shell = createAppShell(document, mount);
    shell.setPreferences({
      ...DEFAULT_PREFERENCES,
      effectsEnabled: false,
      effectsVolume: 0.2,
      musicEnabled: true,
      musicVolume: 0.65,
    });

    expect(shell.settingsInputs.effectsEnabled.checked).toBe(false);
    expect(shell.settingsInputs.effectsVolume.value).toBe("0.2");
    expect(shell.settingsInputs.musicEnabled.checked).toBe(true);
    expect(shell.settingsInputs.musicVolume.value).toBe("0.65");
    expect(shell.settings.textContent).toContain("Music volume");
    expect(shell.settings.textContent).toContain("Effects volume");
  });

  it("exposes bounded connection-diagnostic actions with polite feedback", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.diagnosticsCopyButton.textContent).toBe("Copy diagnostics");
    expect(shell.diagnosticsClearButton.textContent).toBe("Clear diagnostics");
    expect(shell.diagnosticsStatus.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps retained meter overflow inside the progressbar accessibility range", () => {
    const shell = createAppShell(document, document.createElement("div"));

    setPowerMeterAccessibility(shell.left.meter, 8);

    expect(shell.left.meter.getAttribute("aria-valuenow")).toBe("7");
    expect(shell.left.meter.getAttribute("aria-valuemax")).toBe("7");
    expect(shell.left.meter.getAttribute("aria-valuetext")).toBe(
      "Power ready; 1 charge retained",
    );
  });

  it("does not toggle an unchanged overlay or blackout visibility state", () => {
    const shell = createAppShell(document, document.createElement("div"));
    setElementHidden(shell.overlay, true);
    const hiddenSetter = vi.spyOn(shell.overlay, "hidden", "set");

    setElementHidden(shell.overlay, true);
    expect(hiddenSetter).not.toHaveBeenCalled();

    setElementHidden(shell.overlay, false);
    expect(hiddenSetter).toHaveBeenCalledOnce();
    expect(shell.overlay.hidden).toBe(false);
  });

  it("does not rewrite an unchanged overlay message", () => {
    const shell = createAppShell(document, document.createElement("div"));
    shell.setOverlayMessage("Match starts in 3");
    const readinessHidden = vi.spyOn(shell.readinessPanel, "hidden", "set");
    const messageHidden = vi.spyOn(shell.overlayText, "hidden", "set");
    const messageText = vi.spyOn(shell.overlayText, "textContent", "set");

    shell.setOverlayMessage("Match starts in 3");

    expect(readinessHidden).not.toHaveBeenCalled();
    expect(messageHidden).not.toHaveBeenCalled();
    expect(messageText).not.toHaveBeenCalled();
  });

  it("marks recovery messages as compact nonmodal status UI", () => {
    const shell = createAppShell(document, document.createElement("div"));

    shell.setOverlayMessage("Reconnecting…", "status");

    expect(shell.overlay.dataset.presentation).toBe("status");
    expect(shell.overlayText.textContent).toBe("Reconnecting…");
    expect(shell.overlayText.getAttribute("role")).toBe("status");
    expect(shell.overlayText.getAttribute("aria-live")).toBe("polite");
  });

  it("shows all marked powers as the same in-context cells used during play", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "how");

    for (const special of [
      "column-bomb",
      "garbage-core",
      "glitch-core",
      "blackout",
      "barrier",
    ] as const) {
      const sample = shell.helpBody.querySelector<HTMLElement>(
        `.marked-cell-sample[data-special="${special}"]`,
      );
      expect(sample).not.toBeNull();
      expect(sample?.querySelector("path")?.getAttribute("d")).toBe(
        SPECIAL_ICON_PATHS[special],
      );
    }
    expect(shell.helpBody.textContent).toContain("Clears its entire column");
    expect(shell.helpBody.textContent).toContain("Sends extra garbage");
    expect(shell.helpBody.textContent).toContain(
      "Its preview rapidly cycles through every tetromino, hiding its real shape until it spawns.",
    );
    expect(shell.helpBody.textContent).toContain(
      "Once revealed, it plays like a normal piece but cannot be held.",
    );
  });

  it("merges every illustrated power group into How to Play", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "how");

    const meter = shell.helpBody.querySelector<HTMLElement>(
      '[data-help-group="meter"]',
    );
    const marked = shell.helpBody.querySelector<HTMLElement>(
      '[data-help-group="marked"]',
    );
    const pieces = shell.helpBody.querySelector<HTMLElement>(
      '[data-help-group="pieces"]',
    );

    expect(meter?.querySelector("h3")?.textContent).toBe("Meter powers");
    expect(meter?.querySelectorAll("[data-power-icon]")).toHaveLength(7);
    expect(meter?.textContent).toContain("Oversize");
    expect(meter?.textContent).toContain("Ghost Jam");
    expect(meter?.textContent).not.toContain("Blackout");
    expect(meter?.textContent).not.toContain("Barrier");
    expect(marked?.querySelector("h3")?.textContent).toBe("Marked-piece powers");
    expect(marked?.textContent).toContain("Blackout");
    expect(marked?.textContent).toContain("Barrier");
    expect(marked?.querySelectorAll(".marked-cell-sample")).toHaveLength(5);
    expect(pieces?.querySelector("h3")?.textContent).toBe("Special pieces");
    expect(pieces?.textContent).toContain("Hollow Cross");
    expect(pieces?.textContent).toContain("Glitch Piece");
    expect(pieces?.textContent).toContain("Oversize shapes");
    expect(pieces?.querySelectorAll(".special-piece-sample")).toHaveLength(3);
    expect(shell.lobby.textContent).not.toContain("Power Glossary");
    expect(shell.controlsHelpButton.textContent).toBe("Controls");
  });

  it("cycles the How to Play Glitch Piece only while that screen is visible", () => {
    vi.useFakeTimers();
    try {
      const shell = createAppShell(document, document.createElement("div"));
      showHelp(shell, "how");
      const glitchSample = shell.helpBody.querySelector<HTMLElement>(
        '.special-piece-sample[data-source="glitch"]',
      );

      expect(glitchSample?.dataset.displayShape).toBe("I");
      vi.advanceTimersByTime(150);
      expect(glitchSample?.dataset.displayShape).toBe("J");

      shell.show("lobby");
      vi.advanceTimersByTime(450);
      expect(glitchSample?.dataset.displayShape).toBe("J");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders Special Pieces in dedicated unboxed Help illustrations", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "how");

    const illustrations = shell.helpBody.querySelectorAll<HTMLElement>(
      '[data-help-group="pieces"] .special-piece-illustration',
    );
    expect(illustrations).toHaveLength(3);
    for (const illustration of illustrations) {
      expect(illustration.querySelector(".piece-preview-grid")).not.toBeNull();
      expect(illustration.classList).not.toContain("piece-preview-slot");
      expect(illustration.classList).not.toContain("is-primary");
    }
  });

  it.each(["reducedMotion", "reducedFlashes", "reducedEffects"] as const)(
    "keeps the How to Play Glitch Piece static with %s enabled",
    (preference) => {
      vi.useFakeTimers();
      try {
        const shell = createAppShell(document, document.createElement("div"));
        shell.container.dataset[preference] = "true";
        showHelp(shell, "how");
        const glitchSample = shell.helpBody.querySelector<HTMLElement>(
          '.special-piece-sample[data-source="glitch"]',
        );

        expect(glitchSample?.dataset.glitch).toBe("static");
        expect(glitchSample?.dataset.displayShape).toBe("concealed");
        expect(
          [...(glitchSample?.querySelectorAll<HTMLElement>(".piece-preview-cell") ?? [])]
            .map((cell) => cell.dataset.shape),
        ).toEqual(["I", "J", "T", "S", "Z"]);
        vi.advanceTimersByTime(450);
        expect(glitchSample?.dataset.displayShape).toBe("concealed");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("separates touch help from a complete action-to-key table", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "controls");

    const touch = shell.helpBody.querySelector<HTMLElement>(
      '[data-control-scheme="touch"]',
    );
    const keyboard = shell.helpBody.querySelector<HTMLElement>(
      '[data-control-scheme="keyboard"]',
    );
    expect(touch?.querySelectorAll(".gesture-control-row")).toHaveLength(6);
    expect(touch?.textContent).toContain("entire gameplay area");
    expect(touch?.querySelectorAll("[data-control-action]")).toHaveLength(7);
    expect(keyboard?.querySelector("table")).not.toBeNull();

    const rows = new Map(
      [...(keyboard?.querySelectorAll("tbody tr") ?? [])].map((row) => [
        row.querySelector("th")?.textContent,
        [...row.querySelectorAll("kbd")].map((key) => key.textContent),
      ]),
    );
    expect(rows.get("Move left/right")).toEqual(["←", "→", "A", "D"]);
    expect(rows.get("Soft drop")).toEqual(["↓", "S"]);
    expect(rows.get("Hard drop")).toEqual(["Space"]);
    expect(rows.get("Rotate clockwise")).toEqual(["↑", "X", "E"]);
    expect(rows.get("Rotate counterclockwise")).toEqual(["Z", "Q"]);
    expect(rows.get("Hold")).toEqual(["C", "Shift"]);
    expect(rows.get("Pause Practice")).toEqual(["P", "Esc"]);
  });

  it("swaps directional and rotation glyphs while Scramble is active", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const glyph = (action: string): string | null =>
      shell.touchButtons.querySelector(`[data-action="${action}"]`)?.textContent ?? null;

    shell.setScrambled(true);
    expect(shell.arena.dataset.scrambled).toBe("true");
    expect(glyph("move-left")).toBe("→");
    expect(glyph("move-right")).toBe("←");
    expect(glyph("rotate-ccw")).toBe("↻");
    expect(glyph("rotate-cw")).toBe("↺");

    shell.setScrambled(false);
    expect(glyph("move-left")).toBe("←");
    expect(glyph("rotate-cw")).toBe("↻");
  });
});
