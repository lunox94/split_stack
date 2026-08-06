import { RULES } from "../config/rules";
import { STRINGS, formatString, type StringKey } from "../app/strings";
import type { PieceDescriptor, PowerKind, SpecialKind } from "../domain/types";
import type { Preferences } from "../persistence/settings";
import { POWER_ACCENT_COLORS, createPowerIcon } from "../render/power-icons";
import { createSpecialIcon } from "../render/special-icons";
import type { BoardViewport, RendererLayout } from "../render/renderer";
import {
  createMarkedCellSample,
  renderPiecePreviewSlot,
  type PiecePreviewOptions,
} from "./piece-preview";

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(document: Document, label: string, className?: string): HTMLButtonElement {
  const node = element(document, "button", className, label);
  node.type = "button";
  return node;
}

function menuScreen(document: Document, heading: string): {
  screen: HTMLElement;
  panel: HTMLElement;
  heading: HTMLHeadingElement;
} {
  const screen = element(document, "section", "screen menu-screen");
  const panel = element(document, "div", "menu-panel");
  const headingNode = element(document, "h2", undefined, heading);
  screen.append(panel);
  panel.append(headingNode);
  return { screen, panel, heading: headingNode };
}

export interface HudElements {
  pane: HTMLElement;
  root: HTMLElement;
  boardTarget: HTMLElement;
  name: HTMLElement;
  score: HTMLElement;
  level: HTMLElement;
  lines: HTMLElement;
  hold: HTMLElement;
  preview: HTMLElement;
  upcomingPower: HTMLElement;
  incoming: HTMLElement;
  incomingCount: HTMLElement;
  meter: HTMLElement;
  meterSegments: readonly HTMLElement[];
  statuses: HTMLElement;
  blackout: HTMLElement;
  setPiecePreviews(
    hold: PieceDescriptor | null,
    next: readonly PieceDescriptor[],
    options: PiecePreviewOptions,
  ): void;
}

function createHud(document: Document, side: "left" | "right"): HudElements {
  const pane = element(document, "section", "player-pane");
  pane.dataset.side = side;
  const boardTarget = element(document, "div", "board-hit-target");
  boardTarget.dataset.interactive = "true";
  boardTarget.setAttribute("role", "application");
  boardTarget.setAttribute(
    "aria-label",
    side === "left" ? STRINGS["match.localBoard"] : STRINGS["match.opponentBoard"],
  );
  const hud = element(document, "div", "player-hud");
  hud.dataset.side = side;
  const name = element(document, "span", "player-name", "—");
  const topInfo = element(document, "div", "hud-top-info");
  const stats = element(document, "div", "hud-stats");
  const stat = (label: string, shortLabel: string, initial: string): HTMLElement => {
    const item = element(document, "span", "hud-stat");
    const accessibleLabel = element(
      document,
      "span",
      "sr-only hud-stat-accessible-label",
      label,
    );
    const fullLabel = element(
      document,
      "span",
      "hud-stat-label hud-stat-label-full",
      label,
    );
    fullLabel.setAttribute("aria-hidden", "true");
    const compactLabel = element(
      document,
      "span",
      "hud-stat-label-short",
      shortLabel,
    );
    compactLabel.setAttribute("aria-hidden", "true");
    const value = element(document, "span", "hud-stat-value", initial);
    item.append(
      accessibleLabel,
      fullLabel,
      compactLabel,
      value,
    );
    stats.append(item);
    return value;
  };
  const score = stat(STRINGS["hud.score"], STRINGS["hud.scoreShort"], "0");
  const level = stat(STRINGS["hud.level"], STRINGS["hud.levelShort"], "1");
  const lines = stat(STRINGS["hud.lines"], STRINGS["hud.linesShort"], "0");
  topInfo.append(name, stats);
  const hold = element(
    document,
    "section",
    "piece-preview-group hold-preview is-unboxed",
  );
  hold.setAttribute("aria-label", STRINGS["hud.hold"]);
  const holdLabel = element(document, "span", "piece-preview-label", STRINGS["hud.hold"]);
  const holdSlot = element(document, "div", "piece-preview-slot is-hold");
  hold.append(holdLabel, holdSlot);
  const preview = element(
    document,
    "section",
    "piece-preview-group next-preview is-unboxed",
  );
  preview.setAttribute("aria-label", STRINGS["hud.next"]);
  const previewLabel = element(
    document,
    "span",
    "piece-preview-label",
    STRINGS["hud.next"],
  );
  const previewSlots = element(document, "div", "piece-preview-slots");
  const nextSlots = Array.from({ length: 5 }, (_, index) => {
    const slot = element(
      document,
      "div",
      `piece-preview-slot ${index === 0 ? "is-primary" : "is-queued"}`,
    );
    slot.dataset.position = String(index + 1);
    previewSlots.append(slot);
    return slot;
  });
  preview.append(previewLabel, previewSlots);
  const upcomingPower = element(document, "div", "upcoming-power-icon");
  upcomingPower.setAttribute("role", "img");
  upcomingPower.setAttribute("aria-label", STRINGS["hud.upcomingPower"]);
  const incoming = element(document, "div", "incoming-garbage");
  incoming.setAttribute("role", "img");
  incoming.dataset.state = "empty";
  incoming.setAttribute("aria-label", `${STRINGS["hud.incomingGarbage"]}: 0`);
  const incomingIcon = createSpecialIcon(
    document,
    "garbage-core",
    STRINGS["hud.incomingGarbage"],
  );
  incomingIcon.setAttribute("aria-hidden", "true");
  incomingIcon.removeAttribute("role");
  const incomingCount = element(document, "span", "incoming-garbage-count", "0");
  incoming.append(incomingIcon, incomingCount);
  const meter = element(document, "div", "power-meter");
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-label", STRINGS["hud.power"]);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", String(RULES.power.threshold));
  const meterSegments = Array.from({ length: RULES.power.threshold }, (_, index) => {
    const segment = element(document, "span", "power-meter-segment");
    segment.dataset.charge = String(index + 1);
    meter.append(segment);
    return segment;
  });
  const powerRail = element(document, "div", "power-rail");
  powerRail.append(upcomingPower, meter, incoming);
  hud.append(topInfo, hold, preview, powerRail);
  const statuses = element(document, "div", "status-row");
  statuses.setAttribute("role", "group");
  statuses.setAttribute("aria-label", "Active powers");
  const blackout = element(
    document,
    "div",
    "blackout-cover",
    STRINGS["match.blackoutCover"],
  );
  blackout.hidden = true;
  hud.append(statuses);
  pane.append(boardTarget, blackout, hud);
  const setPiecePreviews = (
    held: PieceDescriptor | null,
    next: readonly PieceDescriptor[],
    options: PiecePreviewOptions,
  ): void => {
    renderPiecePreviewSlot(holdSlot, held, options);
    for (let index = 0; index < nextSlots.length; index += 1) {
      renderPiecePreviewSlot(nextSlots[index]!, next[index] ?? null, options);
    }
  };
  const initialPreviewOptions: PiecePreviewOptions = {
    colorPalette: "standard",
    reducedMotion: false,
    reducedFlashes: false,
    elapsedMs: 0,
  };
  setPiecePreviews(null, [], initialPreviewOptions);
  return {
    pane,
    root: hud,
    boardTarget,
    name,
    score,
    level,
    lines,
    hold,
    preview,
    upcomingPower,
    incoming,
    incomingCount,
    meter,
    meterSegments,
    statuses,
    blackout,
    setPiecePreviews,
  };
}

