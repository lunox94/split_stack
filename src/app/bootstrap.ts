import { AudioEngine } from "../audio/engine";
import type { AudioCue } from "../audio/cues";
import type { MusicIntensity } from "../audio/music";
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
  PieceDescriptor,
  PlayerGameState,
  PowerKind,
  ReplacementMode,
  StatusState,
} from "../domain/types";
import { GestureInput, isGameplayGestureTarget } from "../input/gestures";
import { KeyboardInput } from "../input/keyboard";
import { transformScrambledAction } from "../input/scramble-transform";
import { TouchButtonInput } from "../input/touch-buttons";
import {
  CompetitiveSession,
  type CompetitiveRealtimeTransport,
  type CompetitiveSessionView,
  type CompetitiveTerminalState,
} from "../match/competitive-session";
import { decodeEnvelope } from "../network/codec";
import { NetworkDiagnostics } from "../network/diagnostics";
import { RemoteSnapshotStore, type PlayerSnapshotV1 } from "../network/snapshots";
import { parseSnapshotProfile } from "../network/snapshot-profile";
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
import { createPowerTipTracker } from "../persistence/power-tips";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
  type StoragePort,
} from "../persistence/settings";
import {
  POWER_ACCENT_COLORS,
} from "../render/power-icons";
import {
  SPECIAL_ACCENT_COLORS,
} from "../render/special-icons";
import {
  ThreeRenderer,
  type BoardRenderModel,
  type BoardViewport,
  type RendererLayout,
} from "../render/renderer";
import {
  createAppShell,
  hideGameplayPowerTip,
  positionGameplayTip,
  positionHudToViewport,
  renderTimedEffects,
  setElementHidden,
  setHudGarbage,
  setHudPower,
  setMatchMenu,
  showHelp,
  showGameplayPowerTip,
  type AppShell,
  type HudElements,
  type TimedEffectHudItem,
} from "../ui/shell";
import type { PiecePreviewOptions } from "../ui/piece-preview";
import { boardModelFromRemoteSnapshot, boardModelFromSimulation } from "./view-model";
import {
  cueForAcceptedInput,
  cueForIncomingAttack,
  panForPowerCue,
} from "./audio-policy";
import { PresentationRouter } from "./presentation-router";
import {
  appendBoundedUnique,
  createRuntimeId,
  formatDuration,
  isSameRuntimeRoster,
  shouldGameplayMusicRun,
  shouldUseStaticMarkedCells,
  type AppRuntimeMode,
  type RuntimeRoster,
} from "./runtime-helpers";
import { materializeRematchRound, type RematchProposalV1 } from "./rematch";
import {
  announcementMatchesChallenge,
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
import { PresentationTimeline } from "../render/presentation-timeline";
import {
  NETWORKED_PRESENTATION_FPS,
  RuntimePresentationCadence,
} from "./presentation-cadence";
import { recoveryPresentationFor } from "./recovery-presentation";

const PRACTICE_HIGH_SCORE_KEY = "split-stack/practice-high-score/v1";
const FIXED_TICK_MS = 1_000 / RULES.timing.ticksPerSecond;
const MAX_LOBBY_EVENTS = 4_096;
const MAX_REMATCH_EVENTS = 2_048;
const MAX_ANNOUNCEMENTS = 1_024;
const MAX_SESSION_CLAIMS = 2_048;
const MAX_PENDING_RESULTS = 512;
const SNAPSHOT_PROFILE = parseSnapshotProfile(
  import.meta.env.VITE_SPLIT_STACK_SNAPSHOT_HZ,
);

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

interface RemoteRenderCache {
  matchId: string;
  snapshot: PlayerSnapshotV1;
  board: BoardRenderModel;
  concealed: boolean;
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

type DisplayPowerKind = PowerKind | "blackout" | "barrier";

function powerLabel(power: DisplayPowerKind): string {
  const keys: Record<DisplayPowerKind, StringKey> = {
    scramble: "power.scramble",
    nuke: "power.nuke",
    collapse: "power.collapse",
    "monomino-rush": "power.monominoRush",
    "acid-rain": "power.acidRain",
    oversize: "power.oversize",
    "ghost-jam": "power.ghostJam",
    blackout: "power.blackout",
    barrier: "power.barrier",
  };
  return STRINGS[keys[power]];
}

function powerDescription(power: PowerKind): string {
  const keys: Record<PowerKind, StringKey> = {
    scramble: "power.scrambleDescription",
    nuke: "power.nukeDescription",
    collapse: "power.collapseDescription",
    "monomino-rush": "power.monominoRushDescription",
    "acid-rain": "power.acidRainDescription",
    oversize: "power.oversizeDescription",
    "ghost-jam": "power.ghostJamDescription",
  };
  return STRINGS[keys[power]];
}

function timedEffectHudItems(
  statuses: readonly StatusState[],
  replacementMode: ReplacementMode | null,
): TimedEffectHudItem[] {
  const effects: TimedEffectHudItem[] = statuses.map((status) => {
    const totalTicks = status.kind === "scramble"
      ? RULES.power.scrambleTicks
      : status.kind === "ghost-jam"
        ? RULES.power.ghostJamTicks
        : status.kind === "blackout"
          ? RULES.power.blackoutTicks
          : RULES.garbage.barrierTicks;
    const accent = status.kind === "blackout" || status.kind === "barrier"
      ? SPECIAL_ACCENT_COLORS[status.kind]
      : POWER_ACCENT_COLORS[status.kind];
    return {
      id: status.kind,
      label: powerLabel(status.kind),
      ...(status.kind === "barrier" ? { detail: String(status.capacity) } : {}),
      remainingTicks: status.remainingTicks,
      totalTicks,
      accent,
    };
  });
  if (replacementMode?.kind === "monomino-rush") {
    effects.push({
      id: "monomino-rush",
      label: powerLabel("monomino-rush"),
      remainingTicks: replacementMode.remainingTicks ?? 0,
      totalTicks: RULES.power.monominoRushTicks,
      accent: POWER_ACCENT_COLORS["monomino-rush"],
    });
  }
  return effects;
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

const HUD_STATUS_SIGNATURES = new WeakMap<HTMLElement, string>();

function setTextContentIfChanged(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setTimedEffectsIfChanged(
  hud: HudElements,
  effects: readonly TimedEffectHudItem[],
): void {
  const signature = JSON.stringify(effects);
  if (HUD_STATUS_SIGNATURES.get(hud.statuses) === signature) return;
  HUD_STATUS_SIGNATURES.set(hud.statuses, signature);
  renderTimedEffects(hud, effects);
}

export function updateHud(
  hud: HudElements,
  name: string,
  snapshot: SimulationSnapshot | PlayerSnapshotV1 | undefined,
  previewOptions: PiecePreviewOptions,
): void {
  setTextContentIfChanged(hud.name, name);
  if (snapshot === undefined) {
    setTextContentIfChanged(hud.score, "0");
    setTextContentIfChanged(hud.level, "1");
    setTextContentIfChanged(hud.lines, "0");
    hud.setPiecePreviews(null, [], previewOptions);
    hud.upcomingPower.replaceChildren();
    delete hud.upcomingPower.dataset.power;
    hud.upcomingPower.setAttribute("aria-label", `${STRINGS["hud.upcomingPower"]}: —`);
    hud.meterSegments.forEach((segment) => segment.classList.remove("is-filled"));
    hud.meter.setAttribute("aria-valuenow", "0");
    hud.meter.setAttribute(
      "aria-valuetext",
      formatString("hud.powerCharge", { charge: 0, threshold: RULES.power.threshold }),
    );
    delete hud.meter.dataset.powerCursor;
    setHudGarbage(hud, 0, false);
    setTimedEffectsIfChanged(hud, []);
    return;
  }
  const player = playerStateFrom(snapshot);
  const score = player?.score ?? (snapshot as PlayerSnapshotV1).score;
  const level = "level" in snapshot ? snapshot.level : 1;
  const lines = player?.lines ?? (snapshot as PlayerSnapshotV1).lines;
  const powerCharge = player?.powerCharge ?? (snapshot as PlayerSnapshotV1).powerCharge;
  const upcomingPower = player?.upcomingPower ?? (snapshot as PlayerSnapshotV1).upcomingPower;
  const statuses = player?.statuses ?? (snapshot as PlayerSnapshotV1).statuses;
  const replacementMode = player?.replacementMode ??
    (snapshot as PlayerSnapshotV1).replacementMode;
  const incoming = player?.incomingGarbage ?? (snapshot as PlayerSnapshotV1).incomingGarbage;
  const powerDeckCursor = player?.powerDeckCursor ??
    (snapshot as PlayerSnapshotV1).powerDeckCursor;
  const currentTick = "tick" in snapshot ? snapshot.tick : snapshot.stateTick;
  setTextContentIfChanged(hud.score, String(score));
  setTextContentIfChanged(hud.level, String(level));
  setTextContentIfChanged(hud.lines, String(lines));
  const held = "player" in snapshot ? snapshot.player.hold : snapshot.hold;
  const next = "player" in snapshot ? snapshot.preview : snapshot.nextFive;
  hud.setPiecePreviews(held, next, previewOptions);
  setHudPower(
    hud,
    upcomingPower,
    powerLabel(upcomingPower),
    powerCharge,
    powerDeckCursor,
  );
  const incomingRows = incoming.reduce((sum, packet) => sum + packet.rows, 0);
  const readyGarbage = incoming.some((packet) => packet.readyTick <= currentTick);
  setHudGarbage(hud, incomingRows, readyGarbage);
  setTimedEffectsIfChanged(hud, timedEffectHudItems(statuses, replacementMode));
}

function cueForPower(power: PowerKind): AudioCue {
  return `power-${power}` as AudioCue;
}

export async function bootstrap(): Promise<void> {
  const mount = document.getElementById("app");
  if (mount === null) throw new Error("Split Stack mount point is missing");

  const shell = createAppShell(document, mount);
  const storage = safeStorage(window);
  const powerTips = createPowerTipTracker(storage);
  const networkDiagnostics = new NetworkDiagnostics({ storage });
  const mediaPrefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let preferences = loadPreferences(storage, mediaPrefersReduced);
  shell.setPreferences(preferences);
  const audio = new AudioEngine();
  let latestLeftBoard: BoardRenderModel | null = null;
  let latestRightBoard: BoardRenderModel | null = null;
  let competitiveRemoteCache: RemoteRenderCache | null = null;
  let spectatorLeftCache: RemoteRenderCache | null = null;
  let spectatorRightCache: RemoteRenderCache | null = null;
  const ghostCellsFor = (board: "left" | "right") =>
    (board === "left" ? latestLeftBoard : latestRightBoard)?.cells
      .filter((cell) => cell.role === "ghost")
      .map((cell) => ({ column: cell.column, row: cell.row })) ?? [];
  let presentationTimeline = new PresentationTimeline();
  let presentationRouter = new PresentationRouter(
    presentationTimeline,
    undefined,
    ghostCellsFor,
  );
  let renderer: ThreeRenderer | null = null;
  let latestLayout: RendererLayout | null = null;
  let mode: AppRuntimeMode = "lobby";
  let practice: Simulation | null = null;
  let practicePaused = false;
  let practiceAccumulator = 0;
  let competitive: CompetitiveSession | null = null;
  let competitivePumpTimer: number | null = null;
  let spectator: SpectatorRuntime | null = null;
  let activeMatch: ActiveMatch | null = null;
  let lastFrameMs = performance.now();
  let announcedConfigHash: string | null = null;
  let lastScrambleActive = false;
  let resultShownFor: string | null = null;
  let leaveInProgress = false;
  let lastCountdownSecond = 0;
  let lastCompetitiveInputsEnabled: boolean | null = null;
  let matchMenuOpen = false;
  let powerTipTimeout: number | null = null;
  let lastLocalLevel = 1;
  let warnedUpcomingPower: PowerKind | null = null;
  let currentMusicMatchId: string | null = null;
  let primaryGlitchKey: string | null = null;
  let primaryGlitchStartedAtMs = 0;
  let glitchPreviewLoopActive = false;
  let glitchPreviewArrivalPlayed = false;
  const presentationCadence = new RuntimePresentationCadence();

  const stopGlitchPreview = (): void => {
    audio.stopGlitchPreviewLoop();
    primaryGlitchKey = null;
    primaryGlitchStartedAtMs = 0;
    glitchPreviewLoopActive = false;
    glitchPreviewArrivalPlayed = false;
  };

  const hidePowerTip = (): void => {
    if (powerTipTimeout !== null) {
      window.clearTimeout(powerTipTimeout);
      powerTipTimeout = null;
    }
    hideGameplayPowerTip(shell);
  };

  const maybeShowPowerTip = (power: PowerKind): void => {
    if (!preferences.gameplayTips || !powerTips.shouldShow(power)) return;
    showGameplayPowerTip(
      shell,
      power,
      powerLabel(power),
      powerDescription(power),
    );
    powerTips.markShown(power);
    if (powerTipTimeout !== null) window.clearTimeout(powerTipTimeout);
    powerTipTimeout = window.setTimeout(() => {
      powerTipTimeout = null;
      hideGameplayPowerTip(shell);
    }, 6_000);
  };

  const syncPrimaryGlitchPreview = (
    descriptor: PieceDescriptor | undefined,
    now: number,
    instanceId?: string,
  ): number => {
    const isGlitch = descriptor?.source === "glitch" ||
      descriptor?.previewCosmetics !== undefined;
    if (!isGlitch || descriptor === undefined) {
      stopGlitchPreview();
      return now;
    }

    const staticFallback = preferences.reducedMotion || preferences.reducedFlashes;
    const descriptorKey = instanceId ?? descriptor.eventId ??
      `${descriptor.source}:${descriptor.shape}`;
    const nextKey = `${descriptorKey}:${staticFallback ? "static" : "cycling"}`;
    if (primaryGlitchKey !== nextKey) {
      audio.stopGlitchPreviewLoop();
      primaryGlitchKey = nextKey;
      primaryGlitchStartedAtMs = now;
      glitchPreviewLoopActive = false;
      glitchPreviewArrivalPlayed = false;
    }

    if (!preferences.effectsEnabled) {
      audio.stopGlitchPreviewLoop();
      glitchPreviewLoopActive = false;
    } else if (staticFallback) {
      if (!glitchPreviewArrivalPlayed && audio.unlocked) {
        audio.play("glitch-preview-arrival", { pan: -0.45 });
        glitchPreviewArrivalPlayed = true;
      }
    } else if (!glitchPreviewLoopActive && audio.unlocked) {
      glitchPreviewLoopActive = audio.startGlitchPreviewLoop({
        pan: -0.45,
        elapsedMs: Math.max(0, now - primaryGlitchStartedAtMs),
      });
    }
    return Math.max(0, now - primaryGlitchStartedAtMs);
  };

  const previewOptions = (elapsedMs: number): PiecePreviewOptions => ({
    colorPalette: preferences.colorPalette,
    reducedMotion: preferences.reducedMotion,
    reducedFlashes: preferences.reducedFlashes,
    elapsedMs,
  });

  const resetPresentation = (): void => {
    presentationTimeline = new PresentationTimeline({
      reducedMotion: preferences.reducedMotion,
      reducedFlashes: preferences.reducedFlashes,
      screenShake: preferences.screenShake,
      particleScale: preferences.reducedEffects ? 0 : 1,
    });
    presentationRouter = new PresentationRouter(
      presentationTimeline,
      undefined,
      ghostCellsFor,
    );
  };

  const musicIntensityFor = (
    snapshot: SimulationSnapshot | undefined,
  ): MusicIntensity => {
    if (snapshot === undefined) return "calm";
    const highestOccupiedRow = snapshot.player.grid.findIndex((row) =>
      row.some((cell) => cell !== null),
    );
    const incomingRows = snapshot.player.incomingGarbage.reduce(
      (total, packet) => total + packet.rows,
      0,
    );
    if (
      (highestOccupiedRow >= 0 && highestOccupiedRow <= RULES.board.hiddenRows + 4) ||
      incomingRows >= 6
    ) {
      return "danger";
    }
    if (snapshot.level >= 4 || snapshot.player.lines >= 12 || incomingRows >= 3) {
      return "building";
    }
    return "calm";
  };

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

  const stopCompetitivePump = (): void => {
    if (competitivePumpTimer === null) return;
    window.clearInterval(competitivePumpTimer);
    competitivePumpTimer = null;
  };

  const startCompetitivePump = (): void => {
    stopCompetitivePump();
    competitivePumpTimer = window.setInterval(() => competitive?.pump(), 50);
  };

  const resumeCompetitiveTransport = (): boolean => {
    const session = competitive;
    if (session === null) return false;
    // Webxdc permits only one joined realtime channel at a time. Retire the
    // current listener before acquiring its replacement.
    let recovered = false;
    try {
      session.disconnect();
      const channel = host?.joinRealtimeChannel?.();
      if (channel !== undefined) {
        session.attachTransport(makeRealtimeTransport(channel));
        recovered = true;
      }
    } catch {
      recovered = false;
    } finally {
      if (document.visibilityState !== "hidden") {
        try {
          session.setHidden(false);
        } catch {
          recovered = false;
        }
      }
    }
    return recovered;
  };

  const resumeCompetitiveTransportAfterHostRestore = (): void => {
    const session = competitive;
    if (session === null) return;
    if (document.visibilityState === "hidden") return;
    try {
      // A visibility transition does not prove that Webxdc invalidated the
      // existing subscription. Probe it first and let normal liveness policy
      // replace only a channel that remains silent or rejects the send.
      session.setHidden(false);
      return;
    } catch {
      // Some hosts invalidate realtime handles while their webview is
      // suspended. Only that explicit boundary failure justifies rejoining.
    }
    if (!resumeCompetitiveTransport()) {
      session.noteTransportRecoveryFailure();
    }
  };

  const applyPreferences = (): void => {
    resetPresentation();
    shell.setPreferences(preferences);
    shell.container.dataset.reducedMotion = String(preferences.reducedMotion);
    shell.container.dataset.reducedFlashes = String(preferences.reducedFlashes);
    shell.container.dataset.reducedEffects = String(preferences.reducedEffects);
    shell.container.dataset.palette = preferences.colorPalette;
    shell.container.dataset.screenShake = String(preferences.screenShake);
    shell.touchButtons.hidden =
      mode === "lobby" || mode === "results" || preferences.touchControls !== "buttons";
    audio.setEffectsMuted(!preferences.effectsEnabled);
    audio.setEffectsVolume(preferences.effectsVolume);
    audio.setMusicMuted(!preferences.musicEnabled);
    audio.setMusicVolume(preferences.musicVolume);
    renderer?.setReducedEffects(preferences.reducedEffects);
    renderer?.setStaticMarkedCells(shouldUseStaticMarkedCells(
      preferences.reducedMotion,
      preferences.reducedFlashes,
      preferences.reducedEffects,
    ));
    renderer?.setColorPalette(preferences.colorPalette);
    if (!preferences.gameplayTips) hidePowerTip();
  };

  const positionTargets = (layout: RendererLayout): void => {
    latestLayout = layout;
    applyViewport(shell.left.boardTarget, layout.left);
    applyViewport(shell.left.blackout, layout.left);
    positionHudToViewport(shell.left, layout.left, layout.height);
    positionGameplayTip(shell, layout.left, layout.height);
    if (layout.right !== null) {
      applyViewport(shell.right.boardTarget, layout.right);
      applyViewport(shell.right.blackout, layout.right);
      positionHudToViewport(shell.right, layout.right, layout.height);
    }
  };

  try {
    renderer = new ThreeRenderer(shell.canvas, {
      onLayout: positionTargets,
      onContextLost: () => {
        audio.pauseMusic();
        shell.unsupported.hidden = true;
        if (mode === "practice") {
          practicePaused = true;
          practice?.setPaused(true);
          shell.overlay.hidden = false;
          shell.setOverlayMessage(STRINGS["match.webglPaused"]);
        } else if (mode === "competitive") {
          competitive?.setHidden(true);
        }
      },
      onContextRestored: () => {
        shell.unsupported.hidden = true;
        if (document.visibilityState !== "hidden" && shouldGameplayMusicRun(
          mode,
          practicePaused,
          competitive?.view().phase,
        )) {
          audio.resumeMusic();
        }
        if (mode === "competitive") {
          // setHidden(false) drives the centralized recovery presentation.
          // Do not hide its pause/resynchronization status out from under it.
          resumeCompetitiveTransportAfterHostRestore();
        } else if (mode !== "practice") {
          shell.overlay.hidden = true;
        }
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
    setInputsEnabled(false);
    stopCompetitivePump();
    stopGlitchPreview();
    audio.stopMusic();
    currentMusicMatchId = null;
    resetPresentation();
    competitive?.disconnect();
    competitive = null;
    spectator?.channel.leave?.();
    spectator = null;
    activeMatch = null;
    practice = null;
    latestLeftBoard = null;
    latestRightBoard = null;
    competitiveRemoteCache = null;
    spectatorLeftCache = null;
    spectatorRightCache = null;
    lastScrambleActive = false;
    shell.setScrambled(false);
    announcedConfigHash = null;
    shell.overlay.hidden = true;
    hidePowerTip();
    matchMenuOpen = false;
    setMatchMenu(shell, "competitive", false);
  };

  const showLobby = (): void => {
    leaveRuntime();
    mode = "lobby";
    shell.show("lobby");
    shell.readinessPanel.hidden = true;
    shell.matchMenuButton.hidden = true;
    shell.touchButtons.hidden = true;
    shell.unsupported.hidden = renderer !== null;
    renderHistory();
  };

  const showResult = (result: MatchResultV1, localPlayerId: string | null): void => {
    if (resultShownFor === result.matchId && mode === "results") return;
    stopCompetitivePump();
    stopGlitchPreview();
    audio.stopMusic();
    currentMusicMatchId = null;
    setInputsEnabled(false);
    resultShownFor = result.matchId;
    mode = "results";
    lastScrambleActive = false;
    shell.setScrambled(false);
    const seatA = result.players[0];
    const seatB = result.players[1];
    const localSeat = localPlayerId === seatA?.id ? "seat-a" : localPlayerId === seatB?.id ? "seat-b" : null;
    if (result.reason === "connection-lost") {
      shell.resultsHeading.textContent = STRINGS["results.connectionLost"];
    } else if (result.outcome === "draw") shell.resultsHeading.textContent = STRINGS["results.draw"];
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
    audio.play(
      result.outcome === "draw" || result.reason === "connection-lost"
        ? "draw"
        : localSeat !== null && result.outcome === localSeat
          ? "victory"
          : "defeat",
    );
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
    lastScrambleActive = false;
    shell.setScrambled(false);
    setInputsEnabled(false);
    stopGlitchPreview();
    audio.stopMusic();
    currentMusicMatchId = null;
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
    presentationRouter.consumeSimulationEffects(
      effects,
      pan <= 0 ? "left" : "right",
    );
    for (const effect of effects) {
      if (effect.kind === "piece-locked") audio.play("lock", { pan });
      else if (effect.kind === "t-spin") audio.play("t-spin", { pan });
      else if (effect.kind === "line-clear" && effect.phase === "impact") {
        const cue: AudioCue = effect.rows === 1 ? "single" : effect.rows === 2 ? "double" : effect.rows === 3 ? "triple" : "four-line";
        audio.play(cue, { pan });
      } else if (effect.kind === "garbage-rise") {
        audio.playGarbageRise(effect.rows ?? 1, { pan });
      }
      else if (effect.kind === "hollow-cross" || effect.kind === "glitch-piece") audio.play("special-trigger", { pan });
      else if (effect.kind === "blackout-start") {
        audio.play("power-blackout", { pan });
        audio.duckMusic();
      } else if (effect.kind === "barrier-start") {
        audio.play("power-barrier", { pan });
      }
      else if (effect.kind === "power-activated" && effect.power !== undefined) {
        audio.play(cueForPower(effect.power), {
          pan: panForPowerCue(effect.power, pan),
        });
        if (
          effect.power === "nuke" ||
          effect.power === "collapse" ||
          effect.power === "oversize" ||
          effect.power === "ghost-jam" ||
          effect.power === "scramble"
        ) {
          audio.duckMusic();
        }
      }
      else if (effect.kind === "top-out" && mode === "practice" && practice !== null) showPracticeResult(practice.readSnapshot());
    }
  };

  const processSnapshotAudio = (snapshot: SimulationSnapshot | undefined): void => {
    if (snapshot === undefined) return;
    if (snapshot.level > lastLocalLevel) audio.play("level-up", { pan: -0.45 });
    lastLocalLevel = snapshot.level;
    const warningThreshold = Math.max(1, RULES.power.threshold - 5);
    if (snapshot.player.powerCharge >= warningThreshold) {
      if (warnedUpcomingPower !== snapshot.player.upcomingPower) {
        warnedUpcomingPower = snapshot.player.upcomingPower;
        audio.play("power-warning", { pan: -0.45 });
      }
      maybeShowPowerTip(snapshot.player.upcomingPower);
    } else if (snapshot.player.powerCharge < warningThreshold) {
      warnedUpcomingPower = null;
    }
  };

  const scrambleActive = (): boolean => {
    return mode === "practice"
      ? practice?.hasStatus("scramble") ?? false
      : competitive?.isLocalScrambled() ?? false;
  };

  const dispatchInput = (rawAction: LogicalAction): void => {
    if (mode !== "practice" && mode !== "competitive") return;
    const scrambled = scrambleActive();
    const action = transformScrambledAction(rawAction, scrambled);
    if (preferences.vibration && (action === "hard-drop" || action === "hold")) navigator.vibrate?.(18);
    const result = mode === "practice"
      ? practice?.dispatchWithResult(action)
      : competitive?.dispatchWithResult(action);
    if (result === undefined) return;
    const cue = cueForAcceptedInput(action, result.accepted);
    if (cue !== null) audio.play(cue, { pan: -0.45 });
    processEffects(result.effects);
  };

  const keyboard = new KeyboardInput(window, ({ action }) => dispatchInput(action));
  const gameplayGestures = new GestureInput(shell.container, ({ action }) => dispatchInput(action), {
    getCellSize: () => latestLayout?.left.cellSize ?? 24,
    shouldStart: (event) => isGameplayGestureTarget(event.target),
  });
  const touchButtons = new TouchButtonInput(
    shell.touchButtons,
    ({ action }) => dispatchInput(action),
  );

  const setInputsEnabled = (enabled: boolean): void => {
    keyboard.setEnabled(enabled);
    const gesturesEnabled = enabled && preferences.touchControls === "gestures";
    touchButtons.setEnabled(enabled && preferences.touchControls === "buttons");
    gameplayGestures.setEnabled(gesturesEnabled);
    shell.container.classList.toggle("gestures-active", gesturesEnabled);
    shell.left.pane.setAttribute("aria-disabled", String(!enabled));
  };

  const restoreCompletedMatch = (match: ActiveMatch, result: MatchResultV1): void => {
    stopCompetitivePump();
    competitive?.disconnect();
    competitive = null;
    spectator?.channel.leave?.();
    spectator = null;
    practice = null;
    activeMatch = match;
    lastScrambleActive = false;
    shell.setScrambled(false);
    announcedConfigHash = null;
    shell.readinessPanel.hidden = true;
    shell.matchMenuButton.hidden = true;
    matchMenuOpen = false;
    setMatchMenu(shell, "competitive", false);
    shell.touchButtons.hidden = true;
    shell.overlay.hidden = true;
    setInputsEnabled(false);
    showResult(result, match.role === "spectator" ? null : selfActor.id);
  };

  const startPractice = (): void => {
    leaveRuntime();
    resultShownFor = null;
    mode = "practice";
    practicePaused = false;
    practiceAccumulator = 0;
    lastLocalLevel = 1;
    warnedUpcomingPower = null;
    competitiveRemoteCache = null;
    spectatorLeftCache = null;
    spectatorRightCache = null;
    const practiceSeed = createRuntimeId();
    practice = createSimulation({
      seed: practiceSeed,
      playerId: selfActor.id,
      practice: true,
    });
    audio.startMusic(practiceSeed, 0);
    currentMusicMatchId = `practice:${practiceSeed}`;
    shell.arena.dataset.mode = "practice";
    shell.left.pane.classList.add("is-local");
    shell.left.boardTarget.setAttribute("aria-label", STRINGS["match.localBoard"]);
    shell.readinessPanel.hidden = true;
    shell.matchMenuButton.hidden = false;
    matchMenuOpen = false;
    setMatchMenu(shell, "practice", false);
    shell.overlay.hidden = true;
    shell.show("match");
    applyPreferences();
    setInputsEnabled(true);
  };

  const spectatorRuntime = (match: ActiveMatch): SpectatorRuntime | null => {
    const seatB = match.challenge.seatB;
    if (seatB === null) return null;
    let channel: WebxdcRealtimeChannel | undefined;
    try {
      channel = host?.joinRealtimeChannel?.();
    } catch {
      return null;
    }
    if (channel === undefined) return null;
    const snapshots = new RemoteSnapshotStore();
    snapshots.bind(match.challenge.seatA.playerId, match.seatASessionId);
    snapshots.bind(seatB.playerId, match.seatBSessionId);
    const allowed = new Set([match.challenge.seatA.playerId, seatB.playerId]);
    try {
      channel.setListener((bytes) => {
        const decoded = decodeEnvelope(bytes, {
          expectedMatchId: match.matchId,
          allowedSenderIds: allowed,
        });
        if (decoded.ok && decoded.value.kind === "SNAPSHOT") {
          snapshots.accept(decoded.value);
        }
      });
    } catch {
      try {
        channel.leave?.();
      } catch {
        // The channel is already unusable; keep the spectator detached.
      }
      return null;
    }
    return { channel, snapshots, matchId: match.matchId };
  };

  const applyCompetitivePresentation = (
    view: CompetitiveSessionView,
  ): ReturnType<typeof recoveryPresentationFor> => {
    const presentation = recoveryPresentationFor(view);
    setElementHidden(shell.overlay, presentation.surface === "hidden");
    if (presentation.surface === "readiness") {
      shell.setReadiness(view.localReady, view.peerReady);
    } else if (
      presentation.message !== null &&
      (presentation.surface === "modal" ||
        presentation.surface === "banner" ||
        presentation.surface === "status")
    ) {
      shell.setOverlayMessage(presentation.message, presentation.surface);
    }
    const inputsEnabled = presentation.inputsEnabled && !matchMenuOpen;
    if (lastCompetitiveInputsEnabled !== inputsEnabled) {
      lastCompetitiveInputsEnabled = inputsEnabled;
      setInputsEnabled(inputsEnabled);
    }
    return presentation;
  };

  const startActiveMatch = (match: ActiveMatch): void => {
    stopCompetitivePump();
    stopGlitchPreview();
    audio.stopMusic();
    currentMusicMatchId = null;
    resetPresentation();
    const previousCompetitive = competitive;
    const previousSpectator = spectator;
    competitive = null;
    spectator = null;
    practice = null;
    lastScrambleActive = false;
    shell.setScrambled(false);
    announcedConfigHash = null;
    lastCountdownSecond = 0;
    lastCompetitiveInputsEnabled = null;
    lastLocalLevel = 1;
    warnedUpcomingPower = null;
    competitiveRemoteCache = null;
    spectatorLeftCache = null;
    spectatorRightCache = null;
    // Role and runtime-session changes must obey the same one-channel Webxdc
    // lifecycle as liveness recovery: retire before joining the replacement.
    try {
      previousCompetitive?.disconnect();
    } catch {
      // A failed leave is followed by a contained join attempt below.
    }
    try {
      previousSpectator?.channel.leave?.();
    } catch {
      // A failed leave is followed by a contained join attempt below.
    }
    activeMatch = match;
    resultShownFor = null;
    announcedConfigHash = null;
    shell.arena.dataset.mode = "versus";
    shell.matchMenuButton.hidden = false;
    matchMenuOpen = false;
    setMatchMenu(
      shell,
      match.role === "spectator" ? "spectator" : "competitive",
      false,
    );
    shell.touchButtons.hidden = match.role === "spectator" || preferences.touchControls !== "buttons";
    shell.readinessPanel.hidden = true;
    shell.left.boardTarget.setAttribute("aria-label", match.role === "spectator" ? STRINGS["match.seatABoard"] : STRINGS["match.localBoard"]);
    shell.right.boardTarget.setAttribute("aria-label", match.role === "spectator" ? STRINGS["match.seatBBoard"] : STRINGS["match.opponentBoard"]);
    shell.show("match");
    if (match.role !== "spectator") mode = "competitive";
    const retryActiveMatch = (): void => {
      window.setTimeout(() => {
        if (activeMatch !== match) return;
        activeMatch = null;
        reconcileLobby();
      }, RULES.network.reconnectingMs);
    };

    if (match.role === "spectator") {
      mode = "spectator";
      audio.startMusic(match.challenge.challengeId, match.round - 1);
      currentMusicMatchId = match.matchId;
      spectator = spectatorRuntime(match);
      if (spectator === null) {
        shell.overlay.hidden = false;
        shell.setOverlayMessage(STRINGS["lobby.realtimeUnavailable"]);
        setInputsEnabled(false);
        retryActiveMatch();
        return;
      }
      shell.left.pane.classList.remove("is-local");
      shell.right.pane.classList.remove("is-remote");
      shell.overlay.hidden = false;
      shell.setOverlayMessage(match.duplicateRuntime
        ? STRINGS["lobby.duplicateSession"]
        : STRINGS["lobby.spectatorNotice"]);
      setInputsEnabled(false);
      return;
    }

    const seatB = match.challenge.seatB;
    if (seatB === null) {
      shell.overlay.hidden = false;
      shell.setOverlayMessage(STRINGS["lobby.realtimeUnavailable"]);
      return;
    }
    let channel: WebxdcRealtimeChannel | undefined;
    try {
      channel = host?.joinRealtimeChannel?.();
    } catch {
      channel = undefined;
    }
    if (channel === undefined) {
      shell.overlay.hidden = false;
      shell.setOverlayMessage(STRINGS["lobby.realtimeUnavailable"]);
      retryActiveMatch();
      return;
    }
    shell.left.pane.classList.add("is-local");
    shell.right.pane.classList.add("is-remote");
    const local = match.role === "a" ? match.challenge.seatA : seatB;
    const peer = match.role === "a" ? seatB : match.challenge.seatA;
    try {
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
        snapshotIntervalTicks: SNAPSHOT_PROFILE.intervalTicks,
        clock: { now: () => performance.now() },
        transport: makeRealtimeTransport(channel),
        diagnostics: networkDiagnostics,
        onPhaseChange: (phase) => {
          const view = competitive?.view();
          if (phase === "countdown" || phase === "playing") {
            if (currentMusicMatchId !== match.matchId) {
              audio.startMusic(match.challenge.challengeId, match.round - 1);
              currentMusicMatchId = match.matchId;
            } else {
              audio.resumeMusic();
            }
          } else if (phase === "network-pause") {
            audio.pauseMusic();
          }
          if (view !== undefined) applyCompetitivePresentation(view);
        },
        onRemoteBlackout: () => {
          audio.play("power-blackout", { pan: 0.45 });
        },
        onIncomingGarbage: () => {
          audio.play("garbage-warning", { pan: 0.45 });
        },
        onIncomingAttack: (kind, eventId, value) => {
          presentationRouter.consumeIncomingAttack(kind, eventId, value);
          const cue = cueForIncomingAttack(kind);
          if (cue !== null) {
            audio.play(cue, { pan: -0.45 });
            audio.duckMusic();
          }
        },
        onTransportRecoveryNeeded: () => {
          return resumeCompetitiveTransport();
        },
        onSimulationEffects: (effects) => {
          processEffects(effects, -0.45);
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
          shell.setOverlayMessage(STRINGS["match.desynchronization"]);
        },
      });
      competitive.start();
    } catch {
      try {
        if (competitive === null) channel.leave?.();
        else competitive.disconnect();
      } catch {
        // The failed runtime is already unusable; keep it detached.
      }
      competitive = null;
      shell.overlay.hidden = false;
      shell.setOverlayMessage(STRINGS["lobby.realtimeUnavailable"]);
      retryActiveMatch();
      return;
    }
    startCompetitivePump();
    setInputsEnabled(false);
    shell.overlay.hidden = false;
    shell.setReadiness(false, false);
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
      if (mode === "results") {
        shell.rematchButton.hidden = true;
        return;
      }
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
    const completed = history.findByMatchId(next.matchId);
    if (completed !== undefined) {
      restoreCompletedMatch(next, completed.result);
      return;
    }
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
      const outcome = item.result.reason === "connection-lost"
        ? STRINGS["results.connectionLostHistory"]
        : item.conflicted
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
    const completed = history.findByMatchId(payload.matchId);
    if (activeMatch?.matchId === payload.matchId && completed !== undefined) {
      restoreCompletedMatch(activeMatch, completed.result);
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
      const challenge = materializeChallenge(lobbyEvents, payload.challengeId);
      if (!announcementMatchesChallenge(payload, challenge)) return;
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
  shell.controlsHelpButton.addEventListener("click", () => showHelp(shell, "controls"));
  shell.helpBack.addEventListener("click", () => shell.show("lobby"));
  shell.settingsButton.addEventListener("click", () => shell.show("settings"));
  shell.diagnosticsCopyButton.addEventListener("click", () => {
    const copy = async (): Promise<boolean> => {
      const text = networkDiagnostics.copyText();
      try {
        if (navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // The synchronous selection fallback below works in older WebViews.
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      textarea.remove();
      return copied;
    };
    void copy().then((copied) => {
      shell.diagnosticsStatus.textContent = copied
        ? STRINGS["settings.diagnosticsCopied"]
        : STRINGS["settings.diagnosticsCopyFailed"];
    });
  });
  shell.diagnosticsClearButton.addEventListener("click", () => {
    networkDiagnostics.clear();
    shell.diagnosticsStatus.textContent = STRINGS["settings.diagnosticsCleared"];
  });
  shell.settingsBack.addEventListener("click", () => {
    preferences = {
      effectsEnabled: shell.settingsInputs.effectsEnabled.checked,
      effectsVolume: Number(shell.settingsInputs.effectsVolume.value),
      musicEnabled: shell.settingsInputs.musicEnabled.checked,
      musicVolume: Number(shell.settingsInputs.musicVolume.value),
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
    session.setReady(true);
    const view = session.view();
    shell.setReadiness(view.localReady, view.peerReady);
  });

  shell.cancelReadyButton.addEventListener("click", () => {
    const session = competitive;
    if (session === null) return;
    session.setReady(false);
    const view = session.view();
    shell.setReadiness(view.localReady, view.peerReady);
  });

  const setPracticePaused = (paused: boolean): void => {
    if (practice === null) return;
    practicePaused = paused;
    practice.setPaused(paused);
    if (paused) audio.pauseMusic();
    else audio.resumeMusic();
    setInputsEnabled(!paused);
  };

  const openMatchMenu = (): void => {
    if (matchMenuOpen || (mode !== "practice" && mode !== "competitive" && mode !== "spectator")) {
      return;
    }
    matchMenuOpen = true;
    hidePowerTip();
    if (mode === "practice") {
      setPracticePaused(true);
      shell.overlay.hidden = true;
    } else if (mode === "competitive") {
      lastCompetitiveInputsEnabled = false;
      setInputsEnabled(false);
    }
    setMatchMenu(shell, mode, true);
    shell.matchMenuCloseButton.focus();
  };

  const closeMatchMenu = (): void => {
    if (!matchMenuOpen) return;
    const closingMode = mode;
    matchMenuOpen = false;
    setMatchMenu(
      shell,
      closingMode === "practice" || closingMode === "spectator"
        ? closingMode
        : "competitive",
      false,
    );
    if (closingMode === "practice") {
      setPracticePaused(false);
    } else if (closingMode === "competitive") {
      lastCompetitiveInputsEnabled = null;
      const view = competitive?.view();
      if (view !== undefined) applyCompetitivePresentation(view);
    }
    shell.matchMenuButton.focus();
  };

  shell.matchMenuButton.addEventListener("click", () => {
    if (matchMenuOpen) closeMatchMenu();
    else openMatchMenu();
  });
  shell.matchMenuCloseButton.addEventListener("click", closeMatchMenu);

  const settleExplicitForfeit = async (session: CompetitiveSession): Promise<void> => {
    try {
      session.forfeit();
      const deadline = performance.now() + RULES.network.missingPeerMs;
      while (session.forfeitDeliveryStatus() === "pending") {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await wait(window, Math.min(RULES.network.retryMs, remaining));
        session.pump();
      }
    } finally {
      if (session.forfeitDeliveryStatus() === "pending") {
        session.queueForfeitFallback();
      }
    }
  };

  const leaveChallenge = async (): Promise<void> => {
    if (leaveInProgress) return;
    leaveInProgress = true;
    shell.leaveMatchButton.disabled = true;
    shell.resultsLeaveButton.disabled = true;
    shell.rematchButton.disabled = true;
    const match = activeMatch;
    const session = mode === "competitive" ? competitive : null;
    if (session !== null) {
      try {
        await settleExplicitForfeit(session);
      } catch {
        // The canonical durable fallback was queued in settleExplicitForfeit.
      }
    }
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
    shell.leaveMatchButton.disabled = false;
    shell.resultsLeaveButton.disabled = false;
    shell.rematchButton.disabled = false;
    leaveInProgress = false;
  };
  shell.leaveMatchButton.addEventListener("click", () => void leaveChallenge());
  shell.resultsLeaveButton.addEventListener("click", () => void leaveChallenge());
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

  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    if (hidden) {
      audio.pauseMusic();
      renderer?.noteSuspension();
    }
    if (mode === "practice" && practice !== null) {
      if (hidden) {
        setPracticePaused(true);
        matchMenuOpen = true;
        setMatchMenu(shell, "practice", true);
      }
    } else if (mode === "competitive") {
      if (hidden) competitive?.setHidden(true);
      else {
        resumeCompetitiveTransportAfterHostRestore();
      }
    }
    if (!hidden && shouldGameplayMusicRun(
      mode,
      practicePaused,
      competitive?.view().phase,
    )) {
      audio.resumeMusic();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (
      (mode === "practice" || mode === "competitive" || mode === "spectator") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      ((mode === "practice" && event.key.toLowerCase() === "p") ||
        event.key === "Escape")
    ) {
      event.preventDefault();
      if (matchMenuOpen) closeMatchMenu();
      else openMatchMenu();
    }
  });
  window.addEventListener("pointerdown", () => void audio.unlock());
  window.addEventListener("keydown", () => void audio.unlock());

  const renderFrame = (now: number): void => {
    const elapsed = Math.min(250, Math.max(0, now - lastFrameMs));
    lastFrameMs = now;
    if (!presentationCadence.shouldPresent(mode, now)) {
      window.requestAnimationFrame(renderFrame);
      return;
    }
    let leftBoard = null;
    let rightBoard = null;
    let renderMode: "practice" | "versus" = "versus";
    let musicIntensity: MusicIntensity = "calm";

    if (mode === "practice" && practice !== null) {
      if (!practicePaused) {
        practiceAccumulator += elapsed;
        while (practiceAccumulator >= FIXED_TICK_MS) {
          processEffects(practice.tick(1));
          practiceAccumulator -= FIXED_TICK_MS;
        }
      }
      const snapshot = practice.readSnapshot();
      musicIntensity = musicIntensityFor(snapshot);
      processSnapshotAudio(snapshot);
      leftBoard = boardModelFromSimulation(snapshot, true, false);
      const glitchElapsedMs = syncPrimaryGlitchPreview(
        practicePaused ? undefined : snapshot.preview[0],
        now,
      );
      updateHud(
        shell.left,
        selfActor.displayName,
        snapshot,
        previewOptions(glitchElapsedMs),
      );
      setElementHidden(shell.left.blackout, true);
      renderMode = "practice";
    } else if (mode === "competitive" && competitive !== null && activeMatch !== null) {
      const previousRemote = competitiveRemoteCache?.matchId === activeMatch.matchId
        ? competitiveRemoteCache
        : null;
      const view = competitive.view({
        ...(previousRemote === null
          ? {}
          : { afterRemoteSnapshotSeq: previousRemote.snapshot.snapshotSeq }),
      });
      if (view.remote !== undefined) {
        const concealed = view.remote.statuses.some((status) => status.kind === "blackout");
        competitiveRemoteCache = {
          matchId: activeMatch.matchId,
          snapshot: view.remote,
          board: boardModelFromRemoteSnapshot(view.remote, false, concealed),
          concealed,
        };
      }
      const remote = competitiveRemoteCache?.matchId === activeMatch.matchId
        ? competitiveRemoteCache
        : null;
      musicIntensity = musicIntensityFor(view.local);
      processSnapshotAudio(view.local);
      const competitivePresentation = applyCompetitivePresentation(view);
      if (competitivePresentation.countdownCueSecond !== null) {
        if (competitivePresentation.countdownCueSecond !== lastCountdownSecond) {
          lastCountdownSecond = competitivePresentation.countdownCueSecond;
          audio.play("countdown");
        }
      } else {
        lastCountdownSecond = 0;
      }
      const seatB = activeMatch.challenge.seatB;
      const localName = activeMatch.role === "a" ? activeMatch.challenge.seatA.displayName : seatB?.displayName ?? selfActor.displayName;
      const peerName = activeMatch.role === "a"
        ? seatB?.displayName ?? STRINGS["common.playerFallback"]
        : activeMatch.challenge.seatA.displayName;
      if (view.local !== undefined) leftBoard = boardModelFromSimulation(view.local, true, false);
      const remoteConcealed = remote?.concealed ?? false;
      rightBoard = remote?.board ?? null;
      const glitchElapsedMs = syncPrimaryGlitchPreview(
        view.phase === "playing" ? view.local?.preview[0] : undefined,
        now,
        view.local?.player.forcedQueue[0]?.eventId,
      );
      updateHud(shell.left, localName, view.local, previewOptions(glitchElapsedMs));
      updateHud(shell.right, peerName, remote?.snapshot, previewOptions(now));
      setElementHidden(shell.left.blackout, true);
      setElementHidden(shell.right.blackout, !remoteConcealed);
      const scrambled = view.local?.player.statuses.some((status) => status.kind === "scramble") ?? false;
      if (scrambled !== lastScrambleActive) {
        keyboard.releaseHorizontal();
        shell.setScrambled(scrambled);
      }
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
      stopGlitchPreview();
      const seatB = activeMatch.challenge.seatB;
      const previousLeft = spectatorLeftCache?.matchId === activeMatch.matchId
        ? spectatorLeftCache
        : null;
      const nextLeft = spectator.snapshots.latestAfter(
        activeMatch.challenge.seatA.playerId,
        previousLeft?.snapshot.snapshotSeq,
      );
      if (nextLeft !== undefined) {
        const concealed = nextLeft.statuses.some((status) => status.kind === "blackout");
        spectatorLeftCache = {
          matchId: activeMatch.matchId,
          snapshot: nextLeft,
          board: boardModelFromRemoteSnapshot(nextLeft, false, concealed),
          concealed,
        };
      }
      const previousRight = spectatorRightCache?.matchId === activeMatch.matchId
        ? spectatorRightCache
        : null;
      const nextRight = seatB === null
        ? undefined
        : spectator.snapshots.latestAfter(
            seatB.playerId,
            previousRight?.snapshot.snapshotSeq,
          );
      if (nextRight !== undefined) {
        const concealed = nextRight.statuses.some((status) => status.kind === "blackout");
        spectatorRightCache = {
          matchId: activeMatch.matchId,
          snapshot: nextRight,
          board: boardModelFromRemoteSnapshot(nextRight, false, concealed),
          concealed,
        };
      }
      const left = spectatorLeftCache?.matchId === activeMatch.matchId
        ? spectatorLeftCache
        : null;
      const right = spectatorRightCache?.matchId === activeMatch.matchId
        ? spectatorRightCache
        : null;
      const leftConcealed = left?.concealed ?? false;
      const rightConcealed = right?.concealed ?? false;
      leftBoard = left?.board ?? null;
      rightBoard = right?.board ?? null;
      updateHud(
        shell.left,
        activeMatch.challenge.seatA.displayName,
        left?.snapshot,
        previewOptions(now),
      );
      updateHud(
        shell.right,
        seatB?.displayName ?? STRINGS["common.playerFallback"],
        right?.snapshot,
        previewOptions(now),
      );
      setElementHidden(shell.left.blackout, !leftConcealed);
      setElementHidden(shell.right.blackout, !rightConcealed);
      if (
        !activeMatch.duplicateRuntime &&
        (left !== undefined || right !== undefined)
      ) {
        setElementHidden(shell.overlay, true);
      }
      const spectatorIncoming = [
        ...(left?.snapshot.incomingGarbage ?? []),
        ...(right?.snapshot.incomingGarbage ?? []),
      ]
        .reduce((total, packet) => total + packet.rows, 0);
      const spectatorLevel = Math.max(
        left?.snapshot.level ?? 1,
        right?.snapshot.level ?? 1,
      );
      musicIntensity = spectatorIncoming >= 6
        ? "danger"
        : spectatorIncoming >= 3 || spectatorLevel >= 4
          ? "building"
          : "calm";
    }

    audio.updateMusic(musicIntensity);
    latestLeftBoard = leftBoard;
    latestRightBoard = rightBoard;
    renderer?.render(
      {
        mode: renderMode,
        left: leftBoard,
        right: rightBoard,
        presentation: presentationTimeline.frameAt(now),
      },
      now,
      mode === "competitive" || mode === "spectator"
        ? NETWORKED_PRESENTATION_FPS
        : 60,
    );
    window.requestAnimationFrame(renderFrame);
  };

  shell.createButton.disabled = !realtimeAvailable;
  shell.joinButton.disabled = true;
  shell.lobbyStatus.textContent = !realtimeAvailable
    ? STRINGS["lobby.realtimeUnavailable"]
    : renderer === null
      ? STRINGS["match.unsupportedWebgl"]
      : "";
  shell.matchMenuButton.hidden = true;
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
