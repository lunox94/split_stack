import { RULES } from "../config/rules";
import { STRINGS, formatString, type StringKey } from "../app/strings";
import type { Preferences } from "../persistence/settings";

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
  const hold = element(document, "span", "hud-detail", `${STRINGS["hud.hold"]}: —`);
  const preview = element(document, "span", "hud-detail", `${STRINGS["hud.next"]}: —`);
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
  };
}

export interface SettingsInputs {
  audioEnabled: HTMLInputElement;
  volume: HTMLInputElement;
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
  settingsBack: HTMLButtonElement;
  match: HTMLElement;
  arena: HTMLElement;
  left: HudElements;
  right: HudElements;
  readyButton: HTMLButtonElement;
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
  const audioEnabled = checkboxSetting(
    document,
    settingsList,
    STRINGS["settings.audio"],
  );
  const volumeLabel = element(document, "label", "setting-row");
  volumeLabel.append(element(document, "span", undefined, STRINGS["settings.effectsVolume"]));
  const volume = element(document, "input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.05";
  volumeLabel.append(volume);
  settingsList.append(volumeLabel);
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
  const settingsBack = button(document, STRINGS["common.back"]);
  settingsParts.panel.append(settingsList, settingsBack);

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
  const readyButton = button(document, STRINGS["match.ready"], "primary");
  const pausePracticeButton = button(document, STRINGS["controls.pauseShort"]);
  pausePracticeButton.setAttribute("aria-label", STRINGS["controls.pausePractice"]);
  const leaveMatchButton = button(document, STRINGS["results.leaveShort"]);
  leaveMatchButton.setAttribute("aria-label", STRINGS["results.leave"]);
  matchActions.append(readyButton, pausePracticeButton, leaveMatchButton);
  const overlay = element(document, "div", "center-overlay");
  const overlayCard = element(document, "div", "center-overlay-card");
  const overlayText = element(document, "p", undefined, STRINGS["match.waitingForReady"]);
  overlayCard.append(overlayText);
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
  for (const [symbol, key, action] of controls) {
    const control = button(document, symbol);
    control.dataset.action = action;
    control.setAttribute("aria-label", STRINGS[key]);
    touchButtons.append(control);
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
      audioEnabled,
      volume,
      vibration,
      touchControls,
      colorPalette,
      reducedMotion,
      reducedFlashes,
      reducedEffects,
      screenShake,
      gameplayTips,
    },
    settingsBack,
    match,
    arena,
    left,
    right,
    readyButton,
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
      audioEnabled.checked = preferences.audioEnabled;
      volume.value = String(preferences.volume);
      vibration.checked = preferences.vibration;
      touchControls.value = preferences.touchControls;
      colorPalette.value = preferences.colorPalette;
      reducedMotion.checked = preferences.reducedMotion;
      reducedFlashes.checked = preferences.reducedFlashes;
      reducedEffects.checked = preferences.reducedEffects;
      screenShake.checked = preferences.screenShake;
      gameplayTips.checked = preferences.gameplayTips;
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
  } else if (kind === "powers") {
    shell.helpHeading.textContent = STRINGS["lobby.powerGlossary"];
    const list = element(document, "dl", "glossary-list");
    const entries: Array<[StringKey, string]> = [
      ["power.blackout", STRINGS["power.blackoutDescription"]],
      ["power.scramble", STRINGS["power.scrambleDescription"]],
      ["power.nuke", STRINGS["power.nukeDescription"]],
      ["power.barrier", STRINGS["power.barrierDescription"]],
      ["power.collapse", STRINGS["power.collapseDescription"]],
      ["power.monominoRush", STRINGS["power.monominoRushDescription"]],
      ["power.acidRain", STRINGS["power.acidRainDescription"]],
    ];
    for (const [key, description] of entries) {
      list.append(
        element(document, "dt", undefined, STRINGS[key]),
        element(document, "dd", undefined, description),
      );
    }
    shell.helpBody.append(list);
  } else {
    shell.helpHeading.textContent = STRINGS["lobby.practiceControls"];
    const list = element(document, "ul");
    for (const description of [
      STRINGS["help.touchRotate"],
      STRINGS["help.touchMove"],
      STRINGS["help.touchDrop"],
      STRINGS["help.keyboard"],
    ]) {
      list.append(element(document, "li", undefined, description));
    }
    shell.helpBody.append(list);
  }
  shell.show("help");
}

export function meterProgress(value: number): string {
  return `${Math.max(0, Math.min(100, (value / RULES.power.threshold) * 100))}%`;
}

export function countdownText(seconds: number): string {
  return formatString("match.countdown", { seconds });
}