export function positionHudToViewport(
  hud: HudElements,
  viewport: BoardViewport,
): void {
  const boardLeft = viewport.boardX - viewport.paneX;
  hud.root.style.left = `${boardLeft}px`;
  hud.root.style.top = `${viewport.boardY}px`;
  hud.root.style.width = `${viewport.boardWidth}px`;
  hud.root.style.height = `${viewport.boardHeight}px`;
  hud.root.style.setProperty("--hud-top-height", `${viewport.hud.header.height}px`);
  hud.root.style.setProperty(
    "--hud-preview-scale",
    String(Math.min(1, viewport.boardWidth / 116)),
  );
  hud.pane.dataset.hudCompact = String(viewport.hud.header.height <= 64);
  hud.pane.dataset.hudLabels = viewport.boardWidth < 220 ? "short" : "full";
  hud.pane.removeAttribute("data-hud-top");
  hud.pane.removeAttribute("data-status-placement");
}

export function positionGameplayTip(
  shell: AppShell,
  layout: RendererLayout,
): void {
  const viewport = layout.left;
  const arenaLeft = shell.arena.offsetLeft;
  const arenaTop = shell.arena.offsetTop;
  const topSpace = Math.max(0, layout.frame.y);
  const bottomSpace = Math.max(0, layout.height - (layout.frame.y + layout.frame.height));
  const outerSpace = Math.max(0, layout.frame.x);
  const placement = topSpace >= 128
    ? "above"
    : bottomSpace >= 104
      ? "below"
      : outerSpace >= 224
        ? "outer"
        : "inside";
  shell.match.dataset.tipPlacement = placement;
  shell.match.style.setProperty(
    "--tip-frame-left",
    `${arenaLeft + layout.frame.x}px`,
  );
  shell.match.style.setProperty(
    "--tip-frame-top",
    `${arenaTop + layout.frame.y}px`,
  );
  shell.match.style.setProperty(
    "--tip-frame-bottom",
    `${arenaTop + layout.frame.y + layout.frame.height}px`,
  );
  shell.match.style.setProperty(
    "--tip-board-left",
    `${arenaLeft + viewport.boardX}px`,
  );
  shell.match.style.setProperty(
    "--tip-board-top",
    `${arenaTop + viewport.boardY}px`,
  );
  shell.match.style.setProperty("--tip-board-width", `${viewport.boardWidth}px`);
  shell.match.style.setProperty(
    "--tip-board-bottom",
    `${arenaTop + viewport.boardY + viewport.boardHeight}px`,
  );
  shell.match.style.setProperty(
    "--tip-outer-space",
    `${arenaLeft + outerSpace}px`,
  );
}

export function positionMatchMenuButton(
  shell: AppShell,
  layout: RendererLayout,
): void {
  const arenaLeft = shell.arena.offsetLeft;
  const arenaTop = shell.arena.offsetTop;
  const buttonRadius = 22;
  const buttonGap = 8;
  const safeGutter = 8;
  const top = arenaTop + layout.frame.y +
    (layout.topHudHeight - buttonRadius * 2) / 2;
  const nextPreviewWidth = layout.compactTopHud ? 78 : 92;
  const headerPreviewSpace =
    layout.left.boardWidth / 2 - buttonRadius - 4;
  const fitsHeader = headerPreviewSpace >= nextPreviewWidth;
  const fitsOuter = layout.frame.x >=
    buttonRadius * 2 + buttonGap + safeGutter;
  let centerX: number;
  let placement: "corridor" | "header" | "outer";

  if (layout.centerCorridor !== null) {
    centerX = arenaLeft + layout.centerCorridor.x + layout.centerCorridor.width / 2;
    placement = "corridor";
  } else if (!fitsHeader && fitsOuter) {
    centerX = arenaLeft + layout.frame.x - buttonGap - buttonRadius;
    placement = "outer";
  } else {
    centerX = arenaLeft + layout.left.hud.header.x + layout.left.hud.header.width / 2;
    placement = "header";
    if (!fitsHeader) {
      const currentScale = Math.min(1, layout.left.boardWidth / 116);
      const fittingScale = Math.max(0, headerPreviewSpace / nextPreviewWidth);
      shell.left.root.style.setProperty(
        "--hud-preview-scale",
        String(Math.min(currentScale, fittingScale)),
      );
    }
  }

  shell.matchActions.style.left = `${centerX}px`;
  shell.matchActions.style.top = `${top}px`;
  shell.match.dataset.menuPlacement = placement;
}

export interface SettingsInputs {
  effectsEnabled: HTMLInputElement;
  effectsVolume: HTMLInputElement;
  musicEnabled: HTMLInputElement;
  musicVolume: HTMLInputElement;
  vibration: HTMLInputElement;
  touchControls: HTMLSelectElement;
  colorPalette: HTMLSelectElement;
  reducedMotion: HTMLInputElement;
  reducedFlashes: HTMLInputElement;
  reducedEffects: HTMLInputElement;
  screenShake: HTMLInputElement;
  gameplayTips: HTMLInputElement;
}

function checkboxSetting(
  document: Document,
  parent: HTMLElement,
  labelText: string,
): HTMLInputElement {
  const label = element(document, "label", "setting-row");
  const text = element(document, "span", undefined, labelText);
  const input = element(document, "input");
  input.type = "checkbox";
  label.append(text, input);
  parent.append(label);
  return input;
}

