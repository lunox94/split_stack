import { RULES } from "../config/rules";
import { STRINGS, formatString, type StringKey } from "../app/strings";
import type { PieceDescriptor, SpecialKind } from "../domain/types";
import type { Preferences } from "../persistence/settings";
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
  boardTarget: HTMLElement;
  name: HTMLElement;
  score: HTMLElement;
  level: HTMLElement;
  lines: HTMLElement;
  hold: HTMLElement;
  preview: HTMLElement;
  upcomingPower: HTMLElement;
  incoming: HTMLElement;
  meter: HTMLElement;
  meterFill: HTMLElement;
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
  const name = element(document, "span", "player-name", "—");
  const score = element(document, "span", "hud-stat", "0");
  score.setAttribute("aria-label", STRINGS["hud.score"]);
  const level = element(document, "span", "hud-stat", "1");
  level.setAttribute("aria-label", STRINGS["hud.level"]);
  const lines = element(document, "span", "hud-stat", "0");
  lines.setAttribute("aria-label", STRINGS["hud.lines"]);
  const hold = element(document, "section", "piece-preview-group hold-preview");
  hold.setAttribute("aria-label", STRINGS["hud.hold"]);
  const holdLabel = element(document, "span", "piece-preview-label", STRINGS["hud.hold"]);
  const holdSlot = element(document, "div", "piece-preview-slot is-hold");
  hold.append(holdLabel, holdSlot);
  const preview = element(document, "section", "piece-preview-group next-preview");
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
  const upcomingPower = element(
    document,
    "span",
    "hud-detail",
    `${STRINGS["hud.upcomingPower"]}: —`,
  );
  const incoming = element(
    document,
    "span",
    "hud-detail",
    `${STRINGS["hud.incomingGarbage"]}: 0`,
  );
  const meter = element(document, "div", "power-meter");
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-label", STRINGS["hud.power"]);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", String(RULES.power.threshold));
  const meterFill = element(document, "span");
  meter.append(meterFill);
  hud.append(name, score, level, lines, hold, preview, upcomingPower, incoming, meter);
  const statuses = element(document, "div", "status-row");
  statuses.setAttribute("aria-live", "polite");
  const blackout = element(
    document,
    "div",
    "blackout-cover",
    STRINGS["match.blackoutCover"],
  );
  blackout.hidden = true;
  pane.append(boardTarget, blackout, hud, statuses);
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
    boardTarget,
    name,
    score,
    level,
    lines,
    hold,
    preview,
    upcomingPower,
    incoming,
    meter,
    meterFill,
    statuses,
    blackout,
    setPiecePreviews,
  };
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
  glossaryButton: HTMLButtonElement;
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
  leaveMatchButton: HTMLButtonElement;
  pausePracticeButton: HTMLButtonElement;
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
  const glossaryButton = button(document, STRINGS["lobby.powerGlossary"]);
  const controlsHelpButton = button(document, STRINGS["lobby.practiceControls"]);
  const settingsButton = button(document, STRINGS["lobby.settings"]);
  secondary.append(helpButton, glossaryButton, controlsHelpButton, settingsButton);
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
  const pausePracticeButton = button(document, STRINGS["controls.pauseShort"]);
  pausePracticeButton.setAttribute("aria-label", STRINGS["controls.pausePractice"]);
  const leaveMatchButton = button(document, STRINGS["results.leaveShort"]);
  leaveMatchButton.setAttribute("aria-label", STRINGS["results.leave"]);
  matchActions.append(pausePracticeButton, leaveMatchButton);
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
  match.append(arena, matchActions, overlay, touchButtons, unsupported);

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
    glossaryButton,
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
    leaveMatchButton,
    pausePracticeButton,
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

export function showHelp(shell: AppShell, kind: "how" | "powers" | "controls"): void {
  const document = shell.helpBody.ownerDocument;
  shell.helpBody.replaceChildren();
  if (kind === "how") {
    shell.helpHeading.textContent = STRINGS["help.heading"];
    for (const key of [
      "help.goal",
      "help.controls",
      "help.powers",
      "help.specialCells",
      "help.noAutoTutorial",
    ] as const) {
      shell.helpBody.append(element(document, "p", undefined, STRINGS[key]));
    }
    shell.helpBody.append(
      element(document, "h3", undefined, STRINGS["help.specialCellsHeading"]),
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
    shell.helpBody.append(specials);
  } else if (kind === "powers") {
    shell.helpHeading.textContent = STRINGS["lobby.powerGlossary"];
    const appendGroup = (
      group: "meter" | "marked" | "pieces",
      heading: StringKey,
      entries: ReadonlyArray<readonly [StringKey, StringKey]>,
    ): void => {
      const section = element(document, "section", "glossary-group");
      section.dataset.glossaryGroup = group;
      const list = element(document, "dl", "glossary-list");
      for (const [name, description] of entries) {
        list.append(
          element(document, "dt", undefined, STRINGS[name]),
          element(document, "dd", undefined, STRINGS[description]),
        );
      }
      section.append(element(document, "h3", undefined, STRINGS[heading]), list);
      shell.helpBody.append(section);
    };
    appendGroup("meter", "help.meterPowersHeading", [
      ["power.scramble", "power.scrambleDescription"],
      ["power.nuke", "power.nukeDescription"],
      ["power.collapse", "power.collapseDescription"],
      ["power.monominoRush", "power.monominoRushDescription"],
      ["power.acidRain", "power.acidRainDescription"],
      ["power.oversize", "power.oversizeDescription"],
      ["power.ghostJam", "power.ghostJamDescription"],
    ]);
    appendGroup("marked", "help.markedPowersHeading", [
      ["special.columnBomb", "special.columnBombDescription"],
      ["special.garbageCore", "special.garbageCoreDescription"],
      ["special.glitchCore", "special.glitchCoreDescription"],
      ["power.blackout", "special.blackoutDescription"],
      ["power.barrier", "special.barrierDescription"],
    ]);
    appendGroup("pieces", "help.specialPiecesHeading", [
      ["help.hollowCross", "help.hollowCrossDescription"],
      ["help.glitchPiece", "help.glitchPieceDescription"],
      ["help.oversizeShapes", "help.oversizeShapesDescription"],
    ]);
  } else {
    shell.helpHeading.textContent = STRINGS["lobby.practiceControls"];
    const touchSection = element(document, "section", "control-help-section");
    touchSection.dataset.controlScheme = "touch";
    const touchList = element(document, "ul");
    for (const description of [
      STRINGS["help.touchRotate"],
      STRINGS["help.touchMove"],
      STRINGS["help.touchDrop"],
    ]) {
      touchList.append(element(document, "li", undefined, description));
    }
    touchSection.append(
      element(document, "h3", undefined, STRINGS["help.touchControlsHeading"]),
      touchList,
    );

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
    shell.helpBody.append(touchSection, keyboardSection);
  }
  shell.show("help");
}

export function meterProgress(value: number): string {
  return `${Math.max(0, Math.min(100, (value / RULES.power.threshold) * 100))}%`;
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
