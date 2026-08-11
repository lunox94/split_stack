import { AudioEngine } from "../audio/engine";
import { RULES } from "../config/rules";
import { RULES_HASH } from "../config/rules-hash";
import {
  createSimulation,
  type Simulation,
  type SimulationEffect,
  type SimulationSnapshot,
} from "../domain/simulation";
import type {
  LogicalAction,
  MatchResult,
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
  type CompetitiveSessionView,
  type CompetitiveTerminalState,
} from "../match/competitive-session";
import { decodeEnvelope } from "../network/codec";
import { NetworkDiagnostics } from "../network/diagnostics";
import { RemoteSnapshotStore, type PlayerSnapshot } from "../network/snapshots";
import { parseSnapshotProfile } from "../network/snapshot-profile";
import { RealtimeHub } from "../network/realtime-hub";
import {
  AdvisoryPresenceTracker,
  PRESENCE_SCHEMA,
  encodePresenceFrame,
} from "../network/presence";
import { createPowerTipTracker } from "../persistence/power-tips";
import {
  loadPreferences,
  savePreferences,
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
  positionMatchMenuButton,
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
import {
  presentHudBarrierResolution,
  resetHudBarrierCapacityPresentation,
  setHudBarrierCapacity,
} from "../ui/barrier-capacity";
import type { PiecePreviewOptions } from "../ui/piece-preview";
import { boardModelFromRemoteSnapshot, boardModelFromSimulation } from "./view-model";
import { GraphicsAutoController, resolveGraphicsPlan } from "./graphics-policy";
import {
  audioPlanForLineClear,
  calloutForPower,
  cueForAcceptedInput,
  cueForIncomingAttack,
  cueForPhysicalEffect,
  panForPowerCue,
} from "./audio-policy";
import { hapticDurationForSimulationEffect } from "./haptic-policy";
import { PresentationRouter } from "./presentation-router";
import {
  createRuntimeId,
  formatDuration,
  shouldGameplayMusicRun,
  type AppRuntimeMode,
} from "./runtime-helpers";
import {
  type CompetitionActor,
  type CompetitionResultView,
  type StartingPairingView,
} from "./competition-ledger";
import { presentCompetition } from "./competition-presenter";
import { isRecognizedAppRouteHash, parseAppRoute } from "./routes";
import { liveControllerRecoveryStatus } from "./live-session-recovery";
import { STRINGS, formatString, type StringKey } from "./strings";
import {
  PresentationTimeline,
  type PresentationBoard,
} from "../render/presentation-timeline";
import { RuntimePresentationCadence } from "./presentation-cadence";
import { recoveryPresentationFor } from "./recovery-presentation";
import {
  createCompetitionEventLifecycle,
  type CompetitionIntentReference,
  type CompetitionLiveMatchView,
  type CompetitionPendingRematchView,
} from "./competition-event-lifecycle";

const PRACTICE_HIGH_SCORE_KEY = `split-stack/practice-high-score/v2:${RULES_HASH}`;
const FIXED_TICK_MS = 1_000 / RULES.timing.ticksPerSecond;
const PRESENCE_HEARTBEAT_MS = 5_000;
const DURABLE_RETRY_MIN_MS = 1_000;
const DURABLE_RETRY_MAX_MS = 10_000;
const LIVE_RECOVERY_TICK_MS = 1_000;
const RECONNECT_DOT_STEP_MS = 600;
const RECOVERY_CONFIRMATION_DELAY_MS = 10_000;
const STALE_ROUTE_NOTICE_MS = 5_000;
const SNAPSHOT_PROFILE = parseSnapshotProfile(
  import.meta.env.VITE_SPLIT_STACK_SNAPSHOT_HZ,
);

interface ActiveMatchParticipant {
  readonly playerId: string;
  readonly displayName: string;
}

interface ActiveMatchParticipants {
  readonly seatA: ActiveMatchParticipant;
  readonly seatB: ActiveMatchParticipant | null;
}

interface ActiveMatch {
  pairingId: string;
  seriesId: string;
  source: "challenge" | "rematch";
  participants: ActiveMatchParticipants;
  round: number;
  matchId: string;
  role: "a" | "b" | "spectator";
  seatASessionId: string;
  seatBSessionId: string;
  duplicateRuntime: boolean;
  /** An explicit read-only view of the participant's own fenced live match. */
  recoveryWatch?: boolean;
  committedSeed?: string;
  committedConfigHash?: string;
}

interface SpectatorRuntime {
  channel: WebxdcRealtimeChannel;
  snapshots: RemoteSnapshotStore;
  matchId: string;
  lastSnapshotAtMs: number | null;
}

interface RemoteRenderCache {
  matchId: string;
  snapshot: PlayerSnapshot;
  board: BoardRenderModel;
  concealed: boolean;
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
  const effects: TimedEffectHudItem[] = statuses
    .filter((status) => status.kind !== "barrier" || status.capacity > 0)
    .map((status) => {
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
  effects.sort((left, right) => {
    const leftAge = left.totalTicks - left.remainingTicks;
    const rightAge = right.totalTicks - right.remainingTicks;
    return rightAge - leftAge;
  });
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

function playerStateFrom(snapshot: SimulationSnapshot | PlayerSnapshot): PlayerGameState | null {
  return "player" in snapshot ? snapshot.player : null;
}

const HUD_STATUS_SIGNATURES = new WeakMap<HTMLElement, string>();

function setTextContentIfChanged(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setHudScrambled(hud: HudElements, active: boolean): void {
  const value = String(active);
  if (hud.pane.dataset.scrambled !== value) hud.pane.dataset.scrambled = value;
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
  snapshot: SimulationSnapshot | PlayerSnapshot | undefined,
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
    setHudBarrierCapacity(hud, 0);
    setHudScrambled(hud, false);
    setTimedEffectsIfChanged(hud, []);
    return;
  }
  const player = playerStateFrom(snapshot);
  const score = player?.score ?? (snapshot as PlayerSnapshot).score;
  const level = "level" in snapshot ? snapshot.level : 1;
  const lines = player?.lines ?? (snapshot as PlayerSnapshot).lines;
  const powerCharge = player?.powerCharge ?? (snapshot as PlayerSnapshot).powerCharge;
  const upcomingPower = player?.upcomingPower ?? (snapshot as PlayerSnapshot).upcomingPower;
  const statuses = player?.statuses ?? (snapshot as PlayerSnapshot).statuses;
  setHudScrambled(
    hud,
    statuses.some((status) => status.kind === "scramble"),
  );
  const replacementMode = player?.replacementMode ??
    (snapshot as PlayerSnapshot).replacementMode;
  const incoming = player?.incomingGarbage ?? (snapshot as PlayerSnapshot).incomingGarbage;
  const powerDeckCursor = player?.powerDeckCursor ??
    (snapshot as PlayerSnapshot).powerDeckCursor;
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
  const barrier = statuses.find(
    (status): status is Extract<StatusState, { kind: "barrier" }> =>
      status.kind === "barrier",
  );
  setHudBarrierCapacity(hud, barrier?.capacity ?? 0);
  setTimedEffectsIfChanged(hud, timedEffectHudItems(statuses, replacementMode));
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
  const autoGraphics = new GraphicsAutoController();
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
  let practiceRunId: string | null = null;
  let practicePaused = false;
  const practicePauseReasons = new Set<"menu" | "visibility" | "webgl" | "pairing">();
  let practiceAccumulator = 0;
  let competitive: CompetitiveSession | null = null;
  let competitivePumpTimer: number | null = null;
  let spectator: SpectatorRuntime | null = null;
  let activeMatch: ActiveMatch | null = null;
  let interruptedPairing: StartingPairingView | CompetitionLiveMatchView | null = null;
  const reportedRejectedJoinReferences = new Set<CompetitionIntentReference>();
  let displayedResult: CompetitionResultView | null = null;
  let pendingCommittedStart: {
    match: ActiveMatch;
    configHash: string;
    seed: string;
  } | null = null;
  let lastFrameMs = performance.now();
  let announcedConfigHash: string | null = null;
  let lastScrambleActive = false;
  let resultShownFor: string | null = null;
  const neutralFinishFallbackTimers = new Map<string, number>();
  interface PassiveLiveRecovery {
    readonly matchId: string;
    readonly committedConfigHash: string;
    readonly seatAPlayerId: string;
    readonly seatBPlayerId: string;
    readonly seatASessionId: string;
    readonly seatBSessionId: string;
    readonly allowedSenderIds: ReadonlySet<string>;
    observedAtMs: number;
    seatASeenAtMs: number | null;
    seatBSeenAtMs: number | null;
    tickTimer: number | null;
    finishQueued: boolean;
    hubRetryAttempts: number;
  }
  let passiveLiveRecovery: PassiveLiveRecovery | null = null;
  const recoveryResolutionStartedAtMs = new Map<string, number>();
  let confirmingPairing: {
    pairingId: string;
    startedAtMs: number;
    actionTimer: number | null;
  } | null = null;
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

  const graphicsPlan = () => resolveGraphicsPlan({
    setting: preferences.graphics,
    autoTier: autoGraphics.tier,
    reducedMotion: preferences.reducedMotion,
    reducedFlashes: preferences.reducedFlashes,
    screenShake: preferences.screenShake,
  });

  const resetPresentation = (): void => {
    resetHudBarrierCapacityPresentation(shell.left);
    resetHudBarrierCapacityPresentation(shell.right);
    presentationTimeline = new PresentationTimeline({
      reducedMotion: graphicsPlan().reducedMotion,
      reducedFlashes: graphicsPlan().reducedFlashes,
      screenShake: graphicsPlan().allowScreenShake,
      particleScale: graphicsPlan().particleScale,
    });
    presentationRouter = new PresentationRouter(
      presentationTimeline,
      undefined,
      ghostCellsFor,
    );
  };

  const host = window.webxdc;
  const selfActor: CompetitionActor = {
    id: host?.selfAddr ?? "local-practice",
    displayName: host?.selfName?.slice(0, 128) || STRINGS["common.playerFallback"],
  };
  const realtimeAvailable = typeof host?.joinRealtimeChannel === "function";
  let realtimeHub: RealtimeHub | null = null;
  let connectHubServices: (hub: RealtimeHub) => void = () => undefined;
  const ensureRealtimeHub = (): RealtimeHub | null => {
    if (realtimeHub !== null) return realtimeHub;
    try {
      const channel = host?.joinRealtimeChannel?.();
      if (channel === undefined) return null;
      realtimeHub = new RealtimeHub(channel);
      connectHubServices(realtimeHub);
      return realtimeHub;
    } catch {
      return null;
    }
  };
  const runtimeId = createRuntimeId();
  const competitionLifecycle = await createCompetitionEventLifecycle({
    actor: selfActor,
    runtimeSessionId: runtimeId,
    currentRulesHash: RULES_HASH,
    host: host ?? null,
    storage,
    scheduler: {
      now: () => performance.now(),
      setTimeout: (task, delayMs) => window.setTimeout(task, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
    },
    createId: createRuntimeId,
  });
  const competitionView = () => competitionLifecycle.current().competition;
  let pendingPairingExitReference: CompetitionIntentReference | null = null;
  const presence = new AdvisoryPresenceTracker({ clock: { now: () => performance.now() } });
  let presenceUnsubscribe: (() => void) | null = null;
  let controllerTrafficUnsubscribe: (() => void) | null = null;
  let receivePassiveControllerTraffic: (data: Uint8Array) => void = () => undefined;
  let renderCompetitionState: () => void = () => undefined;

  connectHubServices = (hub): void => {
    presenceUnsubscribe?.();
    controllerTrafficUnsubscribe?.();
    presenceUnsubscribe = hub.subscribe((data) => {
      const decoded = presence.receive(data);
      if (decoded.ok) renderCompetitionState();
    });
    controllerTrafficUnsubscribe = hub.subscribe((data) => {
      receivePassiveControllerTraffic(data);
    });
  };
  if (realtimeAvailable) ensureRealtimeHub();

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
      session.disconnect("replacement");
      realtimeHub?.close();
      realtimeHub = null;
      const hub = ensureRealtimeHub();
      if (hub !== null) {
        session.attachTransport(hub.transport());
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

  const applyGraphicsPlan = (): void => {
    const plan = graphicsPlan();
    shell.container.dataset.graphicsTier = plan.tier;
    presentationTimeline.configure({
      reducedMotion: plan.reducedMotion,
      reducedFlashes: plan.reducedFlashes,
      screenShake: plan.allowScreenShake,
      particleScale: plan.particleScale,
    });
    renderer?.setQuality(plan.renderQuality);
    renderer?.setStaticMarkedCells(plan.staticLegibilityCues);
    shell.setGraphicsStatus(preferences.graphics, plan.tier);
  };

  const applyPreferences = (): void => {
    shell.setPreferences(preferences);
    shell.container.dataset.reducedMotion = String(preferences.reducedMotion);
    shell.container.dataset.reducedFlashes = String(preferences.reducedFlashes);
    applyGraphicsPlan();
    shell.container.dataset.palette = preferences.colorPalette;
    shell.container.dataset.screenShake = String(preferences.screenShake);
    const touchButtonsVisible =
      mode !== "lobby" && mode !== "results" && preferences.touchControls === "buttons";
    shell.touchButtons.hidden = !touchButtonsVisible;
    shell.container.dataset.touchButtonsVisible = String(touchButtonsVisible);
    audio.setEffectsMuted(!preferences.effectsEnabled);
    audio.setEffectsVolume(preferences.effectsVolume);
    audio.setMusicMuted(!preferences.musicEnabled);
    audio.setMusicVolume(preferences.musicVolume);
    audio.setCalloutsMuted(!preferences.calloutsEnabled);
    audio.setCalloutsVolume(preferences.calloutsVolume);
    renderer?.setColorPalette(preferences.colorPalette);
    if (!preferences.gameplayTips) hidePowerTip();
  };

  const positionTargets = (layout: RendererLayout): void => {
    latestLayout = layout;
    applyViewport(shell.left.boardTarget, layout.left);
    applyViewport(shell.left.blackout, layout.left);
    positionHudToViewport(shell.left, layout.left);
    positionGameplayTip(shell, layout);
    positionMatchMenuButton(shell, layout);
    if (layout.right !== null) {
      applyViewport(shell.right.boardTarget, layout.right);
      applyViewport(shell.right.blackout, layout.right);
      positionHudToViewport(shell.right, layout.right);
    }
  };

  try {
    renderer = new ThreeRenderer(shell.canvas, {
      onLayout: positionTargets,
      onContextLost: () => {
        audio.pauseMusic();
        shell.unsupported.hidden = true;
        if (mode === "practice") {
          practicePauseReasons.add("webgl");
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
        } else if (mode === "practice") {
          practicePauseReasons.delete("webgl");
          setPracticePaused(practicePauseReasons.size > 0);
        } else {
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

  type PairingView = StartingPairingView | CompetitionLiveMatchView;

  const activeMatchFrom = (
    pairing: PairingView,
    forceSpectator = false,
  ): ActiveMatch | null => {
    const committedStart = "start" in pairing
      ? (pairing as CompetitionLiveMatchView).start
      : undefined;
    const seatASessionId = committedStart?.seatASessionId ??
      pairing.runtimeSessionByPlayer[pairing.seatA.id];
    const seatBSessionId = committedStart?.seatBSessionId ??
      pairing.runtimeSessionByPlayer[pairing.seatB.id];
    if (seatASessionId === undefined || seatBSessionId === undefined) return null;
    const assignedRole = pairing.seatA.id === selfActor.id
      ? "a"
      : pairing.seatB.id === selfActor.id
        ? "b"
        : "spectator";
    const duplicateRuntime = assignedRole === "a"
      ? seatASessionId !== runtimeId
      : assignedRole === "b"
        ? seatBSessionId !== runtimeId
        : false;
    const readOnlyRuntime = duplicateRuntime ||
      (forceSpectator && assignedRole !== "spectator");
    const role = forceSpectator || duplicateRuntime ? "spectator" : assignedRole;
    const participants: ActiveMatchParticipants = {
      seatA: {
        playerId: pairing.seatA.id,
        displayName: pairing.seatA.displayName,
      },
      seatB: {
        playerId: pairing.seatB.id,
        displayName: pairing.seatB.displayName,
      },
    };
    return {
      pairingId: pairing.pairingId,
      seriesId: pairing.seriesId,
      source: pairing.source,
      participants,
      round: pairing.round,
      matchId: pairing.matchId,
      role,
      seatASessionId,
      seatBSessionId,
      duplicateRuntime: readOnlyRuntime,
      ...(committedStart === undefined
        ? {}
        : {
            committedSeed: committedStart.seed,
            committedConfigHash: committedStart.configHash,
          }),
    };
  };

  const publishCommittedStartWhenReady = (): void => {
    const pending = pendingCommittedStart;
    if (pending === null || announcedConfigHash !== null) return;
    const seatB = pending.match.participants.seatB;
    if (seatB === null) return;
    announcedConfigHash = pending.configHash;
    try {
      competitionLifecycle.express({
        kind: "start-match",
        pairingId: pending.match.pairingId,
        seed: pending.seed,
      });
      pendingCommittedStart = null;
    } catch {
      announcedConfigHash = null;
    }
  };

  const leaveRuntime = (): void => {
    setInputsEnabled(false);
    stopCompetitivePump();
    stopGlitchPreview();
    audio.stopMusic();
    currentMusicMatchId = null;
    resetPresentation();
    competitive?.disconnect("session-teardown");
    competitive = null;
    spectator?.channel.leave?.();
    spectator = null;
    activeMatch = null;
    interruptedPairing = null;
    practicePauseReasons.delete("pairing");
    practice = null;
    practiceRunId = null;
    latestLeftBoard = null;
    latestRightBoard = null;
    competitiveRemoteCache = null;
    spectatorLeftCache = null;
    spectatorRightCache = null;
    lastScrambleActive = false;
    shell.setScrambled(false);
    announcedConfigHash = null;
    pendingCommittedStart = null;
    shell.overlay.hidden = true;
    shell.setReadOnlyWatchStatus(null);
    hidePowerTip();
    matchMenuOpen = false;
    setMatchMenu(shell, "competitive", false);
    shell.setPairingInterruption(null);
  };

  const showHome = (): void => {
    leaveRuntime();
    mode = "lobby";
    if (shell.lobbyStatus.textContent === STRINGS["lobby.staleLink"]) {
      shell.lobbyStatus.textContent = "";
    }
    shell.show("home");
    shell.readinessPanel.hidden = true;
    shell.matchMenuButton.hidden = true;
    shell.touchButtons.hidden = true;
    shell.unsupported.hidden = renderer !== null;
    shell.setPairingInterruption(null);
    renderCompetitionState();
  };

  const showLobby = (): void => {
    leaveRuntime();
    mode = "lobby";
    shell.show("lobby");
    shell.readinessPanel.hidden = true;
    shell.matchMenuButton.hidden = true;
    shell.touchButtons.hidden = true;
    shell.unsupported.hidden = renderer !== null;
    shell.setPairingInterruption(null);
    renderCompetitionState();
  };

  const rematchForResult = (
    resultView: CompetitionResultView,
    view = competitionView(),
  ): CompetitionPendingRematchView | undefined => view.pendingRematches.find(
    (candidate) => candidate.afterMatchId === resultView.matchId,
  );

  const updateRematchAction = (): void => {
    const resultView = displayedResult;
    const view = competitionView();
    shell.newChallengeButton.disabled = view.activity.kind !== "idle";
    if (resultView === null || !resultView.result.players.some((player) => player.id === selfActor.id)) {
      shell.setRematchAction("hidden");
      return;
    }
    if (view.activity.kind !== "idle") {
      shell.setRematchAction("hidden");
      return;
    }
    const pending = rematchForResult(resultView, view);
    if (pending === undefined) {
      shell.setRematchAction("request");
      return;
    }
    shell.setRematchAction(
      pending.requestedByPlayerIds.includes(selfActor.id) ? "pending" : "accept",
    );
  };

  const renderCompetitiveResultSummary = (
    result: MatchResult,
    resultContext: CompetitionResultView | null,
  ): void => {
    const seatA = result.players[0];
    const seatB = result.players[1];
    if (seatA === undefined || seatB === undefined) {
      shell.setCompetitiveResult(null);
      return;
    }
    const view = competitionView();
    const headToHead = view.headToHead.find((entry) =>
      entry.playerIds.includes(seatA.id) && entry.playerIds.includes(seatB.id)
    );
    const series = resultContext === null
      ? undefined
      : view.seriesScores.find((entry) => entry.seriesId === resultContext.seriesId);
    shell.setCompetitiveResult({
      round: resultContext?.round ?? activeMatch?.round ?? 1,
      scores: [
        { playerName: seatA.displayName, score: result.statsByPlayer[seatA.id]?.score ?? 0 },
        { playerName: seatB.displayName, score: result.statsByPlayer[seatB.id]?.score ?? 0 },
      ],
      seriesScore: `${series?.winsByPlayer[seatA.id] ?? 0}–${series?.winsByPlayer[seatB.id] ?? 0}`,
      headToHeadScore: headToHead === undefined
        ? "0–0"
        : `${headToHead.winsByPlayer[seatA.id] ?? 0}–${headToHead.winsByPlayer[seatB.id] ?? 0}`,
      ...(result.outcome === "desync"
        ? { notice: STRINGS["results.standingsUnchanged"] }
        : {}),
    });
  };

  const showResult = (
    result: MatchResult,
    localPlayerId: string | null,
    resultContext?: CompetitionResultView,
  ): void => {
    if (resultShownFor === result.matchId && mode === "results") return;
    stopCompetitivePump();
    stopGlitchPreview();
    audio.stopMusic();
    currentMusicMatchId = null;
    setInputsEnabled(false);
    resultShownFor = result.matchId;
    mode = "results";
    shell.setResultsMode("competitive");
    lastScrambleActive = false;
    shell.setScrambled(false);
    const seatA = result.players[0];
    const seatB = result.players[1];
    const inferredContext = competitionView().recentResults.find(
      (candidate) => candidate.matchId === result.matchId,
    );
    displayedResult = resultContext ?? inferredContext ?? (
      activeMatch === null
        ? null
        : {
            matchId: result.matchId,
            seriesId: activeMatch.seriesId,
            round: activeMatch.round,
            result,
            conflicted: false,
            variantCount: 1,
          }
    );
    const localSeat = localPlayerId === seatA?.id ? "seat-a" : localPlayerId === seatB?.id ? "seat-b" : null;
    if (result.reason === "connection-lost") {
      shell.resultsHeading.textContent = STRINGS["results.connectionLost"];
    } else if (result.outcome === "draw") shell.resultsHeading.textContent = STRINGS["results.draw"];
    else if (result.outcome === "desync") shell.resultsHeading.textContent = STRINGS["results.desync"];
    else if (localSeat === null) shell.resultsHeading.textContent = result.outcome === "seat-a" ? seatA?.displayName ?? STRINGS["results.victory"] : seatB?.displayName ?? STRINGS["results.victory"];
    else shell.resultsHeading.textContent = result.outcome === localSeat ? STRINGS["results.victory"] : STRINGS["results.defeat"];
    const localStats = localPlayerId === null ? undefined : result.statsByPlayer[localPlayerId];
    const stats = localStats ?? (seatA === undefined ? undefined : result.statsByPlayer[seatA.id]);
    renderCompetitiveResultSummary(result, displayedResult);
    setDefinitionList(shell, [
      [STRINGS["results.duration"], formatDuration(result.durationTicks)],
      [STRINGS["results.score"], stats?.score ?? 0],
      [STRINGS["results.lines"], stats?.lines ?? 0],
      [STRINGS["results.garbageSent"], stats?.garbageSent ?? 0],
      [STRINGS["results.tetrises"], stats?.tetrises ?? 0],
      [STRINGS["results.tSpins"], (stats?.tSpinSingles ?? 0) + (stats?.tSpinDoubles ?? 0) + (stats?.tSpinTriples ?? 0)],
      [STRINGS["results.powersActivated"], stats?.powersActivated ?? 0],
    ]);
    updateRematchAction();
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
    try {
      competitionLifecycle.express({
        kind: "complete-practice",
        runId: practiceRunId ?? `practice:${runtimeId}:${createRuntimeId()}`,
        durationTicks: snapshot.tick,
        finalLevel: snapshot.level,
        finalStats: {
          score: snapshot.player.score,
          lines: snapshot.player.lines,
          garbageSent: snapshot.player.stats.garbageSent,
          powersActivated: snapshot.player.stats.powersActivated,
          tetrises: snapshot.player.stats.tetrises,
          tSpinSingles: snapshot.player.stats.tSpinSingles,
          tSpinDoubles: snapshot.player.stats.tSpinDoubles,
          tSpinTriples: snapshot.player.stats.tSpinTriples,
        },
      });
    } catch {
      // Local Practice results remain usable when durable identity storage is unavailable.
    }
    mode = "results";
    shell.setResultsMode("practice");
    shell.setCompetitiveResult(null);
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
    shell.show("results");
    audio.play("defeat");
  };

  const processEffects = (
    effects: readonly SimulationEffect[],
    board: PresentationBoard = "left",
  ): void => {
    const pan = board === "left" ? -0.45 : 0.45;
    const barrierActivated = effects.some((effect) => effect.kind === "barrier-start");
    const barrierBlockedRows = effects.reduce(
      (total, effect) => total +
        (effect.kind === "barrier-block" ? Math.max(0, effect.rows ?? 0) : 0),
      0,
    );
    if (barrierActivated || barrierBlockedRows > 0) {
      presentHudBarrierResolution(board === "left" ? shell.left : shell.right, {
        activated: barrierActivated,
        blockedRows: barrierBlockedRows,
        animate: !graphicsPlan().staticLegibilityCues,
      });
    }
    presentationRouter.consumeSimulationEffects(effects, board);
    const comboCalloutRequested = board === "left" && effects.some((effect) =>
      effect.kind === "line-clear" &&
      effect.phase === "impact" &&
      effect.clearOrigin === "piece" &&
      (effect.comboCount ?? 0) >= 2
    );
    for (const effect of effects) {
      const hapticDuration = hapticDurationForSimulationEffect(
        effect,
        preferences.vibration,
        board,
      );
      if (hapticDuration !== null) navigator.vibrate?.(hapticDuration);
      if (effect.kind === "piece-locked") audio.play("lock", { pan });
      else if (effect.kind === "t-spin") audio.play("t-spin", { pan });
      else if (effect.kind === "line-clear" && effect.phase === "impact") {
        const plan = audioPlanForLineClear({
          rows: effect.rows ?? 1,
          comboCount: effect.comboCount ?? 0,
          clearOrigin: effect.clearOrigin ?? "piece",
        });
        audio.play(plan.sfx, { pan });
        if (board === "left" && plan.callout !== null) {
          audio.playCallout(plan.callout, { pan, delayMs: plan.calloutDelayMs });
        }
      } else if (effect.kind === "garbage-rise") {
        audio.playGarbageRise(effect.rows ?? 1, { pan });
      }
      else if (effect.kind === "hollow-cross") audio.play("hollow-cross", { pan });
      else if (effect.kind === "glitch-piece") audio.play("special-trigger", { pan });
      else if (effect.kind === "blackout-start") {
        audio.play("power-blackout", { pan });
      } else if (effect.kind === "barrier-start") {
        audio.play("power-barrier", { pan });
      }
      else if (effect.kind === "power-activated" && effect.power !== undefined) {
        if (board === "left") {
          audio.playCallout(calloutForPower(effect.power), {
            pan: panForPowerCue(effect.power, pan),
            delayMs: comboCalloutRequested ? 150 : 0,
          });
        }
      }
      else {
        const physicalCue = cueForPhysicalEffect(effect);
        if (physicalCue !== null) audio.play(physicalCue, { pan });
        else if (effect.kind === "top-out" && mode === "practice" && practice !== null) {
          showPracticeResult(practice.readSnapshot());
        }
      }
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

  const restoreCompletedMatch = (match: ActiveMatch, result: MatchResult): void => {
    stopCompetitivePump();
    competitive?.disconnect("session-teardown");
    competitive = null;
    spectator?.channel.leave?.();
    spectator = null;
    practice = null;
    activeMatch = match;
    interruptedPairing = null;
    shell.setPairingInterruption(null);
    practicePauseReasons.delete("pairing");
    lastScrambleActive = false;
    shell.setScrambled(false);
    announcedConfigHash = null;
    shell.readinessPanel.hidden = true;
    shell.setPairingExitMode(match.source === "rematch" ? "withdraw" : "leave");
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
    practicePauseReasons.clear();
    practicePaused = false;
    practiceAccumulator = 0;
    lastLocalLevel = 1;
    warnedUpcomingPower = null;
    competitiveRemoteCache = null;
    spectatorLeftCache = null;
    spectatorRightCache = null;
    const practiceSeed = createRuntimeId();
    practiceRunId = `practice:${runtimeId}:${practiceSeed}`;
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
    const seatB = match.participants.seatB;
    if (seatB === null) return null;
    const hub = ensureRealtimeHub();
    if (hub === null) return null;
    const channel = hub.transport();
    const snapshots = new RemoteSnapshotStore();
    let lastSnapshotAtMs: number | null = null;
    snapshots.bind(match.participants.seatA.playerId, match.seatASessionId);
    snapshots.bind(seatB.playerId, match.seatBSessionId);
    const allowed = new Set([match.participants.seatA.playerId, seatB.playerId]);
    try {
      channel.setListener((bytes) => {
        const decoded = decodeEnvelope(bytes, {
          expectedMatchId: match.matchId,
          allowedSenderIds: allowed,
        });
        if (decoded.ok && decoded.value.kind === "SNAPSHOT") {
          if (snapshots.accept(decoded.value)) lastSnapshotAtMs = performance.now();
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
    return {
      channel,
      snapshots,
      matchId: match.matchId,
      get lastSnapshotAtMs() {
        return lastSnapshotAtMs;
      },
    };
  };

  const applyCompetitivePresentation = (
    view: CompetitiveSessionView,
  ): ReturnType<typeof recoveryPresentationFor> => {
    const presentation = recoveryPresentationFor({
      ...view,
      reconnectingDotCount:
        Math.floor(performance.now() / RECONNECT_DOT_STEP_MS) % 3 + 1,
      reducedMotion: preferences.reducedMotion,
      ...(view.reconnectRemainingSeconds === undefined
        ? {}
        : { interruptionRemainingSeconds: view.reconnectRemainingSeconds }),
    });
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

  const publishMatchResult = (
    match: ActiveMatch,
    result: MatchResult,
  ): void => {
    const view = competitionView();
    if (
      result.matchId !== match.matchId ||
      view.recentResults.some((candidate) => candidate.matchId === result.matchId)
    ) {
      return;
    }
    try {
      competitionLifecycle.express({
        kind: "finish-match",
        matchId: result.matchId,
        result: {
          outcome: result.outcome,
          reason: result.reason,
          durationTicks: result.durationTicks,
          finalLevel: result.finalLevel,
          statsByPlayer: result.statsByPlayer,
          completedBy: result.completedBy,
        },
      });
    } catch {
      // The lifecycle retries admitted results; failed admission remains visible in recovery UI.
    }
  };

  const clearPassiveLiveRecovery = (): void => {
    const recovery = passiveLiveRecovery;
    if (recovery?.tickTimer !== null && recovery?.tickTimer !== undefined) {
      window.clearTimeout(recovery.tickTimer);
    }
    passiveLiveRecovery = null;
    shell.setRecoveryConfirmation(null);
    shell.setHomeRecovery(null);
  };

  const passiveRecoveryStatus = (recovery: PassiveLiveRecovery) =>
    liveControllerRecoveryStatus({
      observedAtMs: recovery.observedAtMs,
      controllerSeenAtMs: [
        recovery.seatASeenAtMs,
        recovery.seatBSeenAtMs,
      ],
      nowMs: performance.now(),
    });

  const matchesPassiveRecovery = (
    match: CompetitionLiveMatchView,
    recovery: PassiveLiveRecovery,
  ): boolean =>
    match.matchId === recovery.matchId &&
    match.start.configHash === recovery.committedConfigHash &&
    match.seatA.id === recovery.seatAPlayerId &&
    match.seatB.id === recovery.seatBPlayerId &&
    match.start.seatASessionId === recovery.seatASessionId &&
    match.start.seatBSessionId === recovery.seatBSessionId;

  const pendingRecoveryResolutionFor = (matchId: string) =>
    competitionLifecycle.current().intents.find((entry) =>
      !entry.settled &&
      (
        (entry.intent.kind === "concede-match" && entry.intent.matchId === matchId) ||
        (entry.intent.kind === "settle-connection-loss" && entry.intent.matchId === matchId)
      )
    ) ?? null;

  const clearRecoveryResolutionProgress = (
    reference: CompetitionIntentReference,
  ): void => {
    recoveryResolutionStartedAtMs.delete(reference);
    const recovery = passiveLiveRecovery;
    if (recovery !== null) {
      recovery.finishQueued = false;
      refreshPassiveLiveRecovery();
    }
  };

  const presentPendingRecoveryResolution = (
    recovery: PassiveLiveRecovery,
  ): boolean => {
    const pending = pendingRecoveryResolutionFor(recovery.matchId);
    if (pending === null) return false;
    const startedAtMs = recoveryResolutionStartedAtMs.get(pending.reference) ??
      performance.now();
    recoveryResolutionStartedAtMs.set(pending.reference, startedAtMs);
    shell.setHomeRecovery({
      kind: "ending",
      delayed: performance.now() - startedAtMs >= RECOVERY_CONFIRMATION_DELAY_MS,
    });
    return true;
  };

  const retryPendingRecoveryResolution = (
    recovery: PassiveLiveRecovery,
  ): void => {
    const pending = pendingRecoveryResolutionFor(recovery.matchId);
    if (pending === null) return;
    const now = performance.now();
    const startedAtMs = recoveryResolutionStartedAtMs.get(pending.reference);
    if (
      startedAtMs === undefined ||
      now - startedAtMs < RECOVERY_CONFIRMATION_DELAY_MS
    ) {
      return;
    }
    try {
      competitionLifecycle.express(pending.intent);
      recoveryResolutionStartedAtMs.set(pending.reference, now);
      refreshPassiveLiveRecovery();
    } catch {
      // The next canonical revision will either make the retry admissible or
      // clear the obsolete recovery prompt.
    }
  };

  const publishPassiveConnectionLoss = (
    recovery: PassiveLiveRecovery,
  ): void => {
    if (
      passiveLiveRecovery !== recovery ||
      recovery.finishQueued ||
      document.visibilityState === "hidden" ||
      realtimeHub === null ||
      passiveRecoveryStatus(recovery).kind !== "expired"
    ) {
      return;
    }
    const view = competitionView();
    if (view.recentResults.some((entry) => entry.matchId === recovery.matchId)) {
      clearPassiveLiveRecovery();
      return;
    }
    const live = view.liveMatches.find((entry) =>
      matchesPassiveRecovery(entry, recovery) &&
      (entry.seatA.id === selfActor.id || entry.seatB.id === selfActor.id)
    );
    if (live === undefined) {
      clearPassiveLiveRecovery();
      return;
    }
    const committedSessionId = live.seatA.id === selfActor.id
      ? live.start.seatASessionId
      : live.start.seatBSessionId;
    if (committedSessionId === runtimeId) {
      clearPassiveLiveRecovery();
      return;
    }
    try {
      const reference = competitionLifecycle.express({
        kind: "settle-connection-loss",
        matchId: live.matchId,
      });
      recovery.finishQueued = true;
      recoveryResolutionStartedAtMs.set(reference, performance.now());
      refreshPassiveLiveRecovery();
    } catch {
      recovery.finishQueued = false;
    }
  };

  const concedePassiveMatch = (recovery: PassiveLiveRecovery): void => {
    if (passiveLiveRecovery !== recovery || host === undefined) return;
    const live = competitionView().liveMatches.find((entry) =>
      matchesPassiveRecovery(entry, recovery) &&
      (entry.seatA.id === selfActor.id || entry.seatB.id === selfActor.id)
    );
    if (live === undefined) return;
    const existing = pendingRecoveryResolutionFor(recovery.matchId);
    if (existing !== null) {
      recoveryResolutionStartedAtMs.set(existing.reference, performance.now());
      refreshPassiveLiveRecovery();
      return;
    }
    try {
      const reference = competitionLifecycle.express({
        kind: "concede-match",
        matchId: live.matchId,
      });
      recovery.finishQueued = true;
      recoveryResolutionStartedAtMs.set(reference, performance.now());
      refreshPassiveLiveRecovery();
    } catch {
      recovery.finishQueued = false;
    }
  };

  const refreshPassiveLiveRecovery = (): void => {
    const recovery = passiveLiveRecovery;
    if (recovery === null) return;
    if (recovery.tickTimer !== null) {
      window.clearTimeout(recovery.tickTimer);
    }
    recovery.tickTimer = null;
    if (document.visibilityState === "hidden") {
      return;
    }
    if (realtimeHub === null) {
      const restoredHub = ensureRealtimeHub();
      if (restoredHub === null) {
        shell.setHomeRecovery({ kind: "active-elsewhere" });
        const retryDelay = Math.min(
          DURABLE_RETRY_MAX_MS,
          DURABLE_RETRY_MIN_MS * 2 ** Math.min(recovery.hubRetryAttempts, 4),
        );
        recovery.hubRetryAttempts += 1;
        recovery.tickTimer = window.setTimeout(
          refreshPassiveLiveRecovery,
          retryDelay,
        );
        return;
      }
      // Time spent without a receive path cannot count as proof that either
      // committed controller was absent. Start a fresh observation window.
      recovery.observedAtMs = performance.now();
      recovery.seatASeenAtMs = null;
      recovery.seatBSeenAtMs = null;
      recovery.hubRetryAttempts = 0;
      if (
        mode === "spectator" &&
        activeMatch?.role === "spectator" &&
        activeMatch.matchId !== recovery.matchId &&
        spectator === null
      ) {
        spectator = spectatorRuntime(activeMatch);
      }
    }
    const live = competitionView().liveMatches.find((entry) =>
      matchesPassiveRecovery(entry, recovery)
    );
    if (live === undefined) {
      clearPassiveLiveRecovery();
      return;
    }
    if (presentPendingRecoveryResolution(recovery)) {
      if (passiveLiveRecovery === recovery && recovery.tickTimer === null) {
        recovery.tickTimer = window.setTimeout(
          refreshPassiveLiveRecovery,
          LIVE_RECOVERY_TICK_MS,
        );
      }
      return;
    }
    const status = passiveRecoveryStatus(recovery);
    if (status.kind === "active-elsewhere") {
      shell.setHomeRecovery({ kind: "active-elsewhere" });
    } else if (status.kind === "interrupted") {
      shell.setHomeRecovery(status);
    } else {
      shell.setHomeRecovery({ kind: "interrupted", remainingSeconds: 0 });
      shell.endInterruptedMatchButton.disabled = recovery.finishQueued;
    }
    if (passiveLiveRecovery === recovery && recovery.tickTimer === null) {
      recovery.tickTimer = window.setTimeout(
        refreshPassiveLiveRecovery,
        LIVE_RECOVERY_TICK_MS,
      );
    }
  };

  const syncPassiveLiveRecovery = (
    match: CompetitionLiveMatchView | undefined,
  ): boolean => {
    if (match === undefined) {
      clearPassiveLiveRecovery();
      return false;
    }
    const committedSessionId = match.seatA.id === selfActor.id
      ? match.start.seatASessionId
      : match.seatB.id === selfActor.id
        ? match.start.seatBSessionId
        : undefined;
    if (committedSessionId === undefined || committedSessionId === runtimeId) {
      clearPassiveLiveRecovery();
      return false;
    }
    if (passiveLiveRecovery === null || !matchesPassiveRecovery(match, passiveLiveRecovery)) {
      clearPassiveLiveRecovery();
      passiveLiveRecovery = {
        matchId: match.matchId,
        committedConfigHash: match.start.configHash,
        seatAPlayerId: match.seatA.id,
        seatBPlayerId: match.seatB.id,
        seatASessionId: match.start.seatASessionId,
        seatBSessionId: match.start.seatBSessionId,
        allowedSenderIds: new Set([match.seatA.id, match.seatB.id]),
        observedAtMs: performance.now(),
        seatASeenAtMs: null,
        seatBSeenAtMs: null,
        tickTimer: null,
        finishQueued: false,
        hubRetryAttempts: 0,
      };
    }
    refreshPassiveLiveRecovery();
    return true;
  };

  receivePassiveControllerTraffic = (data): void => {
    const recovery = passiveLiveRecovery;
    if (recovery === null) return;
    const decoded = decodeEnvelope(data, {
      expectedMatchId: recovery.matchId,
      allowedSenderIds: recovery.allowedSenderIds,
    });
    if (!decoded.ok) return;
    const envelope = decoded.value;
    if (
      envelope.kind === "KEEPALIVE" &&
      envelope.payload.activeSessionId !== envelope.sessionId
    ) {
      return;
    }
    const now = performance.now();
    if (
      envelope.senderId === recovery.seatAPlayerId &&
      envelope.sessionId === recovery.seatASessionId
    ) {
      recovery.seatASeenAtMs = now;
    } else if (
      envelope.senderId === recovery.seatBPlayerId &&
      envelope.sessionId === recovery.seatBSessionId
    ) {
      recovery.seatBSeenAtMs = now;
    } else {
      return;
    }
    refreshPassiveLiveRecovery();
  };

  const startActiveMatch = (match: ActiveMatch): void => {
    const preserveOwnedLiveRecovery = match.role === "spectator" &&
      passiveLiveRecovery !== null &&
      (match.recoveryWatch === true || passiveLiveRecovery.matchId !== match.matchId);
    if (!preserveOwnedLiveRecovery) clearPassiveLiveRecovery();
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
    practiceRunId = null;
    lastScrambleActive = false;
    shell.setScrambled(false);
    announcedConfigHash = null;
    pendingCommittedStart = null;
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
      previousCompetitive?.disconnect("replacement");
    } catch {
      // A failed leave is followed by a contained join attempt below.
    }
    try {
      previousSpectator?.channel.leave?.();
    } catch {
      // A failed leave is followed by a contained join attempt below.
    }
    interruptedPairing = null;
    practicePauseReasons.delete("pairing");
    shell.setPairingInterruption(null);
    activeMatch = match;
    resultShownFor = null;
    announcedConfigHash = match.committedConfigHash ?? null;
    shell.arena.dataset.mode = "versus";
    shell.matchMenuButton.hidden = false;
    matchMenuOpen = false;
    setMatchMenu(
      shell,
      match.role === "spectator" ? "spectator" : "competitive",
      false,
    );
    const touchButtonsVisible =
      match.role !== "spectator" && preferences.touchControls === "buttons";
    shell.touchButtons.hidden = !touchButtonsVisible;
    shell.container.dataset.touchButtonsVisible = String(touchButtonsVisible);
    shell.readinessPanel.hidden = true;
    shell.setReadOnlyWatchStatus(null);
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
      shell.right.pane.setAttribute("aria-disabled", "true");
      audio.startMusic(match.seriesId, match.round - 1);
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
      shell.setReadOnlyWatchStatus({ kind: "waiting" });
      if (match.recoveryWatch === true) {
        shell.overlay.hidden = true;
      } else {
        shell.overlay.hidden = false;
        shell.setOverlayMessage(STRINGS["lobby.spectatorNotice"]);
      }
      setInputsEnabled(false);
      return;
    }

    const seatB = match.participants.seatB;
    shell.right.pane.removeAttribute("aria-disabled");
    if (seatB === null) {
      shell.overlay.hidden = false;
      shell.setOverlayMessage(STRINGS["lobby.realtimeUnavailable"]);
      return;
    }
    const hub = ensureRealtimeHub();
    if (hub === null) {
      shell.overlay.hidden = false;
      shell.setOverlayMessage(STRINGS["lobby.realtimeUnavailable"]);
      retryActiveMatch();
      return;
    }
    const channel = hub.transport();
    shell.left.pane.classList.add("is-local");
    shell.right.pane.classList.add("is-remote");
    const local = match.role === "a" ? match.participants.seatA : seatB;
    const peer = match.role === "a" ? seatB : match.participants.seatA;
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
        transport: channel,
        ...(match.committedSeed === undefined
          ? {}
          : { createSeed: () => match.committedSeed! }),
        diagnostics: networkDiagnostics,
        onStartCommitted: () => {
          if (
            match.role !== "a" ||
            match.committedConfigHash !== undefined ||
            announcedConfigHash !== null
          ) {
            return;
          }
          const view = competitive?.view();
          if (
            view?.configHash === undefined ||
            view.seed === undefined ||
            match.participants.seatB === null
          ) {
            return;
          }
          pendingCommittedStart = {
            match,
            configHash: view.configHash,
            seed: view.seed,
          };
          publishCommittedStartWhenReady();
        },
        onPhaseChange: (phase) => {
          const view = competitive?.view();
          if (phase === "countdown" || phase === "playing") {
            if (currentMusicMatchId !== match.matchId) {
              audio.startMusic(match.seriesId, match.round - 1);
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
          }
        },
        onTransportRecoveryNeeded: () => {
          return resumeCompetitiveTransport();
        },
        onSimulationEffects: (effects) => {
          processEffects(effects, "left");
        },
        onTerminal: (_terminal: CompetitiveTerminalState) => {
          setInputsEnabled(false);
        },
        onResultConfirmed: (result) => {
          const seatAId = result.players[0]?.id;
          if (result.outcome !== "desync" || seatAId === selfActor.id) {
            publishMatchResult(match, result);
          } else if (!neutralFinishFallbackTimers.has(result.matchId)) {
            const fallbackDelay = Math.max(
              DURABLE_RETRY_MIN_MS,
              (host?.sendUpdateInterval ?? 0) + DURABLE_RETRY_MIN_MS,
            );
            const timer = window.setTimeout(() => {
              neutralFinishFallbackTimers.delete(result.matchId);
              publishMatchResult(match, result);
            }, fallbackDelay);
            neutralFinishFallbackTimers.set(result.matchId, timer);
          }
          showResult(result, selfActor.id, {
            matchId: result.matchId,
            seriesId: match.seriesId,
            round: match.round,
            result,
            conflicted: false,
            variantCount: 1,
          });
        },
        onDesynchronization: () => {
          shell.overlay.hidden = false;
          shell.setOverlayMessage(STRINGS["match.desynchronization"]);
        },
      });
      competitive.start();
      if (match.committedConfigHash !== undefined) competitive.setReady(true);
    } catch {
      try {
        if (competitive === null) channel.leave?.();
        else competitive.disconnect("startup-failure");
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
    const initialView = competitive.view();
    shell.setReadiness(initialView.localReady, initialView.peerReady, {
      localName: local.displayName,
      opponentName: peer.displayName,
    });
    applyCompetitivePresentation(initialView);
  };

  const clearConfirmingPairing = (): void => {
    if (confirmingPairing?.actionTimer !== null && confirmingPairing !== null) {
      window.clearTimeout(confirmingPairing.actionTimer);
    }
    confirmingPairing = null;
    if (shell.homeRecovery.dataset.kind === "confirming") {
      shell.setHomeRecovery(null);
    }
    if (shell.homeStatus.textContent === STRINGS["lobby.confirmingSession"]) {
      shell.homeStatus.textContent = "";
    }
  };

  const showConfirmingPairing = (pairing: StartingPairingView): void => {
    if (confirmingPairing?.pairingId !== pairing.pairingId) {
      clearConfirmingPairing();
      confirmingPairing = {
        pairingId: pairing.pairingId,
        startedAtMs: performance.now(),
        actionTimer: null,
      };
    }
    const state = confirmingPairing;
    const elapsedMs = state === null
      ? 0
      : performance.now() - state.startedAtMs;
    if (
      state !== null &&
      state.actionTimer === null &&
      elapsedMs < RULES.network.missingPeerMs
    ) {
      const remaining = RULES.network.missingPeerMs - elapsedMs;
      state.actionTimer = window.setTimeout(() => {
        if (confirmingPairing === state) state.actionTimer = null;
        reconcileLobby();
      }, remaining);
    }
    if (
      state !== null &&
      elapsedMs >= RULES.network.missingPeerMs
    ) {
      shell.homeStatus.textContent = "";
      shell.setHomeRecovery({
        kind: "confirming",
        exit: pairing.seatB.id === selfActor.id ? "withdraw" : "cancel",
      });
    } else {
      shell.homeStatus.textContent = STRINGS["lobby.confirmingSession"];
    }
    mode = "lobby";
    shell.show("home");
  };

  const reconcileLobby = (): void => {
    publishCommittedStartWhenReady();
    const view = competitionView();
    const ownedStarting = view.startingPairings.find((pairing) =>
      pairing.seatA.id === selfActor.id || pairing.seatB.id === selfActor.id
    );
    const ownedLive = view.liveMatches.find((pairing) =>
      pairing.seatA.id === selfActor.id || pairing.seatB.id === selfActor.id
    );
    const completed = activeMatch === null
      ? undefined
      : view.recentResults.find((entry) => entry.matchId === activeMatch?.matchId);
    if (
      completed !== undefined &&
      mode !== "results" &&
      interruptedPairing === null
    ) {
      restoreCompletedMatch(activeMatch!, completed.result);
      displayedResult = completed;
      return;
    }

    if (ownedStarting === undefined && ownedLive === undefined) {
      clearConfirmingPairing();
      clearPassiveLiveRecovery();
      const hadInterruption = interruptedPairing !== null;
      interruptedPairing = null;
      shell.setPairingInterruption(null);
      if (hadInterruption && mode === "practice") {
        practicePauseReasons.delete("pairing");
        setPracticePaused(practicePauseReasons.size > 0);
      }
      if (
        activeMatch !== null &&
        activeMatch.role !== "spectator" &&
        mode === "competitive"
      ) {
        showHome();
      }
      return;
    }

    if (ownedStarting === undefined && ownedLive !== undefined) {
      clearConfirmingPairing();
      if (syncPassiveLiveRecovery(ownedLive)) {
        interruptedPairing = null;
        shell.setPairingInterruption(null);
        if (
          mode === "competitive" ||
          (mode === "spectator" &&
            activeMatch?.pairingId === ownedLive.pairingId &&
            activeMatch.recoveryWatch !== true)
        ) {
          showHome();
          refreshPassiveLiveRecovery();
        }
        return;
      }
    } else {
      clearPassiveLiveRecovery();
    }

    const ownedPairing = ownedStarting ?? ownedLive!;
    const preservingActivity = ownedStarting !== undefined && (
      mode === "practice" ||
      (mode === "spectator" && activeMatch?.pairingId !== ownedStarting.pairingId)
    );
    if (preservingActivity && ownedStarting !== undefined) {
      interruptedPairing = ownedStarting;
      if (mode === "practice") {
        practicePauseReasons.add("pairing");
        setPracticePaused(true);
      }
      const opponent = ownedStarting.seatA.id === selfActor.id
        ? ownedStarting.seatB
        : ownedStarting.seatA;
      shell.setPairingInterruption({
        kind: ownedStarting.source === "rematch" ? "rematch" : "pairing",
        opponentName: opponent.displayName,
      });
      return;
    }

    const localSessionId = ownedPairing.runtimeSessionByPlayer[selfActor.id];
    if (
      ownedStarting !== undefined &&
      localSessionId !== undefined &&
      localSessionId !== runtimeId
    ) {
      clearConfirmingPairing();
      if (mode === "competitive" || mode === "spectator") showHome();
      shell.setHomeRecovery({ kind: "setup-elsewhere" });
      return;
    }
    if (ownedStarting !== undefined && localSessionId !== runtimeId) {
      showConfirmingPairing(ownedStarting);
      return;
    }

    const next = activeMatchFrom(ownedPairing);
    if (next === null) {
      if (ownedStarting !== undefined) showConfirmingPairing(ownedStarting);
      return;
    }
    clearConfirmingPairing();

    if (
      activeMatch !== null &&
      activeMatch.pairingId === next.pairingId &&
      activeMatch.role === next.role &&
      activeMatch.seatASessionId === next.seatASessionId &&
      activeMatch.seatBSessionId === next.seatBSessionId
    ) {
      if (next.committedConfigHash !== undefined) {
        activeMatch.committedConfigHash = next.committedConfigHash;
        if (next.committedSeed !== undefined) {
          activeMatch.committedSeed = next.committedSeed;
        }
      }
      return;
    }

    startActiveMatch(next);
  };

  shell.practiceButton.addEventListener("click", startPractice);
  shell.lobbyButton.addEventListener("click", showLobby);
  shell.viewLobbyButton.addEventListener("click", showLobby);
  shell.lobbyBackButton.addEventListener("click", showHome);
  shell.retryConnectionButton.addEventListener("click", () => {
    const recovery = passiveLiveRecovery;
    const pending = recovery === null
      ? null
      : pendingRecoveryResolutionFor(recovery.matchId);
    if (recovery !== null && pending !== null) {
      retryPendingRecoveryResolution(recovery);
      return;
    }
    reconcileLobby();
  });
  shell.endInterruptedMatchButton.addEventListener("click", () => {
    const recovery = passiveLiveRecovery;
    if (recovery !== null && passiveRecoveryStatus(recovery).kind === "expired") {
      shell.setRecoveryConfirmation("neutral");
    }
  });
  shell.concedeRecoveryButton.addEventListener("click", () => {
    if (passiveLiveRecovery !== null) shell.setRecoveryConfirmation("concede");
  });
  shell.cancelRecoveryConfirmationButton.addEventListener("click", () => {
    shell.setRecoveryConfirmation(null);
  });
  shell.confirmRecoveryButton.addEventListener("click", () => {
    const kind = shell.recoveryConfirmation.dataset.kind;
    const recovery = passiveLiveRecovery;
    shell.setRecoveryConfirmation(null);
    if (recovery === null) return;
    if (kind === "concede") {
      concedePassiveMatch(recovery);
    } else if (
      kind === "neutral" &&
      passiveRecoveryStatus(recovery).kind === "expired"
    ) {
      publishPassiveConnectionLoss(recovery);
      shell.endInterruptedMatchButton.disabled = recovery.finishQueued;
    }
  });
  shell.exitSetupButton.addEventListener("click", () => {
    const pairing = competitionView().startingPairings.find(
      (candidate) =>
        candidate.seatA.id === selfActor.id || candidate.seatB.id === selfActor.id,
    );
    if (pairing !== undefined) leaveStartingPairing(pairing.pairingId);
  });
  shell.helpButton.addEventListener("click", () => showHelp(shell, "how"));
  shell.controlsHelpButton.addEventListener("click", () => showHelp(shell, "controls"));
  shell.helpBack.addEventListener("click", () => shell.show("home"));
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
    const previousGraphics = preferences.graphics;
    preferences = {
      effectsEnabled: shell.settingsInputs.effectsEnabled.checked,
      effectsVolume: Number(shell.settingsInputs.effectsVolume.value),
      musicEnabled: shell.settingsInputs.musicEnabled.checked,
      musicVolume: Number(shell.settingsInputs.musicVolume.value),
      calloutsEnabled: shell.settingsInputs.calloutsEnabled.checked,
      calloutsVolume: Number(shell.settingsInputs.calloutsVolume.value),
      vibration: shell.settingsInputs.vibration.checked,
      touchControls: shell.settingsInputs.touchControls.value === "buttons" ? "buttons" : "gestures",
      colorPalette: shell.settingsInputs.colorPalette.value === "colorblind" ? "colorblind" : "standard",
      reducedMotion: shell.settingsInputs.reducedMotion.checked,
      reducedFlashes: shell.settingsInputs.reducedFlashes.checked,
      graphics: shell.settingsInputs.graphics.value === "normal" ||
        shell.settingsInputs.graphics.value === "low" ||
        shell.settingsInputs.graphics.value === "very-low"
        ? shell.settingsInputs.graphics.value
        : "auto",
      screenShake: shell.settingsInputs.screenShake.checked,
      gameplayTips: shell.settingsInputs.gameplayTips.checked,
    };
    if (preferences.graphics === "auto" && previousGraphics !== "auto") autoGraphics.reset();
    savePreferences(storage, preferences);
    applyPreferences();
    shell.show("home");
  });
  for (const input of Object.values(shell.settingsInputs)) {
    input.addEventListener("change", () => {
      shell.settingsBack.click();
      shell.settingsButton.click();
    });
  }

  const createChallenge = (): void => {
    const before = competitionView();
    const creationPending = competitionLifecycle.current().intents.some((entry) =>
      !entry.settled && entry.intent.kind === "create-challenge"
    );
    const joinPending = competitionLifecycle.current().intents.some((entry) =>
      !entry.settled && entry.intent.kind === "join-challenge"
    );
    if (!realtimeAvailable || before.activity.kind !== "idle" || creationPending || joinPending) {
      return;
    }
    try {
      competitionLifecycle.express({ kind: "create-challenge" });
      shell.lobbyStatus.textContent = STRINGS["lobby.challengeCreated"];
    } catch {
      shell.lobbyStatus.textContent = STRINGS["lobby.challengeError"];
    }
  };

  const cancelOwnedChallenge = (): void => {
    const before = competitionView();
    const cancellationPending = competitionLifecycle.current().intents.some((entry) =>
      !entry.settled && entry.intent.kind === "cancel-challenge"
    );
    if (before.activity.kind !== "waiting" || cancellationPending) return;
    const ownedChallengeId = before.activity.challengeId;
    const challenge = before.openChallenges.find(
      (candidate) => candidate.challengeId === ownedChallengeId,
    );
    if (challenge === undefined) return;
    try {
      competitionLifecycle.express({
        kind: "cancel-challenge",
        challengeId: challenge.challengeId,
      });
    } catch {
      shell.lobbyStatus.textContent = STRINGS["lobby.challengeError"];
    }
  };

  const joinChallenge = (challengeId: string): void => {
    const before = competitionView();
    const pending = competitionLifecycle.current().intents.some((entry) =>
      !entry.settled &&
      (entry.intent.kind === "join-challenge" || entry.intent.kind === "create-challenge")
    );
    if (!realtimeAvailable || before.activity.kind !== "idle" || pending) return;
    const challenge = before.openChallenges.find(
      (candidate) => candidate.challengeId === challengeId,
    );
    if (challenge === undefined || challenge.creator.id === selfActor.id) {
      shell.lobbyStatus.textContent = STRINGS["lobby.noOpenChallenge"];
      return;
    }
    try {
      competitionLifecycle.express({ kind: "join-challenge", challengeId });
      shell.lobbyStatus.textContent = STRINGS["lobby.challengeJoined"];
    } catch {
      shell.lobbyStatus.textContent = STRINGS["lobby.claimLost"];
    }
  };

  function leaveStartingPairing(pairingId: string): void {
    if (pendingPairingExitReference !== null) return;
    try {
      pendingPairingExitReference = competitionLifecycle.express({
        kind: "leave-pairing",
        pairingId,
      });
    } catch {
      // A canonical revision will either make the action obsolete or allow a retry.
    }
  }

  const acceptPendingRematch = (afterMatchId: string): void => {
    if (competitionView().activity.kind !== "idle") return;
    const acceptancePending = competitionLifecycle.current().intents.some((entry) =>
      !entry.settled &&
      entry.intent.kind === "accept-rematch" &&
      entry.intent.afterMatchId === afterMatchId
    );
    if (acceptancePending) {
      shell.setRematchAction("pending");
      return;
    }
    try {
      competitionLifecycle.express({ kind: "accept-rematch", afterMatchId });
      shell.setRematchAction("pending");
    } catch {
      // A concurrent request/acceptance will be reflected by the next snapshot.
    }
  };

  const watchMatch = (matchId: string): void => {
    const view = competitionView();
    if (view.activity.kind === "starting") return;
    const recoveringOwnedMatch = view.activity.kind === "live" &&
      view.activity.matchId === matchId &&
      passiveLiveRecovery?.matchId === matchId;
    if (
      view.activity.kind === "live" &&
      view.activity.matchId === matchId &&
      !recoveringOwnedMatch
    ) {
      return;
    }
    const match = view.liveMatches.find((candidate) => candidate.matchId === matchId);
    if (match === undefined) return;
    const next = activeMatchFrom(match, true);
    if (next !== null) {
      startActiveMatch(recoveringOwnedMatch
        ? { ...next, recoveryWatch: true }
        : next);
    }
  };

  renderCompetitionState = (): void => {
    const view = competitionView();
    presentCompetition({
      shell,
      view,
      self: selfActor,
      realtimeAvailable,
      allowOwnedMatchWatch: passiveLiveRecovery !== null,
      isOnline: (actorId, challengeId) => presence.isOnline(actorId, challengeId),
      onJoinChallenge: joinChallenge,
      onWatchMatch: watchMatch,
      onLeavePairing: leaveStartingPairing,
      onAcceptRematch: acceptPendingRematch,
    });
    const localPracticeBest = Number.parseInt(
      storage.getItem(PRACTICE_HIGH_SCORE_KEY) ?? "0",
      10,
    ) || 0;
    shell.setPracticeRecords({
      personalBest: Math.max(
        localPracticeBest,
        view.practice.personalBest?.score ?? 0,
      ),
      ...(view.practice.record === null
        ? {}
        : {
            chatRecord: {
              score: view.practice.record.score,
              playerName: view.practice.record.player.displayName,
            },
          }),
    });
    if (!realtimeAvailable) {
      shell.homeStatus.textContent = STRINGS["lobby.realtimeUnavailable"];
    } else if (shell.homeStatus.textContent === STRINGS["lobby.waitingForOpponent"]) {
      shell.homeStatus.textContent = "";
    }
    if (mode === "results") {
      if (displayedResult !== null) {
        displayedResult = view.recentResults.find(
          (entry) => entry.matchId === displayedResult?.matchId,
        ) ?? displayedResult;
        renderCompetitiveResultSummary(displayedResult.result, displayedResult);
      }
      updateRematchAction();
    }
  };

  for (const intent of competitionLifecycle.current().intents) {
    if (intent.intent.kind === "join-challenge" && intent.eventStatus === "rejected") {
      reportedRejectedJoinReferences.add(intent.reference);
    }
  }
  competitionLifecycle.observe((snapshot) => {
    if (pendingPairingExitReference !== null) {
      const exit = snapshot.intents.find(
        (entry) => entry.reference === pendingPairingExitReference,
      );
      if (exit?.eventStatus === "effective" || exit?.eventStatus === "rejected") {
        pendingPairingExitReference = null;
      }
    }
    const newlyRejectedJoin = snapshot.intents.find((entry) =>
      entry.intent.kind === "join-challenge" &&
      entry.eventStatus === "rejected" &&
      !reportedRejectedJoinReferences.has(entry.reference)
    );
    if (newlyRejectedJoin !== undefined) {
      reportedRejectedJoinReferences.add(newlyRejectedJoin.reference);
      shell.lobbyStatus.textContent = STRINGS["lobby.claimLost"];
    }
    for (const [matchId, fallbackTimer] of neutralFinishFallbackTimers) {
      if (snapshot.competition.recentResults.some((result) => result.matchId === matchId)) {
        window.clearTimeout(fallbackTimer);
        neutralFinishFallbackTimers.delete(matchId);
      }
    }
    for (const reference of recoveryResolutionStartedAtMs.keys()) {
      const intent = snapshot.intents.find((entry) => entry.reference === reference);
      if (intent?.eventStatus === "effective" || intent?.eventStatus === "rejected") {
        clearRecoveryResolutionProgress(reference as CompetitionIntentReference);
      }
    }
    renderCompetitionState();
    reconcileLobby();
  });

  const publishWaitingPresence = (): void => {
    const view = competitionView();
    if (view.activity.kind !== "waiting") return;
    const ownedChallengeId = view.activity.challengeId;
    const challenge = view.openChallenges.find(
      (candidate) => candidate.challengeId === ownedChallengeId,
    );
    const hub = ensureRealtimeHub();
    if (challenge === undefined || hub === null) return;
    const frame = {
      schema: PRESENCE_SCHEMA,
      actor: { ...selfActor },
      challengeId: challenge.challengeId,
      runtimeId,
    } as const;
    try {
      presence.observe(frame);
      hub.send(encodePresenceFrame(frame));
    } catch {
      // Presence is advisory and never changes durable matchmaking authority.
    }
  };

  shell.createButton.addEventListener("click", createChallenge);
  shell.cancelChallengeButton.addEventListener("click", cancelOwnedChallenge);

  shell.joinButton.addEventListener("click", () => {
    const challenge = competitionView().openChallenges.find(
      (candidate) => candidate.creator.id !== selfActor.id,
    );
    if (challenge !== undefined) joinChallenge(challenge.challengeId);
  });

  shell.readyButton.addEventListener("click", () => {
    const session = competitive;
    if (session === null) return;
    session.setReady(true);
    const view = session.view();
    if (activeMatch !== null) {
      try {
        competitionLifecycle.express({
          kind: "set-readiness",
          pairingId: activeMatch.pairingId,
          ready: true,
        });
      } catch {
        // A superseded runtime remains read-only and cannot publish readiness.
      }
      const seatB = activeMatch.participants.seatB;
      shell.setReadiness(view.localReady, view.peerReady, {
        localName: activeMatch.role === "a"
          ? activeMatch.participants.seatA.displayName
          : seatB?.displayName ?? selfActor.displayName,
        opponentName: activeMatch.role === "a"
          ? seatB?.displayName ?? STRINGS["common.playerFallback"]
          : activeMatch.participants.seatA.displayName,
      });
    }
  });

  shell.cancelReadyButton.addEventListener("click", () => {
    const session = competitive;
    if (session === null) return;
    session.setReady(false);
    const view = session.view();
    if (activeMatch !== null) {
      try {
        competitionLifecycle.express({
          kind: "set-readiness",
          pairingId: activeMatch.pairingId,
          ready: false,
        });
      } catch {
        // A superseded runtime remains read-only and cannot publish readiness.
      }
      const seatB = activeMatch.participants.seatB;
      shell.setReadiness(view.localReady, view.peerReady, {
        localName: activeMatch.role === "a"
          ? activeMatch.participants.seatA.displayName
          : seatB?.displayName ?? selfActor.displayName,
        opponentName: activeMatch.role === "a"
          ? seatB?.displayName ?? STRINGS["common.playerFallback"]
          : activeMatch.participants.seatA.displayName,
      });
    }
  });

  const setPracticePaused = (paused: boolean): void => {
    if (practice === null) return;
    practicePaused = paused;
    practice.setPaused(paused);
    if (paused) audio.pauseMusic();
    else audio.resumeMusic();
    setInputsEnabled(!paused);
  };

  const setPracticePauseReason = (
    reason: "menu" | "visibility" | "webgl" | "pairing",
    active: boolean,
  ): void => {
    if (active) practicePauseReasons.add(reason);
    else practicePauseReasons.delete(reason);
    setPracticePaused(practicePauseReasons.size > 0);
  };

  const openMatchMenu = (): void => {
    if (matchMenuOpen || (mode !== "practice" && mode !== "competitive" && mode !== "spectator")) {
      return;
    }
    matchMenuOpen = true;
    hidePowerTip();
    if (mode === "practice") {
      setPracticePauseReason("menu", true);
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
      setPracticePauseReason("menu", false);
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
    const phase = session?.view().phase;
    const started = phase === "countdown" ||
      phase === "playing" ||
      phase === "network-pause" ||
      phase === "finished" ||
      match?.committedConfigHash !== undefined;
    if (session !== null && started) {
      try {
        await settleExplicitForfeit(session);
      } catch {
        // The canonical durable fallback was queued in settleExplicitForfeit.
      }
    }
    if (match !== null && match.role !== "spectator" && !started) {
      leaveStartingPairing(match.pairingId);
    }
    showHome();
    shell.leaveMatchButton.disabled = false;
    shell.resultsLeaveButton.disabled = false;
    shell.rematchButton.disabled = false;
    leaveInProgress = false;
  };
  shell.leaveMatchButton.addEventListener("click", () => void leaveChallenge());
  shell.leavePairingButton.addEventListener("click", () => void leaveChallenge());
  shell.resultsHomeButton.addEventListener("click", showHome);

  const requestRematch = (): void => {
    const resultView = displayedResult;
    if (resultView === null) return;
    const requestPending = competitionLifecycle.current().intents.some(
      (entry) => !entry.settled &&
        entry.intent.kind === "request-rematch" &&
        entry.intent.afterMatchId === resultView.matchId,
    );
    if (requestPending) return;
    const view = competitionView();
    if (view.activity.kind !== "idle") return;
    const playerIds = resultView.result.players.map((player) => player.id);
    if (!playerIds.includes(selfActor.id)) return;
    const pending = rematchForResult(resultView, view);
    if (pending !== undefined && !pending.requestedByPlayerIds.includes(selfActor.id)) {
      acceptPendingRematch(resultView.matchId);
      return;
    }
    try {
      competitionLifecycle.express({
        kind: "request-rematch",
        afterMatchId: resultView.matchId,
      });
      shell.setRematchAction("pending");
    } catch {
      // A concurrent rematch transition will be reflected by the next snapshot.
    }
  };
  shell.requestRematchButton.addEventListener("click", requestRematch);
  shell.newChallengeButton.addEventListener("click", () => {
    if (competitionView().activity.kind !== "idle") return;
    createChallenge();
    showHome();
  });
  shell.practiceAgainButton.addEventListener("click", startPractice);
  shell.practiceCreateChallengeButton.addEventListener("click", () => {
    createChallenge();
    showHome();
  });
  shell.practiceHomeButton.addEventListener("click", showHome);

  const cancelInterruptedPairing = (): void => {
    if (interruptedPairing === null) return;
    leaveStartingPairing(interruptedPairing.pairingId);
  };
  shell.cancelPairingButton.addEventListener("click", cancelInterruptedPairing);
  shell.watchRecoveryMatchButton.addEventListener("click", () => {
    const recovery = passiveLiveRecovery;
    if (recovery !== null) watchMatch(recovery.matchId);
  });
  shell.exitWatchButton.addEventListener("click", showHome);
  shell.goToMatchButton.addEventListener("click", () => {
    const pairing = interruptedPairing;
    if (pairing === null) return;
    showLobby();
    reconcileLobby();
  });

  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    if (hidden) {
      audio.pauseMusic();
      autoGraphics.noteSuspension();
      renderer?.noteSuspension();
      if (passiveLiveRecovery !== null) {
        if (passiveLiveRecovery.tickTimer !== null) {
          window.clearTimeout(passiveLiveRecovery.tickTimer);
          passiveLiveRecovery.tickTimer = null;
        }
      }
    } else {
      const recovery = passiveLiveRecovery;
      if (recovery !== null) {
        const watchedMatch = mode === "spectator" && activeMatch?.role === "spectator"
          ? activeMatch
          : null;
        spectator?.channel.leave?.();
        spectator = null;
        realtimeHub?.close();
        realtimeHub = null;
        ensureRealtimeHub();
        if (watchedMatch !== null) spectator = spectatorRuntime(watchedMatch);
        recovery.observedAtMs = performance.now();
        recovery.seatASeenAtMs = null;
        recovery.seatBSeenAtMs = null;
        recovery.hubRetryAttempts = 0;
        refreshPassiveLiveRecovery();
      }
    }
    if (mode === "practice" && practice !== null) {
      if (hidden) {
        setPracticePauseReason("visibility", true);
        matchMenuOpen = true;
        setMatchMenu(shell, "practice", true);
      } else {
        setPracticePauseReason("visibility", false);
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
    if (document.visibilityState !== "hidden" && preferences.graphics === "auto") {
      const tier = autoGraphics.tier;
      autoGraphics.observeFrame(now);
      if (autoGraphics.tier !== tier) applyGraphicsPlan();
    }
    const elapsed = Math.min(250, Math.max(0, now - lastFrameMs));
    lastFrameMs = now;
    if (!presentationCadence.shouldPresent(mode, now)) {
      window.requestAnimationFrame(renderFrame);
      return;
    }
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
      const seatB = activeMatch.participants.seatB;
      const localName = activeMatch.role === "a" ? activeMatch.participants.seatA.displayName : seatB?.displayName ?? selfActor.displayName;
      const peerName = activeMatch.role === "a"
        ? seatB?.displayName ?? STRINGS["common.playerFallback"]
        : activeMatch.participants.seatA.displayName;
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
    } else if (mode === "spectator" && spectator !== null && activeMatch !== null) {
      stopGlitchPreview();
      const seatB = activeMatch.participants.seatB;
      const previousLeft = spectatorLeftCache?.matchId === activeMatch.matchId
        ? spectatorLeftCache
        : null;
      const nextLeft = spectator.snapshots.latestAfter(
        activeMatch.participants.seatA.playerId,
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
      const snapshotAgeMs = spectator.lastSnapshotAtMs === null
        ? null
        : Math.max(0, performance.now() - spectator.lastSnapshotAtMs);
      if (snapshotAgeMs === null) {
        shell.setReadOnlyWatchStatus({ kind: "waiting" });
      } else if (snapshotAgeMs >= RULES.network.missingPeerMs) {
        shell.setReadOnlyWatchStatus({
          kind: "stale",
          ageSeconds: snapshotAgeMs / 1_000,
        });
      } else {
        shell.setReadOnlyWatchStatus({ kind: "live" });
      }
      const leftConcealed = left?.concealed ?? false;
      const rightConcealed = right?.concealed ?? false;
      leftBoard = left?.board ?? null;
      rightBoard = right?.board ?? null;
      updateHud(
        shell.left,
        activeMatch.participants.seatA.displayName,
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
        (!activeMatch.duplicateRuntime || activeMatch.recoveryWatch === true) &&
        (left !== undefined || right !== undefined)
      ) {
        setElementHidden(shell.overlay, true);
      }
    }
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
    );
    window.requestAnimationFrame(renderFrame);
  };

  if (import.meta.env.DEV) {
    type PracticeAcidRainTestState = {
      readonly tick: number | null;
      readonly activeSource: string | null;
      readonly presentationKinds: readonly string[];
    };
    const testHookWindow = window as unknown as {
      __splitStackPracticeAcidRain: {
        spawn: () => void;
        read: () => PracticeAcidRainTestState;
      };
    };
    testHookWindow.__splitStackPracticeAcidRain = {
      spawn: () => {
        if (mode !== "practice" || practice === null) {
          throw new Error("Practice must be active before spawning Acid Rain");
        }
        processEffects(practice.activatePower("acid-rain"));
        processEffects(practice.tick(RULES.timing.powerImpactTicks));
        for (let attempts = 0; attempts < 3; attempts += 1) {
          if (practice.readSnapshot().player.active?.descriptor.source === "acid") return;
          processEffects(practice.dispatchWithResult("hard-drop").effects);
        }
        throw new Error("Acid Rain did not spawn an Acid projectile");
      },
      read: () => ({
        tick: practice?.currentTick() ?? null,
        activeSource: practice?.readSnapshot().player.active?.descriptor.source ?? null,
        presentationKinds: presentationTimeline.frameAt(performance.now()).effects.map(
          (effect) => effect.kind,
        ),
      }),
    };
  }

  shell.createButton.disabled = !realtimeAvailable;
  shell.joinButton.disabled = true;
  shell.lobbyStatus.textContent = !realtimeAvailable
    ? STRINGS["lobby.realtimeUnavailable"]
    : renderer === null
      ? STRINGS["match.unsupportedWebgl"]
      : "";
  shell.matchMenuButton.hidden = true;
  shell.show("home");
  renderCompetitionState();
  setInputsEnabled(false);
  window.requestAnimationFrame(renderFrame);
  window.setInterval(() => {
    publishWaitingPresence();
    renderCompetitionState();
  }, PRESENCE_HEARTBEAT_MS);

  if (host !== undefined) {
    renderCompetitionState();
    const viewBeforeRouting = competitionView();
    const ownedStartingRoutePriority = viewBeforeRouting.activity.kind === "starting";
    reconcileLobby();
    publishWaitingPresence();

    const routeHash = window.location.hash;
    const recognizedRoute = isRecognizedAppRouteHash(routeHash);
    if (recognizedRoute) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }

    if (recognizedRoute && !ownedStartingRoutePriority) {
      const view = competitionView();
      const syntacticRoute = parseAppRoute(routeHash);
      const route = parseAppRoute(routeHash, {
        challengeExists: (challengeId) => view.openChallenges.some(
          (challenge) => challenge.challengeId === challengeId,
        ),
        liveMatchExists: (matchId) => view.liveMatches.some(
          (match) => match.matchId === matchId,
        ),
        resultExists: (matchId) => view.recentResults.some(
          (result) => result.matchId === matchId,
        ),
        rulesHashIsCurrent: (rulesHash) => rulesHash === RULES_HASH,
      });
      const sameRoute = (() => {
        if (syntacticRoute.screen !== route.screen) return false;
        if (syntacticRoute.screen === "lobby" && route.screen === "lobby") {
          return syntacticRoute.challengeId === route.challengeId;
        }
        if (syntacticRoute.screen === "match" && route.screen === "match") {
          return syntacticRoute.matchId === route.matchId;
        }
        if (syntacticRoute.screen === "result" && route.screen === "result") {
          return syntacticRoute.matchId === route.matchId;
        }
        if (
          syntacticRoute.screen === "practice-leaderboard" &&
          route.screen === "practice-leaderboard"
        ) {
          return syntacticRoute.rulesHash === route.rulesHash;
        }
        return true;
      })();
      const fragment = routeHash.startsWith("#") ? routeHash.slice(1) : routeHash;
      const syntacticTarget = syntacticRoute.screen === "match" ||
        syntacticRoute.screen === "result" ||
        syntacticRoute.screen === "practice-leaderboard" ||
        (syntacticRoute.screen === "lobby" && syntacticRoute.challengeId !== undefined);
      const malformedRecognizedRoute = fragment !== "home" &&
        fragment !== "lobby" &&
        !syntacticTarget;
      const staleRoute = malformedRecognizedRoute || !sameRoute;

      if (staleRoute) {
        showLobby();
        shell.lobbyStatus.textContent = STRINGS["lobby.staleLink"];
        window.setTimeout(() => {
          if (shell.lobbyStatus.textContent !== STRINGS["lobby.staleLink"]) return;
          shell.lobbyStatus.textContent = "";
          renderCompetitionState();
        }, STALE_ROUTE_NOTICE_MS);
      } else if (route.screen === "home") {
        showHome();
      } else if (route.screen === "lobby" || route.screen === "practice-leaderboard") {
        showLobby();
        if (route.screen === "lobby" && route.challengeId !== undefined) {
          const target = [...shell.openChallenges.querySelectorAll<HTMLElement>(
            "[data-challenge-id]",
          )].find((candidate) => candidate.dataset.challengeId === route.challengeId);
          target?.scrollIntoView({ block: "nearest" });
        }
      } else if (route.screen === "match") {
        if (view.activity.kind === "live" && view.activity.matchId === route.matchId) {
          showHome();
        } else {
          watchMatch(route.matchId);
        }
      } else if (route.screen === "result") {
        const entry = view.recentResults.find((result) => result.matchId === route.matchId);
        if (entry !== undefined) {
          const localPlayerId = entry.result.players.some(
            (player) => player.id === selfActor.id,
          )
            ? selfActor.id
            : null;
          showResult(entry.result, localPlayerId, entry);
        }
      }
    }
  }
}