export interface AppShell {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  lobby: HTMLElement;
  practiceButton: HTMLButtonElement;
  createButton: HTMLButtonElement;
  joinButton: HTMLButtonElement;
  helpButton: HTMLButtonElement;
  controlsHelpButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  lobbyStatus: HTMLElement;
  history: HTMLElement;
  help: HTMLElement;
  helpHeading: HTMLElement;
  helpBody: HTMLElement;
  helpBack: HTMLButtonElement;
  settings: HTMLElement;
  settingsInputs: SettingsInputs;
  diagnosticsCopyButton: HTMLButtonElement;
  diagnosticsClearButton: HTMLButtonElement;
  diagnosticsStatus: HTMLElement;
  settingsBack: HTMLButtonElement;
  match: HTMLElement;
  arena: HTMLElement;
  left: HudElements;
  right: HudElements;
  readinessPanel: HTMLElement;
  readyButton: HTMLButtonElement;
  cancelReadyButton: HTMLButtonElement;
  localReadyStatus: HTMLElement;
  opponentReadyStatus: HTMLElement;
  matchActions: HTMLElement;
  matchMenuButton: HTMLButtonElement;
  matchMenu: HTMLElement;
  matchMenuMessage: HTMLElement;
  matchMenuCloseButton: HTMLButtonElement;
  leaveMatchButton: HTMLButtonElement;
  gameplayTip: HTMLElement;
  gameplayTipAnnouncement: HTMLElement;
  overlay: HTMLElement;
  overlayText: HTMLElement;
  touchButtons: HTMLElement;
  unsupported: HTMLElement;
  results: HTMLElement;
  resultsHeading: HTMLElement;
  resultsStats: HTMLElement;
  rematchButton: HTMLButtonElement;
  resultsLeaveButton: HTMLButtonElement;
  show(screen: "lobby" | "help" | "settings" | "match" | "results"): void;
  setPreferences(preferences: Preferences): void;
  setReadiness(localReady: boolean, opponentReady: boolean): void;
  setOverlayMessage(
    message: string,
    presentation?: "modal" | "banner" | "status",
  ): void;
  setScrambled(active: boolean): void;
}

