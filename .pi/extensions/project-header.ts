/** Split Stack fixed-layout header with a large Hollow Cross project mark. */

import {
  VERSION,
  type ExtensionAPI,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

function tile(theme: Theme, color: ThemeColor): string {
  return theme.fg(color, "▄██▄");
}

function tileBottom(theme: Theme, color: ThemeColor): string {
  return theme.fg(color, "▀██▀");
}

const CROSS: Array<Array<ThemeColor | null>> = [
  [null, null, "syntaxType", null, null],
  [null, null, "syntaxNumber", null, null],
  ["syntaxFunction", "success", null, "error", "bashMode"],
  [null, null, "warning", null, null],
  [null, null, "mdCode", null, null],
];

function hollowCross(theme: Theme): string[] {
  return CROSS.flatMap((row) => [
    row.map((color) => (color ? tile(theme, color) : "    ")).join(" "),
    row.map((color) => (color ? tileBottom(theme, color) : "    ")).join(" "),
  ]);
}

function title(theme: Theme): string {
  return [
    theme.fg("accent", theme.bold("SPLIT STACK")),
    theme.fg("text", " CODING AGENT"),
  ].join("");
}

function center(line: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
  return `${" ".repeat(left)}${line}`;
}

function titlePanel(theme: Theme): string[] {
  const titleText = title(theme);
  const titleWidth = "SPLIT STACK CODING AGENT".length;
  const horizontalPadding = 3;
  const innerWidth = titleWidth + horizontalPadding * 2;
  const border = (text: string) => theme.fg("borderAccent", text);
  const version = theme.fg("dim", `PI v${VERSION}`);

  return [
    border(`╭${"─".repeat(innerWidth)}╮`),
    `${border("│")}${" ".repeat(horizontalPadding)}${titleText}${" ".repeat(horizontalPadding)}${border("│")}`,
    border(`╰${"─".repeat(innerWidth)}╯`),
    "",
    center(version, innerWidth + 2),
  ];
}

function sideBySide(theme: Theme, width: number): string[] {
  const logo = hollowCross(theme);
  const panel = titlePanel(theme);
  const logoWidth = 24;
  const panelWidth = "SPLIT STACK CODING AGENT".length + 8;
  const gap = 5;
  const totalWidth = logoWidth + gap + panelWidth;
  const left = Math.max(0, Math.floor((width - totalWidth) / 2));
  const panelOffset = Math.floor((logo.length - panel.length) / 2);

  return logo.map((logoLine, index) => {
    const panelIndex = index - panelOffset;
    const panelLine = panelIndex >= 0 && panelIndex < panel.length ? panel[panelIndex]! : "";
    return `${" ".repeat(left)}${logoLine}${" ".repeat(gap)}${panelLine}`;
  });
}

function stacked(theme: Theme, width: number): string[] {
  const panel = titlePanel(theme);
  const panelWidth = "SPLIT STACK CODING AGENT".length + 8;
  return [
    ...hollowCross(theme).map((line) => center(line, width)),
    "",
    ...panel.map((line) => center(line, width)),
  ];
}

function compact(theme: Theme, width: number): string[] {
  return [
    center(theme.fg("accent", theme.bold("SPLIT STACK")), width),
    center(theme.fg("text", "CODING AGENT"), width),
    center(theme.fg("dim", `PI v${VERSION}`), width),
  ];
}

export function renderHeader(theme: Theme, width: number): string[] {
  const panelWidth = "SPLIT STACK CODING AGENT".length + 8;
  const sideBySideWidth = 24 + 5 + panelWidth;

  if (width >= sideBySideWidth) return ["", ...sideBySide(theme, width), ""];
  if (width >= panelWidth) return ["", ...stacked(theme, width), ""];
  return ["", ...compact(theme, width), ""];
}

export default function projectHeader(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return renderHeader(theme, width);
      },
      invalidate() {},
    }));
  });
}
