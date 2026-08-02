import { AudioEngine } from "../audio/engine";
import type { AudioCue } from "../audio/cues";
import { RULES } from "../config/rules";
import { RULES_HASH } from "../config/rules-hash";
import { hashCanonicalHex } from "../domain/hashing";
import {
  createSimulation,
  type Simulation,
  type SimulationEffect,
  type SimulationSnapshot,
} from "../domain/simulation";
import type {
  LogicalAction,
  MatchResultV1,
  PlayerGameState,
  PowerKind,
  StatusState,
} from "../domain/types";
import { GestureInput } from "../input/gestures";
import { KeyboardInput } from "../input/keyboard";
import { transformScrambledAction } from "../input/scramble-transform";
import {
  CompetitiveSession,
  type CompetitivePhase,
  type CompetitiveRealtimeTransport,
  type CompetitiveTerminalState,
} from "../match/competitive-session";
import { decodeEnvelope } from "../network/codec";
import { RemoteSnapshotStore, type PlayerSnapshotV1 } from "../network/snapshots";
import {
  DurableLamportClock,
  MAX_DURABLE_LOGICAL_CLOCK,
  WebxdcDurableLog,
  isLobbyEvent,
  materializeChallenge,
  type LobbyActor,
  type LobbyEventV1,
  type MaterializedChallenge,
} from "../network/webxdc-durable";
import { HistoryMaterializer, isMatchResultV1 } from "../persistence/history";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
  type StoragePort,
} from "../persistence/settings";
import { ThreeRenderer, type BoardViewport, type RendererLayout } from "../render/renderer";
import { createAppShell, countdownText, meterProgress, showHelp, type AppShell, type HudElements } from "../ui/shell";
import { boardModelFromRemoteSnapshot, boardModelFromSimulation } from "./view-model";
import {
  appendBoundedUnique,
  createRuntimeId,
  displayShapeAt,
  formatDuration,
  isSameRuntimeRoster,
  type RuntimeRoster,
} from "./runtime-helpers";
import { materializeRematchRound, type RematchProposalV1 } from "./rematch";
import {
  isMatchAnnouncementV1,
  resultMatchesAnnouncement,
  type MatchAnnouncementV1,
} from "./match-announcement";
import {
  isSessionClaim,
  RuntimeSessionElection,
  type SessionClaimV1,
} from "./runtime-election";
import { STRINGS, formatString, type StringKey } from "./strings";

const PRACTICE_HIGH_SCORE_KEY = "split-stack/practice-high-score/v1";
const FIXED_TICK_MS = 1_000 / RULES.timing.ticksPerSecond;
const MAX_LOBBY_EVENTS = 4_096;
const MAX_REMATCH_EVENTS = 2_048;
const MAX_ANNOUNCEMENTS = 1_024;
const MAX_SESSION_CLAIMS = 2_048;
const MAX_PENDING_RESULTS = 512;

type DurablePayload =
  | LobbyEventV1
  | RematchProposalV1
  | MatchAnnouncementV1
  | SessionClaimV1
  | MatchResultV1;

interface ActiveMatch {
  challenge: MaterializedChallenge;
  round: number;
  matchId: string;
  role: "a" | "b" | "spectator";
  seatASessionId: string;
  seatBSessionId: string;
  duplicateRuntime: boolean;
}

interface SpectatorRuntime {
  channel: WebxdcRealtimeChannel;
  snapshots: RemoteSnapshotStore;
  matchId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRematch(value: unknown): value is RematchProposalV1 {
  if (!isRecord(value) || !isRecord(value.actor)) return false;
  return (
    value.schema === "split-stack/rematch/v1" &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    value.eventId.length <= 256 &&
    Number.isSafeInteger(value.logicalClock) &&
    (value.logicalClock as number) > 0 &&
    (value.logicalClock as number) <= MAX_DURABLE_LOGICAL_CLOCK &&
    typeof value.challengeId === "string" &&
    value.challengeId.length > 0 &&
    value.challengeId.length <= 256 &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) > 1 &&
    (value.round as number) < 10_000 &&
    typeof value.actor.id === "string" &&
    value.actor.id.length > 0 &&
    value.actor.id.length <= 256 &&
    typeof value.actor.displayName === "string" &&
    value.actor.displayName.length <= 128
  );
}

function wait(window: Window, milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, milliseconds)));
}

function safeStorage(window: Window): StoragePort {
  try {
    return window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    };
  }
}

function makeRealtimeTransport(channel: WebxdcRealtimeChannel): CompetitiveRealtimeTransport {
  return {
    setListener: (listener) => channel.setListener(listener),
    send: (data) => channel.send(data),
    leave: () => channel.leave?.(),
  };
}

function shapeName(snapshot: SimulationSnapshot | PlayerSnapshotV1, kind: "hold" | "next"): string {
  const label = (piece: SimulationSnapshot["preview"][number]): string => {
    const marker = piece.specialCellIndex === undefined ? "" : "◆";
    return `${displayShapeAt(piece, performance.now())}${marker}`;
  };
  if (kind === "hold") {
    const held = "player" in snapshot ? snapshot.player.hold : snapshot.hold;
    return held === null ? "—" : label(held);
  }
  const player = "player" in snapshot ? snapshot.player : snapshot;
  if (player.replacementMode?.kind === "monomino-rush") {
    return formatString("hud.replacementSeconds", {
      power: powerLabel("monomino-rush"),
      seconds: Math.ceil(
        (player.replacementMode.remainingTicks ?? 0) /
          RULES.timing.ticksPerSecond,
      ),
    });
  }
  if (player.replacementMode?.kind === "acid-rain") {
    return formatString("hud.replacementPieces", {
      power: powerLabel("acid-rain"),
      count: player.replacementMode.remainingPieces ?? 0,
    });
  }
  const preview = "player" in snapshot ? snapshot.preview : snapshot.nextFive;
  return preview.map(label).join(" ") || "—";
}

function powerLabel(power: PowerKind): string {
  const keys: Record<PowerKind, StringKey> = {
    blackout: "power.blackout",
    scramble: "power.scramble",
    nuke: "power.nuke",
    barrier: "power.barrier",
    collapse: "power.collapse",
    "monomino-rush": "power.monominoRush",
    "acid-rain": "power.acidRain",
  };
  return STRINGS[keys[power]];
}