export function createAppShell(document: Document, mount: HTMLElement): AppShell {
  const container = element(document, "main", "split-stack-app");
  container.setAttribute("aria-label", STRINGS["app.name"]);
  const canvas = element(document, "canvas", "game-canvas");
  canvas.setAttribute("aria-hidden", "true");
  const layer = element(document, "div", "app-layer");

  const lobbyParts = menuScreen(document, STRINGS["lobby.heading"]);
  lobbyParts.heading.className = "brand-title";
  const subtitle = element(document, "p", "brand-subtitle", STRINGS["app.description"]);
  const lobbyStatus = element(document, "p", "muted");
  lobbyStatus.setAttribute("role", "status");
  const lobbyActions = element(document, "div", "menu-actions");
  const createButton = button(document, STRINGS["lobby.createChallenge"], "primary");
  const joinButton = button(document, STRINGS["lobby.joinChallenge"]);
  const practiceButton = button(document, STRINGS["lobby.practice"]);
  lobbyActions.append(createButton, joinButton, practiceButton);
  const secondary = element(document, "div", "secondary-actions");
  const helpButton = button(document, STRINGS["lobby.howToPlay"]);
  const controlsHelpButton = button(document, STRINGS["lobby.practiceControls"]);
  const settingsButton = button(document, STRINGS["lobby.settings"]);
  secondary.append(helpButton, controlsHelpButton, settingsButton);
  const historyHeading = element(document, "h3", undefined, STRINGS["lobby.history"]);
  const history = element(document, "ul", "history-list");
  lobbyParts.panel.append(
    subtitle,
    lobbyStatus,
    lobbyActions,
    secondary,
    historyHeading,
    history,
  );

  const helpParts = menuScreen(document, STRINGS["help.heading"]);
  const helpBody = element(document, "div", "help-copy");
  const helpBack = button(document, STRINGS["common.back"]);
  helpParts.panel.append(helpBody, helpBack);

  const settingsParts = menuScreen(document, STRINGS["settings.heading"]);
  const settingsList = element(document, "div", "settings-list");
  const effectsEnabled = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.effects"],
  );
  const effectsVolumeLabel = element(document, "label", "setting-row");
  effectsVolumeLabel.append(
    element(document, "span", undefined, STRINGS["settings.effectsVolume"]),
  );
  const effectsVolume = element(document, "input");
  effectsVolume.type = "range";
  effectsVolume.min = "0";
  effectsVolume.max = "1";
  effectsVolume.step = "0.05";
  effectsVolumeLabel.append(effectsVolume);
  settingsList.append(effectsVolumeLabel);
  const musicEnabled = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.music"],
  );
  const musicVolumeLabel = element(document, "label", "setting-row");
  musicVolumeLabel.append(
    element(document, "span", undefined, STRINGS["settings.musicVolume"]),
  );
  const musicVolume = element(document, "input");
  musicVolume.type = "range";
  musicVolume.min = "0";
  musicVolume.max = "1";
  musicVolume.step = "0.05";
  musicVolumeLabel.append(musicVolume);
  settingsList.append(musicVolumeLabel);
  const vibration = checkboxSetting(document, settingsList, STRINGS["settings.vibration"]);
  const touchLabel = element(document, "label", "setting-row");
  touchLabel.append(element(document, "span", undefined, STRINGS["settings.controls"]));
  const touchControls = element(document, "select");
  const gestureOption = element(document, "option", undefined, STRINGS["settings.gestures"]);
  gestureOption.value = "gestures";
  const buttonOption = element(document, "option", undefined, STRINGS["settings.buttons"]);
  buttonOption.value = "buttons";
  touchControls.append(gestureOption, buttonOption);
  touchLabel.append(touchControls);
  settingsList.append(touchLabel);
  const paletteLabel = element(document, "label", "setting-row");
  paletteLabel.append(element(document, "span", undefined, STRINGS["settings.palette"]));
  const colorPalette = element(document, "select");
  const standardPalette = element(
    document,
    "option",
    undefined,
    STRINGS["settings.standardPalette"],
  );
  standardPalette.value = "standard";
  const colorblindPalette = element(
    document,
    "option",
    undefined,
    STRINGS["settings.colorblindPalette"],
  );
  colorblindPalette.value = "colorblind";
  colorPalette.append(standardPalette, colorblindPalette);
  paletteLabel.append(colorPalette);
  settingsList.append(paletteLabel);
  const reducedMotion = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.reducedMotion"],
  );
  const reducedFlashes = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.reducedFlashes"],
  );
  const reducedEffects = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.reducedEffects"],
  );
  const screenShake = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.screenShake"],
  );
  const gameplayTips = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.gameplayTips"],
  );
  const diagnostics = element(document, "section", "diagnostics-settings");
  diagnostics.append(
    element(document, "h3", undefined, STRINGS["settings.diagnosticsReady"]),
  );
  const diagnosticsActions = element(document, "div", "secondary-actions");
  const diagnosticsCopyButton = button(
    document,
    STRINGS["settings.copyDiagnostics"],
  );
  const diagnosticsClearButton = button(
    document,
    STRINGS["settings.clearDiagnostics"],
  );
  diagnosticsActions.append(diagnosticsCopyButton, diagnosticsClearButton);
  const diagnosticsStatus = element(document, "p", "muted");
  diagnosticsStatus.setAttribute("aria-live", "polite");
  diagnostics.append(diagnosticsActions, diagnosticsStatus);
  const settingsBack = button(document, STRINGS["common.back"]);
  settingsParts.panel.append(settingsList, diagnostics, settingsBack);

  const match = element(document, "section", "screen");
  match.hidden = true;
  const arena = element(document, "div", "arena");
  arena.dataset.mode = "versus";
  const left = createHud(document, "left");
  const right = createHud(document, "right");
  left.pane.classList.add("is-local");
  right.pane.classList.add("is-remote");
  arena.append(left.pane, right.pane);
  const matchActions = element(document, "div", "match-actions");
  const matchMenuButton = button(document, "☰", "match-menu-button");
  matchMenuButton.setAttribute("aria-label", STRINGS["match.menu"]);
  matchMenuButton.setAttribute("aria-haspopup", "dialog");
  matchMenuButton.setAttribute("aria-expanded", "false");
  matchMenuButton.hidden = true;
  matchActions.append(matchMenuButton);
  const matchMenu = element(document, "section", "match-menu-popover");
  matchMenu.setAttribute("role", "dialog");
  matchMenu.setAttribute("aria-modal", "false");
  matchMenu.setAttribute("aria-labelledby", "match-menu-heading");
  matchMenu.setAttribute("aria-describedby", "match-menu-message");
  matchMenu.hidden = true;
  const matchMenuHeading = element(
    document,
    "h2",
    "match-menu-heading",
    STRINGS["match.menu"],
  );
  matchMenuHeading.id = "match-menu-heading";
  const matchMenuMessage = element(document, "p", "match-menu-message");
  matchMenuMessage.id = "match-menu-message";
  const matchMenuCloseButton = button(
    document,
    STRINGS["match.returnToMatch"],
    "primary",
  );
  const leaveMatchButton = button(document, STRINGS["results.leave"]);
  matchMenu.append(
    matchMenuHeading,
    matchMenuMessage,
    matchMenuCloseButton,
    leaveMatchButton,
  );
  const gameplayTip = element(document, "aside", "gameplay-tip");
  gameplayTip.setAttribute("aria-hidden", "true");
  gameplayTip.hidden = true;
  const gameplayTipAnnouncement = element(
    document,
    "div",
    "sr-only gameplay-tip-announcement",
  );
  gameplayTipAnnouncement.setAttribute("role", "status");
  gameplayTipAnnouncement.setAttribute("aria-live", "polite");
  gameplayTipAnnouncement.setAttribute("aria-atomic", "true");
  const overlay = element(document, "div", "center-overlay");
  overlay.dataset.presentation = "modal";
  const overlayCard = element(document, "div", "center-overlay-card");
  const readinessPanel = element(document, "section", "ready-panel");
  readinessPanel.setAttribute("aria-labelledby", "ready-heading");
  const readyHeading = element(
    document,
    "h2",
    "ready-heading",
    STRINGS["match.readyHeading"],
  );
  readyHeading.id = "ready-heading";
  const readinessStatuses = element(document, "div", "readiness-statuses");
  readinessStatuses.setAttribute("aria-live", "polite");
  const localReadyStatus = element(
    document,
    "p",
    "readiness-status",
    `${STRINGS["match.you"]} · ${STRINGS["match.notReady"]}`,
  );
  localReadyStatus.dataset.player = "local";
  localReadyStatus.dataset.ready = "false";
  const opponentReadyStatus = element(
    document,
    "p",
    "readiness-status",
    `${STRINGS["match.opponent"]} · ${STRINGS["match.notReady"]}`,
  );
  opponentReadyStatus.dataset.player = "opponent";
  opponentReadyStatus.dataset.ready = "false";
  readinessStatuses.append(localReadyStatus, opponentReadyStatus);
  const readyButton = button(document, STRINGS["match.readyUp"], "ready-button primary");
  readyButton.setAttribute("aria-pressed", "false");
  const readyHint = element(document, "p", "ready-hint", STRINGS["match.readyHint"]);
  const cancelReadyButton = button(
    document,
    STRINGS["match.cancelReady"],
    "cancel-ready-button",
  );
  cancelReadyButton.hidden = true;
  readinessPanel.append(
    readyHeading,
    readinessStatuses,
    readyButton,
    readyHint,
    cancelReadyButton,
  );
  const overlayText = element(document, "p", undefined, STRINGS["match.waitingForReady"]);
  overlayText.setAttribute("role", "status");
  overlayText.setAttribute("aria-live", "polite");
  overlayText.hidden = true;
  overlayCard.append(readinessPanel, overlayText);
  overlay.append(overlayCard);
  overlay.hidden = true;
  const touchButtons = element(document, "div", "touch-buttons");
  const controls: Array<[string, StringKey, string]> = [
    ["←", "controls.moveLeft", "move-left"],
    ["↺", "controls.rotateCounterclockwise", "rotate-ccw"],
    ["↻", "controls.rotateClockwise", "rotate-cw"],
    ["→", "controls.moveRight", "move-right"],
    ["↓", "controls.softDrop", "soft-drop"],
    ["⇊", "controls.hardDrop", "hard-drop"],
    ["H", "controls.hold", "hold"],
  ];
  const touchControlNodes = new Map<string, HTMLButtonElement>();
  for (const [symbol, key, action] of controls) {
    const control = button(document, symbol);
    control.dataset.action = action;
    control.setAttribute("aria-label", STRINGS[key]);
    touchButtons.append(control);
    touchControlNodes.set(action, control);
  }
  const unsupported = element(
    document,
    "div",
    "unsupported-notice",
    STRINGS["match.unsupportedWebgl"],
  );
  unsupported.hidden = true;
  match.append(
    arena,
    matchActions,
    matchMenu,
    gameplayTip,
    gameplayTipAnnouncement,
    overlay,
    touchButtons,
    unsupported,
  );

  const resultsParts = menuScreen(document, STRINGS["results.draw"]);
  const resultsStats = element(document, "dl", "results-stats");
  const resultsActions = element(document, "div", "menu-actions");
  const rematchButton = button(document, STRINGS["results.rematch"], "primary");
  const resultsLeaveButton = button(document, STRINGS["results.leave"]);
  resultsActions.append(rematchButton, resultsLeaveButton);
  resultsParts.panel.append(resultsStats, resultsActions);

  layer.append(
    lobbyParts.screen,
    helpParts.screen,
    settingsParts.screen,
    match,
    resultsParts.screen,
  );
  container.append(canvas, layer);
  mount.replaceChildren(container);

  const screens = {
    lobby: lobbyParts.screen,
    help: helpParts.screen,
    settings: settingsParts.screen,
    match,
    results: resultsParts.screen,
  } as const;
  let readinessSignature: string | null = null;

  const shell: AppShell = {
    container,
    canvas,
    lobby: lobbyParts.screen,
    practiceButton,
    createButton,
    joinButton,
    helpButton,
    controlsHelpButton,
    settingsButton,
    lobbyStatus,
    history,
    help: helpParts.screen,
    helpHeading: helpParts.heading,
    helpBody,
    helpBack,
    settings: settingsParts.screen,
    settingsInputs: {
      effectsEnabled,
      effectsVolume,
      musicEnabled,
      musicVolume,
      vibration,
      touchControls,
      colorPalette,
      reducedMotion,
      reducedFlashes,
      reducedEffects,
      screenShake,
      gameplayTips,
    },
    diagnosticsCopyButton,
    diagnosticsClearButton,
    diagnosticsStatus,
    settingsBack,
    match,
    arena,
    left,
    right,
    readinessPanel,
    readyButton,
    cancelReadyButton,
    localReadyStatus,
    opponentReadyStatus,
    matchActions,
    matchMenuButton,
    matchMenu,
    matchMenuMessage,
    matchMenuCloseButton,
    leaveMatchButton,
    gameplayTip,
    gameplayTipAnnouncement,
    overlay,
    overlayText,
    touchButtons,
    unsupported,
    results: resultsParts.screen,
    resultsHeading: resultsParts.heading,
    resultsStats,
    rematchButton,
    resultsLeaveButton,
    show(screen): void {
      for (const [name, node] of Object.entries(screens)) node.hidden = name !== screen;
    },
    setPreferences(preferences): void {
      effectsEnabled.checked = preferences.effectsEnabled;
      effectsVolume.value = String(preferences.effectsVolume);
      musicEnabled.checked = preferences.musicEnabled;
      musicVolume.value = String(preferences.musicVolume);
      vibration.checked = preferences.vibration;
      touchControls.value = preferences.touchControls;
      colorPalette.value = preferences.colorPalette;
      reducedMotion.checked = preferences.reducedMotion;
      reducedFlashes.checked = preferences.reducedFlashes;
      reducedEffects.checked = preferences.reducedEffects;
      screenShake.checked = preferences.screenShake;
      gameplayTips.checked = preferences.gameplayTips;
    },
    setReadiness(localReady, opponentReady): void {
      const signature = `${localReady}:${opponentReady}`;
      if (
        readinessSignature === signature &&
        !readinessPanel.hidden &&
        overlayText.hidden
      ) {
        return;
      }
      readinessSignature = signature;
      if (overlay.dataset.presentation !== "modal") {
        overlay.dataset.presentation = "modal";
      }
      const updateStatus = (
        node: HTMLElement,
        label: string,
        ready: boolean,
      ): void => {
        node.dataset.ready = String(ready);
        node.textContent = `${label} · ${
          ready ? STRINGS["match.ready"] : STRINGS["match.notReady"]
        }`;
      };
      readinessPanel.hidden = false;
      overlayText.hidden = true;
      updateStatus(localReadyStatus, STRINGS["match.you"], localReady);
      updateStatus(opponentReadyStatus, STRINGS["match.opponent"], opponentReady);
      readyButton.textContent = localReady
        ? STRINGS["match.youAreReady"]
        : STRINGS["match.readyUp"];
      readyButton.setAttribute("aria-pressed", String(localReady));
      readyButton.classList.toggle("is-ready", localReady);
      readyButton.disabled = localReady;
      cancelReadyButton.hidden = !localReady;
      readyHint.textContent = localReady
        ? opponentReady
          ? STRINGS["match.bothPlayersReady"]
          : STRINGS["match.waitingForOpponentReady"]
        : STRINGS["match.readyHint"];
    },
    setOverlayMessage(message, presentation = "modal"): void {
      if (overlay.dataset.presentation !== presentation) {
        overlay.dataset.presentation = presentation;
      }
      setElementHidden(readinessPanel, true);
      setElementHidden(overlayText, false);
      if (overlayText.textContent !== message) overlayText.textContent = message;
    },
    setScrambled(active): void {
      arena.dataset.scrambled = String(active);
      const glyphs = active
        ? {
            "move-left": "→",
            "move-right": "←",
            "rotate-ccw": "↻",
            "rotate-cw": "↺",
          }
        : {
            "move-left": "←",
            "move-right": "→",
            "rotate-ccw": "↺",
            "rotate-cw": "↻",
          };
      for (const [action, glyph] of Object.entries(glyphs)) {
        const control = touchControlNodes.get(action);
        if (control !== undefined) control.textContent = glyph;
      }
      touchControlNodes.get("move-left")?.setAttribute(
        "aria-label",
        active ? STRINGS["controls.moveRight"] : STRINGS["controls.moveLeft"],
      );
      touchControlNodes.get("move-right")?.setAttribute(
        "aria-label",
        active ? STRINGS["controls.moveLeft"] : STRINGS["controls.moveRight"],
      );
      touchControlNodes.get("rotate-ccw")?.setAttribute(
        "aria-label",
        active
          ? STRINGS["controls.rotateClockwise"]
          : STRINGS["controls.rotateCounterclockwise"],
      );
      touchControlNodes.get("rotate-cw")?.setAttribute(
        "aria-label",
        active
          ? STRINGS["controls.rotateCounterclockwise"]
          : STRINGS["controls.rotateClockwise"],
      );
    },
  };
  return shell;
}

