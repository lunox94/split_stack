import type {
  CompetitionActor,
  CompetitionResultView,
  PlayerCompetitionActivity,
  StartingPairingView,
} from "./competition-ledger-v2";
import type {
  CompetitionPendingRematchView,
  CompetitionPracticeEntryView,
  CompetitionView,
} from "./competition-event-lifecycle";
import { formatString, STRINGS } from "./strings";
import type { AppShell } from "../ui/shell";

export interface CompetitionPresenterCallbacks {
  readonly onJoinChallenge?: (challengeId: string) => void;
  readonly onWatchMatch?: (matchId: string) => void;
  readonly onLeavePairing?: (pairingId: string) => void;
  readonly onAcceptRematch?: (afterMatchId: string) => void;
}

export interface CompetitionPresenterOptions extends CompetitionPresenterCallbacks {
  readonly shell: AppShell;
  readonly view: CompetitionView;
  readonly self: CompetitionActor;
  readonly realtimeAvailable: boolean;
  /** Replacement runtimes may watch their committed match but never control it. */
  readonly allowOwnedMatchWatch?: boolean;
  /** Presence is advisory. Errors are displayed as offline and never block joining. */
  readonly isOnline: (actorId: string, challengeId: string) => boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(document: Document, text: string): HTMLButtonElement {
  const node = element(document, "button", undefined, text);
  node.type = "button";
  return node;
}

function playerName(player: CompetitionActor, selfId: string): string {
  return player.id === selfId
    ? formatString("match.youName", { player: player.displayName })
    : player.displayName;
}

function formatScore(score: number | undefined): string {
  if (!Number.isSafeInteger(score)) return "0";
  return String(Math.max(0, score ?? 0));
}

function replaceWithEmpty(container: HTMLElement, text: string): void {
  const document = container.ownerDocument;
  const empty = container.tagName === "UL"
    ? element(document, "li", "lobby-empty muted", text)
    : element(document, "p", "lobby-empty muted", text);
  empty.dataset.emptyState = "true";
  container.replaceChildren(empty);
}

function setSectionVisible(body: HTMLElement, visible: boolean): void {
  const section = body.closest<HTMLElement>("section");
  if (section !== null) section.hidden = !visible;
}

function hasRenderedContent(body: HTMLElement): boolean {
  return body.querySelector('[data-empty-state="true"]') === null;
}

function safePresence(
  isOnline: CompetitionPresenterOptions["isOnline"],
  actorId: string,
  challengeId: string,
): boolean {
  try {
    return isOnline(actorId, challengeId);
  } catch {
    return false;
  }
}

function renderOpenChallenges(options: CompetitionPresenterOptions): void {
  const { shell, view, self, realtimeAvailable, isOnline, onJoinChallenge } = options;
  const document = shell.container.ownerDocument;
  if (view.openChallenges.length === 0) {
    replaceWithEmpty(shell.openChallenges, STRINGS["lobby.noOpenChallenges"]);
    return;
  }

  // CompetitionView exposes these in canonical oldest-first event order.
  const rows = view.openChallenges.map((challenge, index) => {
    const row = element(document, "li", "history-item lobby-challenge-row");
    row.dataset.challengeId = challenge.challengeId;
    const copy = element(document, "div", "lobby-row-copy");
    const creator = element(
      document,
      "p",
      "lobby-row-title",
      playerName(challenge.creator, self.id),
    );
    const online = safePresence(isOnline, challenge.creator.id, challenge.challengeId);
    const status = element(
      document,
      "p",
      `lobby-presence muted ${online ? "is-online" : "is-offline"}`,
      online ? STRINGS["lobby.online"] : STRINGS["lobby.offlineJoinHint"],
    );
    status.id = `challenge-presence-${index}`;
    copy.append(creator, status);

    if (challenge.creator.id === self.id) {
      row.append(copy, element(document, "span", "muted", "Your challenge"));
      return row;
    }

    const join = button(document, STRINGS["lobby.join"]);
    join.classList.add("primary", "lobby-row-action");
    join.disabled = !realtimeAvailable || view.activity.kind !== "idle";
    join.setAttribute(
      "aria-label",
      `${STRINGS["lobby.join"]} ${challenge.creator.displayName}`,
    );
    join.setAttribute("aria-describedby", status.id);
    join.addEventListener("click", () => onJoinChallenge?.(challenge.challengeId));
    row.append(copy, join);
    return row;
  });
  shell.openChallenges.replaceChildren(...rows);
}

function readinessText(
  pairing: StartingPairingView,
  player: CompetitionActor,
  selfId: string,
): string {
  const ready = pairing.readyByPlayer[player.id] === true;
  return `${playerName(player, selfId)} — ${
    ready ? STRINGS["match.ready"] : STRINGS["match.notReady"]
  }`;
}

function renderStartingPairings(options: CompetitionPresenterOptions): void {
  const { shell, view, self, onLeavePairing } = options;
  const document = shell.container.ownerDocument;
  if (view.startingPairings.length === 0) {
    replaceWithEmpty(shell.startingSoon, STRINGS["lobby.noStartingSoon"]);
    return;
  }

  const rows = view.startingPairings.map((pairing) => {
    const row = element(document, "li", "history-item lobby-starting-row");
    row.dataset.matchId = pairing.matchId;
    const players = element(
      document,
      "p",
      "lobby-row-title",
      `${pairing.seatA.displayName} vs ${pairing.seatB.displayName}`,
    );
    const round = element(
      document,
      "span",
      "muted",
      formatString("lobby.round", { round: pairing.round }),
    );
    const readiness = element(document, "div", "lobby-readiness");
    for (const player of [pairing.seatA, pairing.seatB]) {
      const state = element(
        document,
        "span",
        pairing.readyByPlayer[player.id] === true ? "is-ready" : "is-not-ready",
        readinessText(pairing, player, self.id),
      );
      state.dataset.playerId = player.id;
      state.dataset.ready = String(pairing.readyByPlayer[player.id] === true);
      readiness.append(state);
    }
    const copy = element(document, "div", "lobby-row-copy");
    copy.append(players, readiness);
    const actions = element(document, "div", "lobby-row-actions");
    actions.append(round);
    if (pairing.seatA.id === self.id || pairing.seatB.id === self.id) {
      const actionLabel = pairing.source === "rematch"
        ? STRINGS["pairing.cancelRematch"]
        : pairing.seatB.id === self.id
          ? STRINGS["lobby.withdraw"]
          : STRINGS["pairing.cancelPairing"];
      const leave = button(document, actionLabel);
      leave.dataset.pairingAction = "leave";
      leave.addEventListener("click", () => onLeavePairing?.(pairing.pairingId));
      actions.append(leave);
    }
    row.append(copy, actions);
    return row;
  });
  shell.startingSoon.replaceChildren(...rows);
}

function renderLiveMatches(options: CompetitionPresenterOptions): void {
  const {
    shell,
    view,
    self,
    realtimeAvailable,
    allowOwnedMatchWatch = false,
    onWatchMatch,
  } = options;
  const document = shell.container.ownerDocument;
  if (view.liveMatches.length === 0) {
    replaceWithEmpty(shell.liveGames, STRINGS["lobby.noLiveGames"]);
    return;
  }

  const rows = view.liveMatches.map((match) => {
    const row = element(document, "li", "history-item lobby-live-row");
    row.dataset.matchId = match.matchId;
    const copy = element(document, "div", "lobby-row-copy");
    copy.append(
      element(
        document,
        "p",
        "lobby-row-title",
        `${match.seatA.displayName} vs ${match.seatB.displayName}`,
      ),
      element(
        document,
        "p",
        "muted",
        formatString("lobby.round", { round: match.round }),
      ),
    );
    const watch = button(document, STRINGS["lobby.watch"]);
    const owned = match.seatA.id === self.id || match.seatB.id === self.id;
    watch.disabled = !realtimeAvailable || (owned && !allowOwnedMatchWatch);
    if (owned && !allowOwnedMatchWatch) {
      watch.title = STRINGS["home.unfinishedMatchSummary"];
    }
    watch.setAttribute(
      "aria-label",
      `${STRINGS["lobby.watch"]} ${match.seatA.displayName} vs ${match.seatB.displayName}`,
    );
    watch.addEventListener("click", () => onWatchMatch?.(match.matchId));
    row.append(copy, watch);
    return row;
  });
  shell.liveGames.replaceChildren(...rows);
}

function resultOutcome(entry: CompetitionResultView): string {
  if (entry.conflicted) return "Conflicting reports · neutral result";
  if (entry.result.outcome === "draw") return STRINGS["results.draw"];
  if (entry.result.outcome === "desync") {
    return entry.result.reason === "connection-lost"
      ? STRINGS["results.connectionLostHistory"]
      : STRINGS["results.desync"];
  }
  const winnerIndex = entry.result.outcome === "seat-a" ? 0 : 1;
  const winner = entry.result.players[winnerIndex];
  return winner === undefined ? STRINGS["results.desync"] : `${winner.displayName} won`;
}

function resultScore(entry: CompetitionResultView): string {
  const first = entry.result.players[0];
  const second = entry.result.players[1];
  if (first === undefined || second === undefined) return "Scores unavailable";
  return `${first.displayName} ${formatScore(entry.result.statsByPlayer[first.id]?.score)} – ${
    formatScore(entry.result.statsByPlayer[second.id]?.score)
  } ${second.displayName}`;
}

function renderResults(shell: AppShell, view: CompetitionView): void {
  const document = shell.container.ownerDocument;
  const results = view.recentResults.slice(0, 20);
  if (results.length === 0) {
    replaceWithEmpty(shell.history, STRINGS["lobby.noRecentResults"]);
    return;
  }

  const rows = results.map((entry) => {
    const row = element(document, "li", "history-item lobby-result-row");
    row.dataset.matchId = entry.matchId;
    const copy = element(document, "div", "lobby-row-copy");
    copy.append(
      element(document, "p", "lobby-row-title", resultScore(entry)),
      element(document, "p", "muted", resultOutcome(entry)),
    );
    row.append(
      copy,
      element(
        document,
        "span",
        "muted",
        formatString("lobby.round", { round: entry.round }),
      ),
    );
    return row;
  });
  shell.history.replaceChildren(...rows);
}

type TableHeaderLabel = string | {
  readonly text: string;
  readonly accessibleLabel: string;
};

function tableHeader(
  document: Document,
  labels: readonly TableHeaderLabel[],
): HTMLTableSectionElement {
  const head = element(document, "thead");
  const row = element(document, "tr");
  for (const label of labels) {
    const cell = element(
      document,
      "th",
      undefined,
      typeof label === "string" ? label : label.text,
    );
    cell.scope = "col";
    if (typeof label !== "string") {
      cell.setAttribute("aria-label", label.accessibleLabel);
    }
    row.append(cell);
  }
  head.append(row);
  return head;
}

function renderStandings(shell: AppShell, view: CompetitionView, selfId: string): void {
  const document = shell.container.ownerDocument;
  if (view.standings.length === 0) {
    replaceWithEmpty(shell.standings, STRINGS["lobby.noStandings"]);
    return;
  }

  const table = element(document, "table", "lobby-table standings-table");
  table.append(
    element(document, "caption", "sr-only", STRINGS["lobby.standings"]),
    tableHeader(document, [
      STRINGS["lobby.playerColumn"],
      { text: STRINGS["lobby.winsColumn"], accessibleLabel: "Wins" },
      { text: STRINGS["lobby.lossesColumn"], accessibleLabel: "Losses" },
      { text: STRINGS["lobby.drawsColumn"], accessibleLabel: "Draws" },
      STRINGS["lobby.winRateColumn"],
    ]),
  );
  const body = element(document, "tbody");
  for (const standing of view.standings) {
    const row = element(document, "tr");
    row.dataset.playerId = standing.player.id;
    if (standing.player.id === selfId) {
      row.classList.add("is-local-player");
      row.dataset.localPlayer = "true";
    }
    const name = element(document, "th", undefined, playerName(standing.player, selfId));
    name.scope = "row";
    row.append(
      name,
      element(document, "td", undefined, String(standing.wins)),
      element(document, "td", undefined, String(standing.losses)),
      element(document, "td", undefined, String(standing.draws)),
      element(document, "td", undefined, `${Math.round(standing.winRate * 100)}%`),
    );
    body.append(row);
  }
  table.append(body);
  shell.standings.replaceChildren(table);
}

function practiceRow(
  document: Document,
  entry: CompetitionPracticeEntryView,
  selfId: string,
  pinned: boolean,
): HTMLTableRowElement {
  const row = element(document, "tr", pinned ? "is-pinned" : undefined);
  row.dataset.playerId = entry.player.id;
  if (pinned) row.dataset.pinned = "true";
  if (entry.player.id === selfId) {
    row.classList.add("is-local-player");
    row.dataset.localPlayer = "true";
  }
  const rank = element(document, "th", undefined, `#${entry.rank}`);
  rank.scope = "row";
  row.append(
    rank,
    element(document, "td", undefined, playerName(entry.player, selfId)),
    element(document, "td", undefined, formatScore(entry.score)),
  );
  return row;
}

function renderPractice(shell: AppShell, view: CompetitionView, selfId: string): void {
  const document = shell.container.ownerDocument;
  const leaders = view.practice.leaderboard.slice(0, 10);
  const pinned = view.practice.pinned;
  if (leaders.length === 0 && pinned === null) {
    replaceWithEmpty(shell.practiceLeaderboard, STRINGS["lobby.noPracticeScores"]);
    return;
  }

  const table = element(document, "table", "lobby-table practice-table");
  table.append(
    element(document, "caption", "sr-only", STRINGS["lobby.practiceLeaderboard"]),
    tableHeader(document, ["Rank", STRINGS["lobby.playerColumn"], STRINGS["lobby.scoreColumn"]]),
  );
  const body = element(document, "tbody");
  for (const entry of leaders) body.append(practiceRow(document, entry, selfId, false));
  if (pinned !== null && !leaders.some((entry) => entry.player.id === pinned.player.id)) {
    body.append(practiceRow(document, pinned, selfId, true));
  }
  table.append(body);
  shell.practiceLeaderboard.replaceChildren(table);
}

function activityText(
  activity: PlayerCompetitionActivity,
  view: CompetitionView,
  selfId: string,
): string {
  if (activity.kind === "waiting") return STRINGS["lobby.waitingForOpponent"];
  if (activity.kind === "starting") {
    const pairing = view.startingPairings.find((entry) => entry.pairingId === activity.pairingId);
    return pairing === undefined
      ? `Preparing ${formatString("lobby.round", { round: activity.round })}`
      : `Starting ${formatString("lobby.round", { round: activity.round })} · ${
        playerName(pairing.seatA, selfId)
      } vs ${playerName(pairing.seatB, selfId)}`;
  }
  if (activity.kind === "live") {
    const match = view.liveMatches.find((entry) => entry.matchId === activity.matchId);
    return match === undefined
      ? `Live · ${formatString("lobby.round", { round: activity.round })}`
      : `Live · ${formatString("lobby.round", { round: activity.round })} · ${
        playerName(match.seatA, selfId)
      } vs ${playerName(match.seatB, selfId)}`;
  }
  return "";
}

function rematchText(rematch: CompetitionPendingRematchView, selfId: string): string {
  const opponent = rematch.seatA.id === selfId ? rematch.seatB : rematch.seatA;
  const selfRequested = rematch.requestedByPlayerIds.includes(selfId);
  const opponentRequested = rematch.requestedByPlayerIds.includes(opponent.id);
  const round = formatString("lobby.round", { round: rematch.round });
  if (selfRequested && opponentRequested) return `Rematch ready with ${opponent.displayName} · ${round}`;
  if (selfRequested) return `Rematch requested with ${opponent.displayName} · ${round}`;
  return `${opponent.displayName} requested a rematch · ${round}`;
}

function renderYourActivity(options: CompetitionPresenterOptions): void {
  const {
    shell,
    view,
    self,
    onAcceptRematch,
  } = options;
  const selfId = self.id;
  const document = shell.container.ownerDocument;
  const items: HTMLElement[] = [];
  const activity = activityText(view.activity, view, selfId);
  if (activity !== "") {
    items.push(element(document, "p", "lobby-activity-item", activity));
  }
  for (const rematch of view.pendingRematches) {
    if (rematch.seatA.id !== selfId && rematch.seatB.id !== selfId) continue;
    const item = element(document, "div", "lobby-activity-item");
    item.append(element(document, "span", undefined, rematchText(rematch, selfId)));
    const selfRequested = rematch.requestedByPlayerIds.includes(selfId);
    if (!selfRequested) {
      const accept = button(document, STRINGS["results.acceptRematch"]);
      accept.classList.add("primary");
      accept.addEventListener("click", () => onAcceptRematch?.(rematch.afterMatchId));
      item.append(accept);
    }
    items.push(item);
  }
  if (items.length === 0) {
    replaceWithEmpty(shell.yourActivity, STRINGS["lobby.noActivity"]);
    return;
  }
  shell.yourActivity.replaceChildren(...items);
}

/**
 * Projects a durable competition view into Home and Lobby DOM. This function owns
 * only presentation; joining and watching remain opt-in callbacks supplied by the
 * application coordinator.
 */
export function presentCompetition(options: CompetitionPresenterOptions): void {
  const { shell, view, self, realtimeAvailable } = options;
  shell.setHomeChallengeWaiting(view.activity.kind === "waiting");
  shell.setLobbyActivityCounts(view.counts.waiting, view.counts.live);
  shell.setPracticeRecords({
    personalBest: view.practice.personalBest?.score ?? 0,
    ...(view.practice.record === null
      ? {}
      : {
          chatRecord: {
            score: view.practice.record.score,
            playerName: view.practice.record.player.displayName,
          },
        }),
  });

  const competitionLocked = view.activity.kind !== "idle";
  shell.createButton.disabled = !realtimeAvailable || competitionLocked;
  shell.createButton.dataset.availability = shell.createButton.disabled
    ? "unavailable"
    : "available";
  if (competitionLocked) {
    shell.createButton.setAttribute("aria-describedby", shell.homeRecovery.id);
  } else {
    shell.createButton.removeAttribute("aria-describedby");
  }
  // Cancellation is a durable lifecycle update and does not require a live
  // realtime channel. A suspended creator must always be able to free the seat.
  shell.cancelChallengeButton.disabled = false;
  shell.practiceButton.disabled = false;
  if (
    view.activity.kind === "live" &&
    shell.lobbyStatus.textContent !== STRINGS["lobby.staleLink"]
  ) {
    shell.lobbyStatus.textContent = STRINGS["lobby.finishActiveMatch"];
  } else if (shell.lobbyStatus.textContent === STRINGS["lobby.finishActiveMatch"]) {
    shell.lobbyStatus.textContent = "";
  }

  renderYourActivity(options);
  renderOpenChallenges(options);
  renderStartingPairings(options);
  renderLiveMatches(options);
  renderResults(shell, view);
  renderStandings(shell, view, self.id);
  renderPractice(shell, view, self.id);

  setSectionVisible(shell.openChallenges, true);
  for (const body of [
    shell.yourActivity,
    shell.startingSoon,
    shell.liveGames,
    shell.history,
    shell.standings,
    shell.practiceLeaderboard,
  ]) {
    setSectionVisible(body, hasRenderedContent(body));
  }
}