function statusLabel(status: StatusState): string {
  const seconds = Math.ceil(status.remainingTicks / RULES.timing.ticksPerSecond);
  if (status.kind === "barrier") {
    return formatString("status.barrier", {
      power: powerLabel("barrier"),
      capacity: status.capacity,
      seconds,
    });
  }
  return formatString("status.timed", { power: powerLabel(status.kind), seconds });
}

function applyViewport(element: HTMLElement, viewport: BoardViewport): void {
  element.style.left = `${viewport.boardX - viewport.paneX}px`;
  element.style.top = `${viewport.boardY}px`;
  element.style.width = `${viewport.boardWidth}px`;
  element.style.height = `${viewport.boardHeight}px`;
}

function setDefinitionList(
  shell: AppShell,
  values: ReadonlyArray<readonly [string, string | number]>,
): void {
  const document = shell.resultsStats.ownerDocument;
  shell.resultsStats.replaceChildren();
  for (const [label, value] of values) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = String(value);
    shell.resultsStats.append(term, description);
  }
}

function playerStateFrom(snapshot: SimulationSnapshot | PlayerSnapshotV1): PlayerGameState | null {
  return "player" in snapshot ? snapshot.player : null;
}

function updateHud(
  hud: HudElements,
  name: string,
  snapshot: SimulationSnapshot | PlayerSnapshotV1 | undefined,
): void {
  hud.name.textContent = name;
  if (snapshot === undefined) {
    hud.score.textContent = "0";
    hud.level.textContent = "1";
    hud.lines.textContent = "0";
    hud.hold.textContent = `${STRINGS["hud.hold"]}: —`;
    hud.preview.textContent = `${STRINGS["hud.next"]}: —`;
    hud.upcomingPower.textContent = `${STRINGS["hud.upcomingPower"]}: —`;
    hud.incoming.textContent = `${STRINGS["hud.incomingGarbage"]}: 0`;
    hud.meterFill.style.setProperty("--meter-progress", "0%");
    hud.meter.setAttribute("aria-valuenow", "0");
    hud.statuses.replaceChildren();
    return;
  }
  const player = playerStateFrom(snapshot);
  const score = player?.score ?? (snapshot as PlayerSnapshotV1).score;
  const level = "level" in snapshot ? snapshot.level : 1;
  const lines = player?.lines ?? (snapshot as PlayerSnapshotV1).lines;
  const powerCharge = player?.powerCharge ?? (snapshot as PlayerSnapshotV1).powerCharge;
  const upcomingPower = player?.upcomingPower ?? (snapshot as PlayerSnapshotV1).upcomingPower;
  const statuses = player?.statuses ?? (snapshot as PlayerSnapshotV1).statuses;
  const incoming = player?.incomingGarbage ?? (snapshot as PlayerSnapshotV1).incomingGarbage;
  hud.score.textContent = String(score);
  hud.level.textContent = String(level);
  hud.lines.textContent = String(lines);
  hud.hold.textContent = `${STRINGS["hud.hold"]}: ${shapeName(snapshot, "hold")}`;
  hud.preview.textContent = `${STRINGS["hud.next"]}: ${shapeName(snapshot, "next")}`;
  hud.upcomingPower.textContent = `${STRINGS["hud.upcomingPower"]}: ${powerLabel(upcomingPower)}`;
  hud.incoming.textContent = `${STRINGS["hud.incomingGarbage"]}: ${incoming.reduce((sum, packet) => sum + packet.rows, 0)}`;
  hud.meterFill.style.setProperty("--meter-progress", meterProgress(powerCharge));
  hud.meter.setAttribute("aria-valuenow", String(powerCharge));
  const document = hud.statuses.ownerDocument;
  hud.statuses.replaceChildren(
    ...statuses.map((status) => {
      const pill = document.createElement("span");
      pill.className = "status-pill";
      pill.textContent = statusLabel(status);
      return pill;
    }),
  );
}

function cueForInput(action: LogicalAction): AudioCue {
  if (action === "move-left" || action === "move-right") return "move";
  if (action === "rotate-cw" || action === "rotate-ccw") return "rotate";
  if (action === "soft-drop") return "soft-drop";
  if (action === "hard-drop") return "hard-drop";
  return "hold";
}

function cueForPower(power: PowerKind): AudioCue {
  return `power-${power}` as AudioCue;
}