export type MatchMenuMode = "practice" | "competitive" | "spectator";

export function setMatchMenu(
  shell: AppShell,
  mode: MatchMenuMode,
  open: boolean,
): void {
  shell.matchMenu.dataset.mode = mode;
  shell.matchMenuMessage.textContent = mode === "practice"
    ? STRINGS["match.menuPractice"]
    : STRINGS["match.menuCompetitive"];
  shell.matchMenuCloseButton.textContent = mode === "practice"
    ? STRINGS["controls.resumeShort"]
    : STRINGS["match.returnToMatch"];
  shell.matchMenu.hidden = !open;
  shell.matchMenuButton.setAttribute("aria-expanded", String(open));
}

export function showGameplayPowerTip(
  shell: AppShell,
  power: PowerKind,
  label: string,
  description: string,
): void {
  const document = shell.gameplayTip.ownerDocument;
  const copy = element(document, "div", "gameplay-tip-copy");
  copy.append(
    element(
      document,
      "strong",
      "gameplay-tip-heading",
      formatString("tip.upcomingPower", { power: label }),
    ),
    element(document, "span", "gameplay-tip-description", description),
  );
  shell.gameplayTip.dataset.power = power;
  shell.gameplayTip.replaceChildren(createPowerIcon(document, power, label), copy);
  shell.gameplayTip.hidden = false;
  shell.gameplayTipAnnouncement.textContent = `${formatString(
    "tip.upcomingPower",
    { power: label },
  )}. ${description}`;
}

export function hideGameplayPowerTip(shell: AppShell): void {
  shell.gameplayTip.hidden = true;
}

export function showHelp(shell: AppShell, kind: "how" | "controls"): void {
  const document = shell.helpBody.ownerDocument;
  shell.helpBody.replaceChildren();
  if (kind === "how") {
    shell.helpHeading.textContent = STRINGS["help.heading"];
    for (const key of [
      "help.goal",
      "help.controls",
      "help.powers",
      "help.specialCells",
    ] as const) {
      shell.helpBody.append(element(document, "p", undefined, STRINGS[key]));
    }

    const meterSection = element(document, "section", "help-guide-group");
    meterSection.dataset.helpGroup = "meter";
    meterSection.append(
      element(document, "h3", undefined, STRINGS["help.meterPowersHeading"]),
    );
    const meterGuide = element(document, "div", "power-guide");
    const meterEntries: ReadonlyArray<{
      readonly power: PowerKind;
      readonly name: StringKey;
      readonly description: StringKey;
    }> = [
      { power: "scramble", name: "power.scramble", description: "power.scrambleDescription" },
      { power: "nuke", name: "power.nuke", description: "power.nukeDescription" },
      { power: "collapse", name: "power.collapse", description: "power.collapseDescription" },
      {
        power: "monomino-rush",
        name: "power.monominoRush",
        description: "power.monominoRushDescription",
      },
      { power: "acid-rain", name: "power.acidRain", description: "power.acidRainDescription" },
      { power: "oversize", name: "power.oversize", description: "power.oversizeDescription" },
      { power: "ghost-jam", name: "power.ghostJam", description: "power.ghostJamDescription" },
    ];
    for (const entry of meterEntries) {
      const card = element(document, "article", "power-guide-card");
      const copy = element(document, "div");
      copy.append(
        element(document, "h4", undefined, STRINGS[entry.name]),
        element(document, "p", undefined, STRINGS[entry.description]),
      );
      card.append(createPowerIcon(document, entry.power, STRINGS[entry.name]), copy);
      meterGuide.append(card);
    }
    meterSection.append(meterGuide);

    const markedSection = element(document, "section", "help-guide-group");
    markedSection.dataset.helpGroup = "marked";
    markedSection.append(
      element(document, "h3", undefined, STRINGS["help.markedPowersHeading"]),
    );
    const specials = element(document, "div", "special-guide");
    const specialEntries: ReadonlyArray<{
      readonly special: SpecialKind;
      readonly name: StringKey;
      readonly description: StringKey;
    }> = [
      {
        special: "column-bomb",
        name: "special.columnBomb",
        description: "special.columnBombDescription",
      },
      {
        special: "garbage-core",
        name: "special.garbageCore",
        description: "special.garbageCoreDescription",
      },
      {
        special: "glitch-core",
        name: "special.glitchCore",
        description: "special.glitchCoreDescription",
      },
      {
        special: "blackout",
        name: "power.blackout",
        description: "special.blackoutDescription",
      },
      {
        special: "barrier",
        name: "power.barrier",
        description: "special.barrierDescription",
      },
    ];
    for (const entry of specialEntries) {
      const card = element(document, "article", "special-guide-card");
      const copy = element(document, "div");
      copy.append(
        element(document, "h4", undefined, STRINGS[entry.name]),
        element(document, "p", undefined, STRINGS[entry.description]),
      );
      card.append(
        createMarkedCellSample(
          document,
          entry.special,
          shell.container.dataset.palette === "colorblind"
            ? "colorblind"
            : "standard",
        ),
        copy,
      );
      specials.append(card);
    }
    markedSection.append(specials);

    const piecesSection = element(document, "section", "help-guide-group");
    piecesSection.dataset.helpGroup = "pieces";
    piecesSection.append(
      element(document, "h3", undefined, STRINGS["help.specialPiecesHeading"]),
    );
    const pieces = element(document, "div", "special-guide");
    const pieceEntries: ReadonlyArray<{
      readonly descriptor: PieceDescriptor;
      readonly name: StringKey;
      readonly description: StringKey;
    }> = [
      {
        descriptor: { source: "cross", shape: "cross" },
        name: "help.hollowCross",
        description: "help.hollowCrossDescription",
      },
      {
        descriptor: {
          source: "glitch",
          shape: "I",
          previewCosmetics: {
            kind: "glitch-cycle",
            shapes: ["I", "J", "L", "O", "S", "T", "Z"],
            intervalMs: 150,
            finalShapeConcealed: true,
          },
        },
        name: "help.glitchPiece",
        description: "help.glitchPieceDescription",
      },
      {
        descriptor: { source: "oversize", shape: "T" },
        name: "help.oversizeShapes",
        description: "help.oversizeShapesDescription",
      },
    ];
    const previewOptions: PiecePreviewOptions = {
      colorPalette: shell.container.dataset.palette === "colorblind"
        ? "colorblind"
        : "standard",
      reducedMotion: shell.container.dataset.reducedMotion === "true",
      reducedFlashes: shell.container.dataset.reducedFlashes === "true",
      elapsedMs: 0,
    };
    for (const entry of pieceEntries) {
      const card = element(document, "article", "special-guide-card");
      const sample = element(
        document,
        "div",
        "special-piece-sample piece-preview-slot is-primary",
      );
      renderPiecePreviewSlot(sample, entry.descriptor, previewOptions);
      const copy = element(document, "div");
      copy.append(
        element(document, "h4", undefined, STRINGS[entry.name]),
        element(document, "p", undefined, STRINGS[entry.description]),
      );
      card.append(sample, copy);
      pieces.append(card);
    }
    piecesSection.append(pieces);
    shell.helpBody.append(meterSection, markedSection, piecesSection);
  } else {
    shell.helpHeading.textContent = STRINGS["lobby.practiceControls"];
    const controlLayout = element(document, "div", "control-help-layout");
    const touchSection = element(document, "section", "control-help-section");
    touchSection.dataset.controlScheme = "touch";
    const gestureGuide = element(document, "div", "gesture-control-guide");
    const gestureRows: ReadonlyArray<readonly [string, StringKey, StringKey]> = [
      ["●", "controls.rotateClockwise", "help.gestureTap"],
      ["●●", "controls.rotateCounterclockwise", "help.gestureTwoFingerTap"],
      ["↔", "help.moveLeftRight", "help.gestureMove"],
      ["⇣", "controls.softDrop", "help.gestureSoftDrop"],
      ["⇊", "controls.hardDrop", "help.gestureHardDrop"],
      ["⇧", "help.holdAction", "help.gestureHold"],
    ];
    for (const [glyph, action, description] of gestureRows) {
      const row = element(document, "div", "gesture-control-row");
      row.append(
        element(document, "span", "gesture-control-glyph", glyph),
        element(document, "strong", undefined, STRINGS[action]),
        element(document, "span", "gesture-control-copy", STRINGS[description]),
      );
      gestureGuide.append(row);
    }
    touchSection.append(
      element(document, "h3", undefined, STRINGS["help.touchControlsHeading"]),
      element(document, "p", "muted", STRINGS["help.touchArea"]),
      gestureGuide,
      element(document, "h4", undefined, STRINGS["help.touchButtonsHeading"]),
      element(document, "p", "muted", STRINGS["help.touchButtonsIntro"]),
    );
    const buttonGuide = element(document, "div", "touch-button-guide");
    const buttonEntries: ReadonlyArray<readonly [string, StringKey, string]> = [
      ["←", "controls.moveLeft", "move-left"],
      ["↺", "controls.rotateCounterclockwise", "rotate-ccw"],
      ["↻", "controls.rotateClockwise", "rotate-cw"],
      ["→", "controls.moveRight", "move-right"],
      ["↓", "controls.softDrop", "soft-drop"],
      ["⇊", "controls.hardDrop", "hard-drop"],
      ["H", "controls.hold", "hold"],
    ];
    for (const [glyph, label, action] of buttonEntries) {
      const item = element(document, "span", "touch-button-help");
      item.dataset.controlAction = action;
      item.append(
        element(document, "span", "touch-button-help-glyph", glyph),
        element(document, "span", undefined, STRINGS[label]),
      );
      buttonGuide.append(item);
    }
    touchSection.append(buttonGuide);

    const keyboardSection = element(document, "section", "control-help-section");
    keyboardSection.dataset.controlScheme = "keyboard";
    const table = element(document, "table", "keyboard-controls-table");
    const head = element(document, "thead");
    const headRow = element(document, "tr");
    headRow.append(
      element(document, "th", undefined, STRINGS["help.actionHeading"]),
      element(document, "th", undefined, STRINGS["help.keysHeading"]),
    );
    head.append(headRow);
    const body = element(document, "tbody");
    const rows: ReadonlyArray<
      readonly [StringKey, ReadonlyArray<readonly string[]>]
    > = [
      ["help.moveLeftRight", [["←", "→"], ["A", "D"]]],
      ["controls.softDrop", [["↓"], ["S"]]],
      ["controls.hardDrop", [["Space"]]],
      ["controls.rotateClockwise", [["↑"], ["X"], ["E"]]],
      ["controls.rotateCounterclockwise", [["Z"], ["Q"]]],
      ["help.holdAction", [["C"], ["Shift"]]],
      ["help.pausePracticeAction", [["P"], ["Esc"]]],
    ];
    for (const [action, keyGroups] of rows) {
      const row = element(document, "tr");
      const actionCell = element(document, "th", undefined, STRINGS[action]);
      actionCell.scope = "row";
      const keysCell = element(document, "td", "keyboard-keys");
      keyGroups.forEach((keys, groupIndex) => {
        if (groupIndex > 0) {
          keysCell.append(element(document, "span", "keyboard-or", "or"));
        }
        const group = element(document, "span", "keyboard-key-group");
        for (const key of keys) group.append(element(document, "kbd", undefined, key));
        keysCell.append(group);
      });
      row.append(actionCell, keysCell);
      body.append(row);
    }
    table.append(head, body);
    keyboardSection.append(
      element(document, "h3", undefined, STRINGS["help.keyboardControlsHeading"]),
      table,
    );
    controlLayout.append(touchSection, keyboardSection);
    shell.helpBody.append(controlLayout);
  }
  shell.show("help");
}