export async function bootstrap(): Promise<void> {
  const mount = document.getElementById("app");
  if (mount === null) throw new Error("Split Stack mount point is missing");

  const shell = createAppShell(document, mount);
  const storage = safeStorage(window);
  const mediaPrefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let preferences = loadPreferences(storage, mediaPrefersReduced);
  shell.setPreferences(preferences);
  const audio = new AudioEngine();
  let renderer: ThreeRenderer | null = null;
  let latestLayout: RendererLayout | null = null;
  let mode: "lobby" | "practice" | "competitive" | "spectator" | "results" = "lobby";
  let practice: Simulation | null = null;
  let practicePaused = false;
  let practiceAccumulator = 0;
  let competitive: CompetitiveSession | null = null;
  let spectator: SpectatorRuntime | null = null;
  let activeMatch: ActiveMatch | null = null;
  let lastFrameMs = performance.now();
  let announcedConfigHash: string | null = null;
  let lastScrambleActive = false;
  let resultShownFor: string | null = null;

  const host = window.webxdc;
  const selfActor: LobbyActor = {
    id: host?.selfAddr ?? "local-practice",
    displayName: host?.selfName?.slice(0, 128) || STRINGS["common.playerFallback"],
  };
  const realtimeAvailable = typeof host?.joinRealtimeChannel === "function";
  const runtimeId = createRuntimeId();
  const lamport = new DurableLamportClock();
  const lobbyEvents: LobbyEventV1[] = [];
  const eventSerials = new Map<string, number>();
  const rematches: RematchProposalV1[] = [];
  const announcements: MatchAnnouncementV1[] = [];
  const sessionClaims: SessionClaimV1[] = [];
  const localSessionClaims = new Map<string, SessionClaimV1>();
  const pendingResults: Array<{ serial: number; payload: MatchResultV1 }> = [];
  const history = new HistoryMaterializer();
  const durable = host === undefined ? null : new WebxdcDurableLog<unknown>(host);
  let durableReplayReady = durable === null;
  let appendChain = Promise.resolve();
  let lastAppendMs = -Infinity;

  const resumeCompetitiveTransport = (): void => {
    const session = competitive;
    if (session === null) return;
    // Acquire first so a host that disallows joining after `leave()` cannot
    // strand the match. The old channel is retired by disconnect immediately
    // before the new transport is attached.
    const channel = host?.joinRealtimeChannel?.();
    if (channel !== undefined) {
      session.disconnect();
      session.attachTransport(makeRealtimeTransport(channel));
    }
    session.setHidden(false);
  };

  const applyPreferences = (): void => {
    shell.setPreferences(preferences);
    shell.container.dataset.reducedMotion = String(preferences.reducedMotion);
    shell.container.dataset.reducedFlashes = String(preferences.reducedFlashes);
    shell.container.dataset.reducedEffects = String(preferences.reducedEffects);
    shell.container.dataset.palette = preferences.colorPalette;
    shell.container.dataset.screenShake = String(preferences.screenShake);
    shell.touchButtons.hidden =
      mode === "lobby" || mode === "results" || preferences.touchControls !== "buttons";
    audio.setMuted(!preferences.audioEnabled);
    audio.setVolume(preferences.volume);
    renderer?.setReducedEffects(preferences.reducedEffects);
    renderer?.setColorPalette(preferences.colorPalette);
  };

  const positionTargets = (layout: RendererLayout): void => {
    latestLayout = layout;
    applyViewport(shell.left.boardTarget, layout.left);
    applyViewport(shell.left.blackout, layout.left);
    if (layout.right !== null) {
      applyViewport(shell.right.boardTarget, layout.right);
      applyViewport(shell.right.blackout, layout.right);
    }
  };

  try {
    renderer = new ThreeRenderer(shell.canvas, {
      onLayout: positionTargets,
      onContextLost: () => {
        shell.unsupported.hidden = true;
        if (mode === "practice") {
          practicePaused = true;
          practice?.setPaused(true);
          shell.overlay.hidden = false;
          shell.overlayText.textContent = STRINGS["match.webglPaused"];
        } else if (mode === "competitive") {
          competitive?.setHidden(true);
        }
      },
      onContextRestored: () => {
        shell.unsupported.hidden = true;
        if (mode === "competitive") resumeCompetitiveTransport();
        if (mode !== "practice") shell.overlay.hidden = true;
      },
      onUnsupported: () => {
        shell.unsupported.hidden = false;
      },
    });
  } catch {
    renderer = null;
  }
  applyPreferences();

  const appendDurable = async (payload: DurablePayload): Promise<void> => {
    if (durable === null) return;
    const pending = appendChain.catch(() => undefined).then(async () => {
      const interval = Math.max(0, host?.sendUpdateInterval ?? 0);
      await wait(window, lastAppendMs + interval - performance.now());
      await durable.append({ payload });
      lastAppendMs = performance.now();
    });
    appendChain = pending.catch(() => undefined);
    try {
      await pending;
    } catch {
      shell.lobbyStatus.textContent = STRINGS["lobby.challengeError"];
    }
  };

  const eventId = (purpose: string): string => `${runtimeId}:${lamport.next()}:${purpose}`;

  const currentRoundFor = (challenge: MaterializedChallenge): number => {
    return materializeRematchRound(challenge, rematches);
  };

  const allChallenges = (): MaterializedChallenge[] => {
    const ids = new Set(
      lobbyEvents
        .filter((event) => event.kind === "challenge-created")
        .map((event) => event.challengeId),
    );
    return [...ids]
      .map((id) => materializeChallenge(lobbyEvents, id))
      .filter((challenge): challenge is MaterializedChallenge => challenge !== undefined)
      .sort((left, right) => {
        const leftSerial = Math.max(
          ...lobbyEvents
            .filter((event) => event.challengeId === left.challengeId)
            .map((event) => eventSerials.get(event.eventId) ?? 0),
        );
        const rightSerial = Math.max(
          ...lobbyEvents
            .filter((event) => event.challengeId === right.challengeId)
            .map((event) => eventSerials.get(event.eventId) ?? 0),
        );
        return rightSerial - leftSerial;
      });
  };

  const sessionClaimKey = (
    challengeId: string,
    occupancyEventId: string,
    actorId: string,
  ): string => `${challengeId.length}:${challengeId}${occupancyEventId.length}:${occupancyEventId}${actorId}`;

  const electionFor = (
    challengeId: string,
    occupant: MaterializedChallenge["seatA"],
  ): RuntimeSessionElection => {
    const election = new RuntimeSessionElection({
      challengeId,
      occupancyEventId: occupant.occupancyEventId,
      actorId: occupant.playerId,
    });
    for (const claim of sessionClaims) election.apply(claim);
    return election;
  };

  const ensureLocalSessionClaim = (
    challenge: MaterializedChallenge,
    occupant: MaterializedChallenge["seatA"],
  ): SessionClaimV1 | undefined => {
    if (!durableReplayReady || durable === null) return undefined;
    const key = sessionClaimKey(
      challenge.challengeId,
      occupant.occupancyEventId,
      occupant.playerId,
    );
    let localClaim = localSessionClaims.get(key);
    if (localClaim === undefined) {
      const logicalClock = lamport.next();
      localClaim = {
        schema: "split-stack/session-claim/v1",
        kind: "session-claim",
        challengeId: challenge.challengeId,
        occupancyEventId: occupant.occupancyEventId,
        runtimeSessionId: runtimeId,
        actor: selfActor,
        logicalClock,
        eventId: `${runtimeId}:${logicalClock}:session-claim`,
      };
      localSessionClaims.set(key, localClaim);
      void appendDurable(localClaim);
    }
    return localClaim;
  };

  const leaveRuntime = (): void => {
    competitive?.disconnect();
    competitive = null;
    spectator?.channel.leave?.();
    spectator = null;
    activeMatch = null;
    practice = null;
    lastScrambleActive = false;
    announcedConfigHash = null;
    shell.overlay.hidden = true;
  };

  const showLobby = (): void => {
    leaveRuntime();
    mode = "lobby";
    shell.show("lobby");
    shell.readyButton.hidden = false;
    shell.pausePracticeButton.hidden = true;
    shell.touchButtons.hidden = true;
    shell.unsupported.hidden = renderer !== null;
    renderHistory();
  };

  const showResult = (result: MatchResultV1, localPlayerId: string | null): void => {
    if (resultShownFor === result.matchId) return;
    resultShownFor = result.matchId;
    mode = "results";
    const seatA = result.players[0];
    const seatB = result.players[1];
    const localSeat = localPlayerId === seatA?.id ? "seat-a" : localPlayerId === seatB?.id ? "seat-b" : null;
    if (result.outcome === "draw") shell.resultsHeading.textContent = STRINGS["results.draw"];
    else if (result.outcome === "desync") shell.resultsHeading.textContent = STRINGS["results.desync"];
    else if (localSeat === null) shell.resultsHeading.textContent = result.outcome === "seat-a" ? seatA?.displayName ?? STRINGS["results.victory"] : seatB?.displayName ?? STRINGS["results.victory"];
    else shell.resultsHeading.textContent = result.outcome === localSeat ? STRINGS["results.victory"] : STRINGS["results.defeat"];
    const localStats = localPlayerId === null ? undefined : result.statsByPlayer[localPlayerId];
    const stats = localStats ?? (seatA === undefined ? undefined : result.statsByPlayer[seatA.id]);
    setDefinitionList(shell, [
      [STRINGS["results.duration"], formatDuration(result.durationTicks)],
      [STRINGS["results.score"], stats?.score ?? 0],
      [STRINGS["results.lines"], stats?.lines ?? 0],
      [STRINGS["results.garbageSent"], stats?.garbageSent ?? 0],
      [STRINGS["results.tetrises"], stats?.tetrises ?? 0],
      [STRINGS["results.tSpins"], (stats?.tSpinSingles ?? 0) + (stats?.tSpinDoubles ?? 0) + (stats?.tSpinTriples ?? 0)],
      [STRINGS["results.powersActivated"], stats?.powersActivated ?? 0],
    ]);
    shell.rematchButton.hidden = activeMatch?.role === "spectator" || activeMatch === null;
    shell.show("results");
    audio.play(result.outcome === "draw" ? "draw" : localSeat !== null && result.outcome === localSeat ? "victory" : "defeat");
  };

  const showPracticeResult = (snapshot: SimulationSnapshot): void => {
    const previous = Number.parseInt(storage.getItem(PRACTICE_HIGH_SCORE_KEY) ?? "0", 10) || 0;
    const highScore = Math.max(previous, snapshot.player.score);
    try {
      storage.setItem(PRACTICE_HIGH_SCORE_KEY, String(highScore));
    } catch {
      // Practice score is a non-authoritative convenience cache.
    }
    mode = "results";
    shell.resultsHeading.textContent = snapshot.player.score > previous
      ? STRINGS["results.newHighScore"]
      : STRINGS["results.practiceOver"];
    setDefinitionList(shell, [
      [STRINGS["results.duration"], formatDuration(snapshot.tick)],
      [STRINGS["results.score"], snapshot.player.score],
      [STRINGS["results.lines"], snapshot.player.lines],
      [STRINGS["results.garbageSent"], snapshot.player.stats.garbageSent],
      [STRINGS["results.tetrises"], snapshot.player.stats.tetrises],
      [STRINGS["results.tSpins"], snapshot.player.stats.tSpinSingles + snapshot.player.stats.tSpinDoubles + snapshot.player.stats.tSpinTriples],
      [STRINGS["results.powersActivated"], snapshot.player.stats.powersActivated],
    ]);
    shell.rematchButton.hidden = false;
    shell.show("results");
    audio.play("defeat");
  };

  const processEffects = (effects: readonly SimulationEffect[], pan = -0.45): void => {
    for (const effect of effects) {
      if (effect.kind === "piece-locked") audio.play("lock", { pan });
      else if (effect.kind === "line-clear") {
        const cue: AudioCue = effect.rows === 1 ? "single" : effect.rows === 2 ? "double" : effect.rows === 3 ? "triple" : "four-line";
        audio.play(cue, { pan });
      } else if (effect.kind === "garbage-rise") audio.play("garbage-rise", { pan });
      else if (effect.kind === "hollow-cross" || effect.kind === "glitch-piece") audio.play("special-trigger", { pan });
      else if (effect.kind === "power-activated" && effect.power !== undefined) audio.play(cueForPower(effect.power), { pan });
      else if (effect.kind === "top-out" && mode === "practice" && practice !== null) showPracticeResult(practice.readSnapshot());
    }
  };

  const scrambleActive = (): boolean => {
    const snapshot = mode === "practice" ? practice?.readSnapshot() : competitive?.view().local;
    return snapshot?.player.statuses.some((status) => status.kind === "scramble") ?? false;
  };

  const dispatchInput = (rawAction: LogicalAction): void => {
    if (mode !== "practice" && mode !== "competitive") return;
    const scrambled = scrambleActive();
    const action = transformScrambledAction(rawAction, scrambled);
    audio.play(cueForInput(action), { pan: -0.45 });
    if (preferences.vibration && (action === "hard-drop" || action === "hold")) navigator.vibrate?.(18);
    const effects = mode === "practice" ? practice?.dispatch(action) ?? [] : competitive?.dispatch(action) ?? [];
    processEffects(effects);
  };

  const keyboard = new KeyboardInput(window, ({ action }) => dispatchInput(action));
  const gestures = new GestureInput(shell.left.boardTarget, ({ action }) => dispatchInput(action), {
    getCellSize: () => latestLayout?.left.cellSize ?? 24,
  });

  const setInputsEnabled = (enabled: boolean): void => {
    keyboard.setEnabled(enabled);
    gestures.setEnabled(enabled && preferences.touchControls === "gestures");
    shell.left.pane.setAttribute("aria-disabled", String(!enabled));
  };

  const startPractice = (): void => {
    leaveRuntime();
    resultShownFor = null;
    mode = "practice";
    practicePaused = false;
    practiceAccumulator = 0;
    practice = createSimulation({
      seed: createRuntimeId(),
      playerId: selfActor.id,
      practice: true,
    });
    shell.arena.dataset.mode = "practice";
    shell.left.pane.classList.add("is-local");
    shell.left.boardTarget.setAttribute("aria-label", STRINGS["match.localBoard"]);
    shell.readyButton.hidden = true;
    shell.pausePracticeButton.hidden = false;
    shell.pausePracticeButton.textContent = STRINGS["controls.pauseShort"];
    shell.pausePracticeButton.setAttribute("aria-label", STRINGS["controls.pausePractice"]);
    shell.overlay.hidden = true;
    shell.show("match");
    applyPreferences();
    setInputsEnabled(true);
  };

  const spectatorRuntime = (match: ActiveMatch): SpectatorRuntime | null => {
    const channel = host?.joinRealtimeChannel?.();
    const seatB = match.challenge.seatB;
    if (channel === undefined || seatB === null) return null;
    const snapshots = new RemoteSnapshotStore();
    snapshots.bind(match.challenge.seatA.playerId, match.seatASessionId);
    snapshots.bind(seatB.playerId, match.seatBSessionId);
    const allowed = new Set([match.challenge.seatA.playerId, seatB.playerId]);
    channel.setListener((bytes) => {
      const decoded = decodeEnvelope(bytes, { expectedMatchId: match.matchId, allowedSenderIds: allowed });
      if (decoded.ok && decoded.value.kind === "SNAPSHOT") snapshots.accept(decoded.value);
    });
    return { channel, snapshots, matchId: match.matchId };
  };

  const phaseText = (phase: CompetitivePhase, countdownTicks: number): string => {
    if (phase === "countdown") return countdownText(Math.max(1, Math.ceil(countdownTicks / RULES.timing.ticksPerSecond)));
    if (phase === "network-pause") return STRINGS["match.reconnecting"];
    if (phase === "version-mismatch") return STRINGS["match.versionMismatch"];
    if (phase === "desynchronized") return STRINGS["match.desynchronization"];
    if (phase === "synchronizing") return STRINGS["match.waitingForReady"];
    return STRINGS["match.waitingForReady"];
  };

  const startActiveMatch = (match: ActiveMatch): void => {
    // Join the replacement channel before retiring the old one. Besides
    // avoiding a receive gap, this supports hosts that reject a rejoin after a
    // channel has already been explicitly trashed.
    const previousCompetitive = competitive;
    const previousSpectator = spectator;
    competitive = null;
    spectator = null;
    practice = null;
    lastScrambleActive = false;
    announcedConfigHash = null;
    let previousRetired = false;
    const retirePrevious = (): void => {
      if (previousRetired) return;
      previousRetired = true;
      previousCompetitive?.disconnect();
      previousSpectator?.channel.leave?.();
    };
    activeMatch = match;
    resultShownFor = null;
    announcedConfigHash = null;
    shell.arena.dataset.mode = "versus";
    shell.pausePracticeButton.hidden = true;
    shell.touchButtons.hidden = match.role === "spectator" || preferences.touchControls !== "buttons";
    shell.readyButton.hidden = match.role === "spectator";
    shell.left.boardTarget.setAttribute("aria-label", match.role === "spectator" ? STRINGS["match.seatABoard"] : STRINGS["match.localBoard"]);
    shell.right.boardTarget.setAttribute("aria-label", match.role === "spectator" ? STRINGS["match.seatBBoard"] : STRINGS["match.opponentBoard"]);
    shell.show("match");

    if (match.role === "spectator") {
      mode = "spectator";
      spectator = spectatorRuntime(match);
      retirePrevious();
      shell.left.pane.classList.remove("is-local");
      shell.right.pane.classList.remove("is-remote");
      shell.overlay.hidden = false;
      shell.overlayText.textContent = match.duplicateRuntime
        ? STRINGS["lobby.duplicateSession"]
        : STRINGS["lobby.spectatorNotice"];
      setInputsEnabled(false);
      return;
    }

    const seatB = match.challenge.seatB;
    const channel = host?.joinRealtimeChannel?.();
    retirePrevious();
    if (seatB === null || channel === undefined) {
      shell.overlay.hidden = false;
      shell.overlayText.textContent = STRINGS["lobby.realtimeUnavailable"];
      return;
    }
    mode = "competitive";
    shell.left.pane.classList.add("is-local");
    shell.right.pane.classList.add("is-remote");
    const local = match.role === "a" ? match.challenge.seatA : seatB;
    const peer = match.role === "a" ? seatB : match.challenge.seatA;
    competitive = new CompetitiveSession({
      matchId: match.matchId,
      seat: match.role,
      identity: {
        senderId: local.playerId,
        sessionId: match.role === "a" ? match.seatASessionId : match.seatBSessionId,
        displayName: local.displayName,
      },
      peer: {
        senderId: peer.playerId,
        sessionId: match.role === "a" ? match.seatBSessionId : match.seatASessionId,
        displayName: peer.displayName,
      },
      rulesHash: RULES_HASH,
      clock: { now: () => performance.now() },
      transport: makeRealtimeTransport(channel),
      onPhaseChange: (phase) => {
        const view = competitive?.view();
        shell.readyButton.hidden = phase !== "lobby";
        shell.overlay.hidden = phase === "playing" || phase === "finished";
        shell.overlayText.textContent = phaseText(phase, view?.countdownTicks ?? 0);
        setInputsEnabled(phase === "playing");
      },
      onTerminal: (_terminal: CompetitiveTerminalState) => {
        setInputsEnabled(false);
      },
      onResultConfirmed: (result) => {
        void appendDurable(result);
        showResult(result, selfActor.id);
      },
      onDesynchronization: () => {
        shell.overlay.hidden = false;
        shell.overlayText.textContent = STRINGS["match.desynchronization"];
      },
    });
    competitive.start();
    setInputsEnabled(false);
    shell.overlay.hidden = false;
    shell.overlayText.textContent = STRINGS["match.waitingForReady"];
  };

  const reconcileLobby = (): void => {
    const challenges = allChallenges().filter((challenge) => !challenge.closed);
    const activeChallenge = activeMatch === null
      ? undefined
      : challenges.find(
          (challenge) => challenge.challengeId === activeMatch?.challenge.challengeId,
        );
    if (
      activeMatch !== null &&
      (activeChallenge === undefined || activeChallenge.seatB === null)
    ) {
      // A durable close/release invalidates the realtime binding immediately.
      // The open challenge may become playable again after a fresh seat claim.
      showLobby();
    }
    const owned = challenges.find(
      (challenge) => challenge.seatA.playerId === selfActor.id || challenge.seatB?.playerId === selfActor.id,
    );
    const full = owned?.seatB !== null && owned?.seatB !== undefined
      ? owned
      : challenges.find((challenge) => challenge.seatB !== null);
    const selected = owned ?? full;

    const joinable = challenges.find(
      (challenge) => challenge.seatB === null && challenge.seatA.playerId !== selfActor.id,
    );
    shell.joinButton.disabled = !realtimeAvailable || joinable === undefined;
    shell.createButton.disabled = !realtimeAvailable || owned !== undefined;
    if (!realtimeAvailable) shell.lobbyStatus.textContent = STRINGS["lobby.realtimeUnavailable"];
    else if (owned !== undefined && owned.seatB === null) shell.lobbyStatus.textContent = STRINGS["lobby.waitingForOpponent"];
    else shell.lobbyStatus.textContent = "";

    if (selected === undefined || selected.seatB === null) return;
    const round = currentRoundFor(selected);
    const assignedRole = selected.seatA.playerId === selfActor.id
      ? "a"
      : selected.seatB.playerId === selfActor.id
        ? "b"
        : "spectator";
    const localClaim = assignedRole === "a"
      ? ensureLocalSessionClaim(selected, selected.seatA)
      : assignedRole === "b"
        ? ensureLocalSessionClaim(selected, selected.seatB)
        : undefined;
    if (
      assignedRole !== "spectator" &&
      (localClaim === undefined ||
        !sessionClaims.some(
          (claim) =>
            claim.eventId === localClaim.eventId &&
            claim.runtimeSessionId === localClaim.runtimeSessionId,
        ))
    ) {
      shell.lobbyStatus.textContent = STRINGS["lobby.confirmingSession"];
      return;
    }

    const seatAWinner = electionFor(selected.challengeId, selected.seatA).winner();
    const seatBWinner = electionFor(selected.challengeId, selected.seatB).winner();
    if (seatAWinner === undefined || seatBWinner === undefined) {
      shell.lobbyStatus.textContent = STRINGS["lobby.confirmingSession"];
      return;
    }
    const duplicateRuntime =
      (assignedRole === "a" && seatAWinner.runtimeSessionId !== runtimeId) ||
      (assignedRole === "b" && seatBWinner.runtimeSessionId !== runtimeId);
    const role = duplicateRuntime ? "spectator" : assignedRole;
    const next: ActiveMatch = {
      challenge: selected,
      round,
      matchId: `${selected.challengeId}:round:${round}`,
      role,
      seatASessionId: seatAWinner.runtimeSessionId,
      seatBSessionId: seatBWinner.runtimeSessionId,
      duplicateRuntime,
    };
    const nextRoster: RuntimeRoster = {
      matchId: next.matchId,
      role: next.role,
      seatAOccupancyEventId: selected.seatA.occupancyEventId,
      seatBOccupancyEventId: selected.seatB.occupancyEventId,
      seatASessionId: next.seatASessionId,
      seatBSessionId: next.seatBSessionId,
    };
    const currentRoster: RuntimeRoster | null = activeMatch?.challenge.seatB === null || activeMatch === null
      ? null
      : {
          matchId: activeMatch.matchId,
          role: activeMatch.role,
          seatAOccupancyEventId: activeMatch.challenge.seatA.occupancyEventId,
          seatBOccupancyEventId: activeMatch.challenge.seatB.occupancyEventId,
          seatASessionId: activeMatch.seatASessionId,
          seatBSessionId: activeMatch.seatBSessionId,
        };
    if (currentRoster === null || !isSameRuntimeRoster(currentRoster, nextRoster)) {
      startActiveMatch(next);
    }
  };

  function renderHistory(): void {
    const document = shell.history.ownerDocument;
    shell.history.replaceChildren();
    const view = history.view();
    if (view.latest.length === 0) {
      const empty = document.createElement("li");
      empty.className = "muted";
      const highScore = Number.parseInt(storage.getItem(PRACTICE_HIGH_SCORE_KEY) ?? "0", 10) || 0;
      empty.textContent = highScore > 0
        ? formatString("lobby.practiceHighScore", { score: highScore })
        : STRINGS["lobby.noMatches"];
      shell.history.append(empty);
      return;
    }
    for (const item of view.latest) {
      const row = document.createElement("li");
      row.className = "history-item";
      const players = item.result.players.map((player) => player.displayName).join(" · ");
      const outcome = item.conflicted
        ? STRINGS["results.desync"]
        : item.result.outcome === "draw"
          ? STRINGS["results.draw"]
          : item.result.players[item.result.outcome === "seat-a" ? 0 : 1]?.displayName ?? STRINGS["results.desync"];
      row.textContent = formatString("lobby.historyResult", { players, outcome });
      shell.history.append(row);
    }
    for (const tally of view.tallies) {
      const relevant = view.latest.find((item) => item.result.players.some((player) => player.id === tally.playerIds[0]));
      const names = tally.playerIds.map((id) => relevant?.result.players.find((player) => player.id === id)?.displayName ?? STRINGS["common.playerFallback"]);
      const score = `${tally.winsByPlayer[tally.playerIds[0]] ?? 0}–${tally.winsByPlayer[tally.playerIds[1]] ?? 0}`;
      const row = document.createElement("li");
      row.className = "history-item tally";
      row.textContent = formatString("lobby.tallyResult", { players: names.join(" · "), score });
      shell.history.append(row);
    }
  }

  const applyAuthenticatedResult = (
    payload: MatchResultV1,
    serial: number,
  ): boolean => {
    const announcement = announcements.find(
      (candidate) => candidate.matchId === payload.matchId,
    );
    if (announcement === undefined || !resultMatchesAnnouncement(payload, announcement)) {
      return false;
    }
    history.apply({ serial, payload });
    renderHistory();
    if (activeMatch?.matchId === payload.matchId && activeMatch.role === "spectator") {
      showResult(payload, null);
    }
    return true;
  };

  const replayPendingResults = (matchId: string): void => {
    for (let index = pendingResults.length - 1; index >= 0; index -= 1) {
      const pending = pendingResults[index];
      if (pending === undefined || pending.payload.matchId !== matchId) continue;
      if (applyAuthenticatedResult(pending.payload, pending.serial)) {
        pendingResults.splice(index, 1);
      }
    }
  };

  const receiveDurable = (payload: unknown, serial: number): void => {
    if (isLobbyEvent(payload)) {
      if (appendBoundedUnique(lobbyEvents, payload, MAX_LOBBY_EVENTS)) {
        eventSerials.set(payload.eventId, serial);
      }
      lamport.observe(payload.logicalClock);
      reconcileLobby();
    } else if (isRematch(payload)) {
      appendBoundedUnique(rematches, payload, MAX_REMATCH_EVENTS);
      lamport.observe(payload.logicalClock);
      reconcileLobby();
    } else if (isMatchAnnouncementV1(payload, RULES_HASH)) {
      appendBoundedUnique(announcements, payload, MAX_ANNOUNCEMENTS);
      lamport.observe(payload.logicalClock);
      replayPendingResults(payload.matchId);
    } else if (isSessionClaim(payload)) {
      appendBoundedUnique(sessionClaims, payload, MAX_SESSION_CLAIMS);
      lamport.observe(payload.logicalClock);
      reconcileLobby();
    } else if (isMatchResultV1(payload)) {
      if (!applyAuthenticatedResult(payload, serial)) {
        const variantsForMatch = pendingResults.filter(
          (pending) => pending.payload.matchId === payload.matchId,
        ).length;
        if (pendingResults.length < MAX_PENDING_RESULTS && variantsForMatch < 2) {
          pendingResults.push({ serial, payload });
        }
      }
    }
  };

  shell.practiceButton.addEventListener("click", startPractice);
  shell.helpButton.addEventListener("click", () => showHelp(shell, "how"));
  shell.glossaryButton.addEventListener("click", () => showHelp(shell, "powers"));
  shell.controlsHelpButton.addEventListener("click", () => showHelp(shell, "controls"));
  shell.helpBack.addEventListener("click", () => shell.show("lobby"));
  shell.settingsButton.addEventListener("click", () => shell.show("settings"));
  shell.settingsBack.addEventListener("click", () => {
    preferences = {
      audioEnabled: shell.settingsInputs.audioEnabled.checked,
      volume: Number(shell.settingsInputs.volume.value),
      vibration: shell.settingsInputs.vibration.checked,
      touchControls: shell.settingsInputs.touchControls.value === "buttons" ? "buttons" : "gestures",
      colorPalette: shell.settingsInputs.colorPalette.value === "colorblind" ? "colorblind" : "standard",
      reducedMotion: shell.settingsInputs.reducedMotion.checked,
      reducedFlashes: shell.settingsInputs.reducedFlashes.checked,
      reducedEffects: shell.settingsInputs.reducedEffects.checked,
      screenShake: shell.settingsInputs.screenShake.checked,
      gameplayTips: shell.settingsInputs.gameplayTips.checked,
    };
    savePreferences(storage, preferences);
    applyPreferences();
    shell.show("lobby");
  });
  for (const input of Object.values(shell.settingsInputs)) {
    input.addEventListener("change", () => {
      shell.settingsBack.click();
      shell.settingsButton.click();
    });
  }

  shell.createButton.addEventListener("click", () => {
    const challengeId = createRuntimeId();
    const createdId = eventId("challenge-created");
    shell.lobbyStatus.textContent = STRINGS["lobby.challengeCreated"];
    void appendDurable({
      schema: "split-stack/lobby/v1",
      kind: "challenge-created",
      eventId: createdId,
      logicalClock: lamport.next(),
      challengeId,
      actor: selfActor,
      seatBVacancyId: `${createdId}:vacancy-b`,
      rulesHash: RULES_HASH,
    });
  });

  shell.joinButton.addEventListener("click", () => {
    const challenge = allChallenges().find(
      (candidate) => !candidate.closed && candidate.seatB === null && candidate.seatA.playerId !== selfActor.id,
    );
    if (challenge === undefined) {
      shell.lobbyStatus.textContent = STRINGS["lobby.noOpenChallenge"];
      return;
    }
    shell.lobbyStatus.textContent = STRINGS["lobby.challengeJoined"];
    void appendDurable({
      schema: "split-stack/lobby/v1",
      kind: "seat-claimed",
      eventId: eventId("seat-claimed"),
      logicalClock: lamport.next(),
      challengeId: challenge.challengeId,
      actor: selfActor,
      vacancyId: challenge.currentSeatBVacancyId,
    });
  });

  shell.readyButton.addEventListener("click", () => {
    const session = competitive;
    if (session === null) return;
    const ready = !session.view().localReady;
    session.setReady(ready);
    shell.readyButton.textContent = ready ? STRINGS["match.notReady"] : STRINGS["match.ready"];
  });

  shell.pausePracticeButton.addEventListener("click", () => {
    if (practice === null) return;
    practicePaused = !practicePaused;
    practice.setPaused(practicePaused);
    shell.pausePracticeButton.textContent = practicePaused
      ? STRINGS["controls.resumeShort"]
      : STRINGS["controls.pauseShort"];
    shell.pausePracticeButton.setAttribute(
      "aria-label",
      practicePaused ? STRINGS["controls.resumePractice"] : STRINGS["controls.pausePractice"],
    );
    shell.overlay.hidden = !practicePaused;
    shell.overlayText.textContent = STRINGS["match.practicePaused"];
    setInputsEnabled(!practicePaused);
  });

  const leaveChallenge = (): void => {
    const match = activeMatch;
    if (mode === "competitive") competitive?.forfeit();
    if (match !== null && match.role !== "spectator") {
      const occupant = match.role === "a" ? match.challenge.seatA : match.challenge.seatB;
      if (match.role === "a") {
        void appendDurable({
          schema: "split-stack/lobby/v1",
          kind: "challenge-closed",
          eventId: eventId("challenge-closed"),
          logicalClock: lamport.next(),
          challengeId: match.challenge.challengeId,
          actor: selfActor,
        });
      } else if (occupant !== null) {
        void appendDurable({
          schema: "split-stack/lobby/v1",
          kind: "seat-released",
          eventId: eventId("seat-released"),
          logicalClock: lamport.next(),
          challengeId: match.challenge.challengeId,
          actor: selfActor,
          occupancyEventId: occupant.occupancyEventId,
          nextVacancyId: `${runtimeId}:${lamport.next()}:vacancy-b`,
        });
      }
    }
    showLobby();
  };
  shell.leaveMatchButton.addEventListener("click", leaveChallenge);
  shell.resultsLeaveButton.addEventListener("click", leaveChallenge);
  shell.rematchButton.addEventListener("click", () => {
    if (activeMatch === null) {
      startPractice();
      return;
    }
    const nextRound = activeMatch.round + 1;
    void appendDurable({
      schema: "split-stack/rematch/v1",
      eventId: eventId("rematch"),
      logicalClock: lamport.next(),
      challengeId: activeMatch.challenge.challengeId,
      round: nextRound,
      actor: selfActor,
    });
  });

  for (const control of shell.touchButtons.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    let repeatTimer: number | null = null;
    let delayTimer: number | null = null;
    const action = control.dataset.action as LogicalAction;
    const stop = (): void => {
      if (repeatTimer !== null) window.clearInterval(repeatTimer);
      if (delayTimer !== null) window.clearTimeout(delayTimer);
      repeatTimer = null;
      delayTimer = null;
    };
    control.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dispatchInput(action);
      if (action === "move-left" || action === "move-right" || action === "soft-drop") {
        const delay = action === "soft-drop" ? RULES.timing.softDropRepeatMs : RULES.timing.dasMs;
        delayTimer = window.setTimeout(() => {
          repeatTimer = window.setInterval(() => dispatchInput(action), RULES.timing.arrMs);
        }, delay);
      }
    });
    control.addEventListener("click", (event) => event.preventDefault());
    control.addEventListener("pointerup", stop);
    control.addEventListener("pointercancel", stop);
    control.addEventListener("pointerleave", stop);
  }

  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    if (mode === "practice" && practice !== null) {
      practicePaused = hidden || practicePaused;
      practice.setPaused(practicePaused);
      if (hidden) {
        shell.overlay.hidden = false;
        shell.overlayText.textContent = STRINGS["match.practicePaused"];
      }
    } else if (mode === "competitive") {
      if (hidden) competitive?.setHidden(true);
      else resumeCompetitiveTransport();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (
      mode === "practice" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key.toLowerCase() === "p" || event.key === "Escape")
    ) {
      event.preventDefault();
      shell.pausePracticeButton.click();
    }
  });
  window.addEventListener("pointerdown", () => void audio.unlock(), { once: true });
  window.addEventListener("keydown", () => void audio.unlock(), { once: true });

  const renderFrame = (now: number): void => {
    const elapsed = Math.min(250, Math.max(0, now - lastFrameMs));
    lastFrameMs = now;
    let leftBoard = null;
    let rightBoard = null;
    let renderMode: "practice" | "versus" = "versus";

    if (mode === "practice" && practice !== null) {
      if (!practicePaused) {
        practiceAccumulator += elapsed;
        while (practiceAccumulator >= FIXED_TICK_MS) {
          processEffects(practice.tick(1));
          practiceAccumulator -= FIXED_TICK_MS;
        }
      }
      const snapshot = practice.readSnapshot();
      leftBoard = boardModelFromSimulation(snapshot, true, false);
      updateHud(shell.left, selfActor.displayName, snapshot);
      shell.left.blackout.hidden = true;
      renderMode = "practice";
    } else if (mode === "competitive" && competitive !== null && activeMatch !== null) {
      competitive.pump();
      const view = competitive.view();
      const seatB = activeMatch.challenge.seatB;
      const localName = activeMatch.role === "a" ? activeMatch.challenge.seatA.displayName : seatB?.displayName ?? selfActor.displayName;
      const peerName = activeMatch.role === "a"
        ? seatB?.displayName ?? STRINGS["common.playerFallback"]
        : activeMatch.challenge.seatA.displayName;
      if (view.local !== undefined) leftBoard = boardModelFromSimulation(view.local, true, false);
      const remoteConcealed = view.remote?.statuses.some((status) => status.kind === "blackout") ?? false;
      if (view.remote !== undefined) rightBoard = boardModelFromRemoteSnapshot(view.remote, false, remoteConcealed);
      updateHud(shell.left, localName, view.local);
      updateHud(shell.right, peerName, view.remote);
      shell.left.blackout.hidden = true;
      shell.right.blackout.hidden = !remoteConcealed;
      shell.overlay.hidden = view.phase === "playing" || view.phase === "finished";
      if (!shell.overlay.hidden) shell.overlayText.textContent = phaseText(view.phase, view.countdownTicks);
      const scrambled = view.local?.player.statuses.some((status) => status.kind === "scramble") ?? false;
      if (scrambled && !lastScrambleActive) keyboard.releaseHorizontal();
      lastScrambleActive = scrambled;
      if (view.result !== undefined) showResult(view.result, selfActor.id);
      if (
        activeMatch.role === "a" &&
        view.configHash !== undefined &&
        view.seed !== undefined &&
        announcedConfigHash !== view.configHash
      ) {
        announcedConfigHash = view.configHash;
        void appendDurable({
          schema: "split-stack/match-announcement/v1",
          eventId: eventId("match-announcement"),
          logicalClock: lamport.next(),
          challengeId: activeMatch.challenge.challengeId,
          matchId: activeMatch.matchId,
          round: activeMatch.round,
          rulesHash: RULES_HASH,
          configHash: view.configHash,
          seed: view.seed,
          seedHash: hashCanonicalHex({ seed: view.seed }),
          seatAPlayerId: activeMatch.challenge.seatA.playerId,
          seatBPlayerId: activeMatch.challenge.seatB?.playerId ?? "",
          actor: selfActor,
        });
      }
    } else if (mode === "spectator" && spectator !== null && activeMatch !== null) {
      const seatB = activeMatch.challenge.seatB;
      const left = spectator.snapshots.latest(activeMatch.challenge.seatA.playerId);
      const right = seatB === null ? undefined : spectator.snapshots.latest(seatB.playerId);
      const leftConcealed = left?.statuses.some((status) => status.kind === "blackout") ?? false;
      const rightConcealed = right?.statuses.some((status) => status.kind === "blackout") ?? false;
      if (left !== undefined) leftBoard = boardModelFromRemoteSnapshot(left, false, leftConcealed);
      if (right !== undefined) rightBoard = boardModelFromRemoteSnapshot(right, false, rightConcealed);
      updateHud(shell.left, activeMatch.challenge.seatA.displayName, left);
      updateHud(shell.right, seatB?.displayName ?? STRINGS["common.playerFallback"], right);
      shell.left.blackout.hidden = !leftConcealed;
      shell.right.blackout.hidden = !rightConcealed;
      if (left !== undefined || right !== undefined) shell.overlay.hidden = true;
    }

    renderer?.render({ mode: renderMode, left: leftBoard, right: rightBoard }, now);
    window.requestAnimationFrame(renderFrame);
  };

  shell.createButton.disabled = !realtimeAvailable;
  shell.joinButton.disabled = true;
  shell.lobbyStatus.textContent = !realtimeAvailable
    ? STRINGS["lobby.realtimeUnavailable"]
    : renderer === null
      ? STRINGS["match.unsupportedWebgl"]
      : "";
  shell.pausePracticeButton.hidden = true;
  shell.show("lobby");
  renderHistory();
  setInputsEnabled(false);
  window.requestAnimationFrame(renderFrame);

  if (durable !== null) {
    await durable.start((update) => receiveDurable(update.payload, update.serial), 0);
    durableReplayReady = true;
    reconcileLobby();
  }
}