export function setHudPower(
  hud: HudElements,
  power: PowerKind,
  label: string,
  value: number,
  deckCursor?: number,
): void {
  const charge = Math.max(0, Math.floor(value));
  const accent = POWER_ACCENT_COLORS[power];
  if (hud.upcomingPower.style.getPropertyValue("--power-accent") !== accent) {
    hud.upcomingPower.style.setProperty("--power-accent", accent);
  }
  if (hud.upcomingPower.dataset.power !== power) {
    hud.upcomingPower.dataset.power = power;
    const icon = createPowerIcon(hud.upcomingPower.ownerDocument, power, label);
    icon.setAttribute("aria-hidden", "true");
    icon.removeAttribute("role");
    hud.upcomingPower.replaceChildren(icon);
  }
  hud.upcomingPower.setAttribute(
    "aria-label",
    `${STRINGS["hud.upcomingPower"]}: ${label}`,
  );
  const chargeState = charge >= RULES.power.threshold
    ? "ready"
    : charge === RULES.power.threshold - 1
      ? "near"
      : "charging";
  if (hud.upcomingPower.dataset.chargeState !== chargeState) {
    hud.upcomingPower.dataset.chargeState = chargeState;
  }
  hud.meterSegments.forEach((segment, index) => {
    const filled = index < Math.min(charge, RULES.power.threshold);
    if (segment.classList.contains("is-filled") !== filled) {
      segment.classList.toggle("is-filled", filled);
    }
  });
  setPowerMeterAccessibility(hud.meter, charge);

  if (deckCursor === undefined) return;
  const cursor = String(deckCursor);
  const previous = hud.meter.dataset.powerCursor;
  hud.meter.dataset.powerCursor = cursor;
  if (previous === undefined || previous === cursor) return;
  hud.meter.classList.remove("is-activating");
  void hud.meter.offsetWidth;
  hud.meter.classList.add("is-activating");
  hud.meter.ownerDocument.defaultView?.setTimeout(() => {
    hud.meter.classList.remove("is-activating");
  }, 520);
}

export function setHudGarbage(
  hud: HudElements,
  rows: number,
  ready: boolean,
): void {
  const count = Math.max(0, Math.floor(rows));
  const state = count === 0 ? "empty" : ready ? "ready" : "warning";
  const countText = String(count);
  const label = state === "ready"
    ? `${STRINGS["hud.incomingGarbage"]}: ${count}, ready to rise`
    : state === "warning"
      ? `${STRINGS["hud.incomingGarbage"]}: ${count}, queued`
      : `${STRINGS["hud.incomingGarbage"]}: 0`;
  if (hud.incoming.dataset.state !== state) hud.incoming.dataset.state = state;
  if (hud.incomingCount.textContent !== countText) {
    hud.incomingCount.textContent = countText;
  }
  if (hud.incoming.getAttribute("aria-label") !== label) {
    hud.incoming.setAttribute("aria-label", label);
  }
}

export interface TimedEffectHudItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly remainingTicks: number;
  readonly totalTicks: number;
  readonly accent: string;
}

export function renderTimedEffects(
  hud: HudElements,
  effects: readonly TimedEffectHudItem[],
): void {
  const document = hud.statuses.ownerDocument;
  const visible = effects.slice(0, 4);
  const queued = effects.slice(visible.length);
  hud.statuses.dataset.effectLayout = String(visible.length);
  hud.statuses.dataset.queuedEffects = String(queued.length);
  const existingRows = new Map(
    [...hud.statuses.querySelectorAll<HTMLElement>(".timed-effect")]
      .map((row) => [row.dataset.effect, row] as const),
  );
  const rows: HTMLElement[] = visible.map((effect) => {
    const remaining = Math.max(0, Math.floor(effect.remainingTicks));
    const total = Math.max(1, Math.floor(effect.totalTicks));
    const seconds = Math.ceil(remaining / RULES.timing.ticksPerSecond);
    const row = existingRows.get(effect.id) ?? element(document, "div", "timed-effect");
    row.dataset.effect = effect.id;
    if (row.style.getPropertyValue("--effect-accent") !== effect.accent) {
      row.style.setProperty("--effect-accent", effect.accent);
    }
    const progress = row.querySelector<HTMLElement>(".timed-effect-progress") ??
      element(document, "div", "timed-effect-progress");
    const fill = row.querySelector<HTMLElement>(".timed-effect-progress-fill") ??
      element(document, "span", "timed-effect-progress-fill");
    const name = row.querySelector<HTMLElement>(".timed-effect-name") ??
      element(document, "span", "timed-effect-name");
    const time = row.querySelector<HTMLElement>(".timed-effect-time") ??
      element(document, "span", "timed-effect-time");
    progress.setAttribute("role", "progressbar");
    if (
      progress.children.length !== 3 ||
      progress.children[0] !== fill ||
      progress.children[1] !== name ||
      progress.children[2] !== time
    ) {
      progress.replaceChildren(fill, name, time);
    }
    if (row.children.length !== 1 || row.firstElementChild !== progress) {
      row.replaceChildren(progress);
    }
    const nameText = effect.detail === undefined
      ? effect.label
      : `${effect.label} ${effect.detail}`;
    if (name.textContent !== nameText) name.textContent = nameText;
    const remainingText = `${seconds} second${seconds === 1 ? "" : "s"} remaining`;
    const attributes: ReadonlyArray<readonly [string, string]> = [
      ["aria-label", `${nameText}, ${remainingText}`],
      ["aria-valuemin", "0"],
      ["aria-valuemax", String(total)],
      ["aria-valuenow", String(Math.min(remaining, total))],
      ["aria-valuetext", remainingText],
    ];
    for (const [attribute, value] of attributes) {
      if (progress.getAttribute(attribute) !== value) {
        progress.setAttribute(attribute, value);
      }
    }
    const progressValue = `${Math.max(0, Math.min(100, remaining / total * 100))}%`;
    if (fill.style.getPropertyValue("--effect-progress") !== progressValue) {
      fill.style.setProperty("--effect-progress", progressValue);
    }
    const timeText = `${seconds}s`;
    if (time.textContent !== timeText) time.textContent = timeText;
    return row;
  });
  const current = [...hud.statuses.children];
  if (
    current.length !== rows.length ||
    rows.some((row, index) => current[index] !== row)
  ) {
    hud.statuses.replaceChildren(...rows);
  }
}

export function setElementHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}

export function setPowerMeterAccessibility(meter: HTMLElement, value: number): void {
  const charge = Math.max(0, Math.floor(value));
  const threshold = RULES.power.threshold;
  const retained = Math.max(0, charge - threshold);
  const valueNow = String(Math.min(charge, threshold));
  const valueText = charge >= threshold
    ? retained > 0
      ? retained === 1
        ? STRINGS["hud.powerReadyRetainedOne"]
        : formatString("hud.powerReadyRetainedMany", { count: retained })
      : STRINGS["hud.powerReady"]
    : formatString("hud.powerCharge", { charge, threshold });
  if (meter.getAttribute("aria-valuenow") !== valueNow) {
    meter.setAttribute("aria-valuenow", valueNow);
  }
  if (meter.getAttribute("aria-valuetext") !== valueText) {
    meter.setAttribute("aria-valuetext", valueText);
  }
}

export function countdownText(seconds: number): string {
  return formatString("match.countdown", { seconds });
}
