import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  RepeatWrapping,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  type Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { RULES } from "../config/rules";
import type { CellKind, PlayerId, SpecialKind } from "../domain/types";
import {
  type PresentationEffect,
  type PresentationFrame,
} from "./presentation-timeline";
import {
  SPECIAL_ACCENT_COLORS,
  SPECIAL_ACCENT_HEX,
  SPECIAL_ICON_PATHS,
} from "./special-icons";
import {
  COLORBLIND_PIECE_COLORS,
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
  type PieceVisualKind,
} from "./piece-visual-tokens";
import {
  QualityController,
  type EffectQuality,
  type RenderQualityProfile,
} from "./quality";
import { MarkedCellPulseTracker } from "./marked-cell-pulses";

export type RenderCellKind = CellKind | "acid";
export type RenderCellRole = "settled" | "active" | "ghost";

export interface RenderCellModel {
  readonly column: number;
  readonly row: number;
  readonly kind: RenderCellKind;
  readonly role: RenderCellRole;
  readonly special?: SpecialKind;
  /** Optional 0..1 spawn/lock emphasis supplied by the presentation layer. */
  readonly specialEmphasis?: number;
}

export interface BoardRenderModel {
  readonly playerId: PlayerId;
  /** Stable for one active piece across movement and rotation. */
  readonly activePieceKey?: string;
  readonly cells: readonly RenderCellModel[];
  readonly focused: boolean;
  readonly concealed: boolean;
  readonly incomingGarbage?: number;
  readonly barrierCapacity?: number;
  readonly scrambled?: boolean;
  readonly monominoRush?: boolean;
}

export interface GameRenderFrame {
  readonly mode: "versus" | "practice";
  readonly left: BoardRenderModel | null;
  readonly right: BoardRenderModel | null;
  readonly presentation?: PresentationFrame;
}

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoardHudLayout {
  readonly header: LayoutRect;
  readonly rail: LayoutRect;
  readonly timers: LayoutRect;
  readonly garbage: LayoutRect;
}

export interface BoardViewport {
  readonly paneX: number;
  readonly paneWidth: number;
  readonly boardX: number;
  readonly boardY: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly cellSize: number;
  readonly hud: BoardHudLayout;
}

export interface RendererLayout {
  readonly width: number;
  readonly height: number;
  readonly mode: GameRenderFrame["mode"];
  readonly left: BoardViewport;
  readonly right: BoardViewport | null;
  readonly safeBounds: LayoutRect;
  readonly frame: LayoutRect;
  readonly compactTopHud: boolean;
  readonly topHudHeight: number;
  readonly centerCorridor: LayoutRect | null;
  readonly dividerX: number | null;
}

export interface LayoutInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface RendererLayoutOptions {
  readonly safeAreaInsets?: Partial<LayoutInsets>;
  readonly bottomInset?: number;
}

export interface PresentationMotionTransform {
  readonly garbageLift: number;
  readonly transferTravel: number;
  readonly nukeScale: number;
  readonly collapseTravel: number;
  readonly scrambleOscillation: number;
  readonly oversizeScale: number;
  readonly ghostJamFlicker: number;
  readonly ghostJamOpacity: number;
}

export interface MarkedCellPresentation {
  readonly accent: number;
  readonly emissiveIntensity: number;
  readonly rimOpacity: number;
  readonly rimScale: number;
  readonly haloOpacity: number;
  readonly haloScale: number;
}

/**
 * Public, deterministic marked-cell visual state. The glyph itself stays
 * static; only its surrounding light breathes. Reduced effects intentionally
 * ignores time and uses an equally legible bright static treatment.
 */
export function markedCellPresentationAt(
  special: SpecialKind,
  role: RenderCellRole,
  quality: EffectQuality,
  timestampMs: number,
  emphasis = 0,
): MarkedCellPresentation {
  const pulse = Math.max(0, Math.min(1, emphasis));
  if (role === "ghost") {
    const breath = quality === "reduced"
      ? 0.5
      : (Math.sin(timestampMs / 1_100 * Math.PI * 2) + 1) / 2;
    return {
      accent: SPECIAL_ACCENT_HEX[special],
      emissiveIntensity: 0.14 + breath * 0.08,
      rimOpacity: 0.12 + breath * 0.14,
      rimScale: 0.75 + breath * 0.05,
      haloOpacity: 0.035 + breath * 0.065,
      haloScale: 0.84 + breath * 0.07,
    };
  }
  if (quality === "reduced") {
    return {
      accent: SPECIAL_ACCENT_HEX[special],
      emissiveIntensity: 0.95,
      rimOpacity: 0.86,
      rimScale: 0.94,
      haloOpacity: 0.34,
      haloScale: 1.14,
    };
  }
  const breath = (Math.sin(timestampMs / 1_100 * Math.PI * 2) + 1) / 2;
  return {
    accent: SPECIAL_ACCENT_HEX[special],
    emissiveIntensity: 0.72 + breath * 0.35,
    rimOpacity: Math.min(1, 0.68 + breath * 0.27 + pulse * 0.08),
    rimScale: 0.92 + breath * 0.05 + pulse * 0.04,
    haloOpacity: Math.min(0.68, 0.18 + breath * 0.22 + pulse * 0.18),
    haloScale: 1.06 + breath * 0.16 + pulse * 0.12,
  };
}

export function presentationMotionTransform(
  effect: PresentationEffect,
): PresentationMotionTransform {
  if (effect.visualStyle === "fade") {
    return {
      garbageLift: 0,
      transferTravel: 1,
      nukeScale: 1,
      collapseTravel: 0,
      scrambleOscillation: 0,
      oversizeScale: effect.attack === "oversize" ? 1.35 : 1,
      ghostJamFlicker: 0,
      ghostJamOpacity: 0.62,
    };
  }
  const transferTravel = effect.moment === "travel"
    ? Math.max(0, Math.min(1, (effect.stageProgress - 0.36) / 0.64))
    : effect.moment === "charge" ? 0 : 1;
  const oversizeScale = effect.attack !== "oversize"
    ? 1
    : effect.moment === "charge"
      ? 0.5 + effect.stageProgress * 0.2
      : effect.moment === "travel"
        ? 0.72 + transferTravel * 0.5
        : effect.moment === "impact"
          ? 1.5 - effect.stageProgress * 0.1
          : 1.25;
  return {
    garbageLift: effect.moment === "lift" ? effect.stageProgress : 0,
    transferTravel,
    nukeScale: effect.moment === "shockwave"
      ? 1 + effect.stageProgress * 0.38
      : 0.9 + Math.sin(effect.progress * Math.PI * 12) * 0.035,
    collapseTravel: effect.kind === "collapse"
      ? effect.moment === "fall"
        ? 1 - effect.stageProgress
        : effect.stage === "anticipation" ? 1 : 0
      : 1 - effect.stageProgress,
    scrambleOscillation: Math.sin(effect.progress * Math.PI * 18),
    oversizeScale,
    ghostJamFlicker: effect.kind === "ghost-jam"
      ? Math.sin(effect.progress * Math.PI * 18)
      : 0,
    ghostJamOpacity: effect.kind === "ghost-jam" && effect.moment === "ghost-dissolve"
      ? 1 - effect.stageProgress
      : 1,
  };
}

export function collapseCellVisualRow(
  effect: PresentationEffect,
  column: number,
  destinationRow: number,
): number {
  if (effect.kind !== "collapse") return destinationRow;
  const movement = effect.movements?.find(
    (candidate) =>
      candidate.to.x === column && candidate.to.y === destinationRow,
  );
  if (movement === undefined) return destinationRow;
  const remaining = presentationMotionTransform(effect).collapseTravel;
  return movement.to.y - (movement.to.y - movement.from.y) * remaining;
}

export function garbageCellVisualRow(
  effect: PresentationEffect,
  destinationRow: number,
): number {
  if (effect.kind !== "garbage-rise" || effect.visualStyle === "fade") {
    return destinationRow;
  }
  const rows = Math.max(0, effect.rowCount ?? 0);
  const remaining = effect.moment === "pressure"
    ? 1
    : effect.moment === "lift" ? 1 - effect.stageProgress : 0;
  return destinationRow + rows * remaining;
}

function boardMovementEffectFor(
  presentation: PresentationFrame | undefined,
  board: "left" | "right",
): PresentationEffect | undefined {
  if (presentation === undefined) return undefined;
  for (let index = presentation.effects.length - 1; index >= 0; index -= 1) {
    const effect = presentation.effects[index];
    if (
      effect?.board === board &&
      (effect.kind === "collapse" || effect.kind === "garbage-rise")
    ) {
      return effect;
    }
  }
  return undefined;
}

function offensiveTransferColor(attack: PresentationEffect["attack"]): number {
  switch (attack) {
    case "blackout":
      return SPECIAL_ACCENT_HEX.blackout;
    case "garbage":
      return SPECIAL_ACCENT_HEX["garbage-core"];
    case "glitch":
      return SPECIAL_ACCENT_HEX["glitch-core"];
    case "oversize":
      return SPECIAL_ACCENT_HEX["column-bomb"];
    case "ghost-jam":
      return SPECIAL_ACCENT_HEX.barrier;
    case "scramble":
      return 0xff5cdb;
    case "hollow-cross":
      return 0xf5ff72;
    default:
      return 0xb5ff62;
  }
}

export interface ThreeRendererOptions {
  readonly initialQuality?: EffectQuality;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
  readonly onUnsupported?: (reason: Error) => void;
  readonly onLayout?: (layout: RendererLayout) => void;
  readonly onQualityChanged?: (profile: RenderQualityProfile) => void;
}

export class WebGlUnavailableError extends Error {
  readonly originalCause: unknown;

  constructor(cause?: unknown) {
    super("WebGL is unavailable on this device");
    this.name = "WebGlUnavailableError";
    this.originalCause = cause;
  }
}

const MAX_INSTANCES_PER_POOL = 512;
export const MAX_PRESENTATION_PARTICLES = 96;
const FRAME_HORIZONTAL_GUTTER_PX = 8;
const FRAME_VERTICAL_GUTTER_PX = 4;
const STANDARD_TOP_HUD_HEIGHT_PX = 72;
const COMPACT_TOP_HUD_HEIGHT_PX = 64;
const COMPACT_BOARD_WIDTH_THRESHOLD_PX = 160;
const TOP_HUD_BOARD_GAP_PX = 4;
const BOTTOM_STATUS_HEIGHT_PX = 40;
const BOARD_STATUS_GAP_PX = 4;
const POWER_RAIL_WIDTH_PX = 24;
const BOARD_RAIL_GAP_PX = 4;
const INTER_RAIL_GAP_PX = 2;
const VERSUS_CENTER_CORRIDOR_PX =
  BOARD_RAIL_GAP_PX * 2 + POWER_RAIL_WIDTH_PX * 2 + INTER_RAIL_GAP_PX;

interface CellPool {
  readonly mesh: InstancedMesh;
  readonly material: MeshStandardMaterial;
}

interface EffectPool {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
}

interface EffectRectOptions {
  readonly additive?: boolean;
  readonly z?: number;
  readonly countsTowardPresentationLimit?: boolean;
  readonly instanceIntensity?: number;
}

interface EffectTextureOptions {
  readonly additive?: boolean;
  readonly z?: number;
  readonly instanceIntensity?: number;
}

function createAcidDropGeometry(): ShapeGeometry {
  const drop = new Shape();
  drop.moveTo(0, 0.56);
  drop.bezierCurveTo(0.08, 0.34, 0.43, 0.03, 0.43, -0.24);
  drop.bezierCurveTo(0.43, -0.49, 0.24, -0.62, 0, -0.62);
  drop.bezierCurveTo(-0.24, -0.62, -0.43, -0.49, -0.43, -0.24);
  drop.bezierCurveTo(-0.43, 0.03, -0.08, 0.34, 0, 0.56);
  return new ShapeGeometry(drop, 5);
}

interface BoardPanel {
  readonly fill: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly border: LineLoop<BufferGeometry, LineBasicMaterial>;
}

function createUnitPanelGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      3,
    ),
  );
  geometry.setAttribute(
    "uv",
    new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function createUnitBorderGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      3,
    ),
  );
  return geometry;
}

export function calculateRendererLayout(
  width: number,
  height: number,
  mode: GameRenderFrame["mode"],
  options: RendererLayoutOptions = {},
): RendererLayout {
  const viewportWidth = Math.max(1, width);
  const viewportHeight = Math.max(1, height);
  const safeTop = Math.max(0, options.safeAreaInsets?.top ?? 0);
  const safeRight = Math.max(0, options.safeAreaInsets?.right ?? 0);
  const safeBottom = Math.max(0, options.safeAreaInsets?.bottom ?? 0);
  const safeLeft = Math.max(0, options.safeAreaInsets?.left ?? 0);
  const bottomInset = Math.max(0, options.bottomInset ?? 0);
  const safeBounds = {
    x: safeLeft + FRAME_HORIZONTAL_GUTTER_PX,
    y: safeTop + FRAME_VERTICAL_GUTTER_PX,
    width: Math.max(
      0,
      viewportWidth - safeLeft - safeRight - FRAME_HORIZONTAL_GUTTER_PX * 2,
    ),
    height: Math.max(
      0,
      viewportHeight - safeTop - safeBottom - bottomInset - FRAME_VERTICAL_GUTTER_PX * 2,
    ),
  };
  const versusPaneSplitX = safeBounds.x + safeBounds.width / 2;
  const leftPaneWidth = mode === "versus" ? versusPaneSplitX : viewportWidth;
  const rightPaneWidth = viewportWidth - versusPaneSplitX;
  const horizontalBoardSpace = mode === "versus"
    ? (safeBounds.width - VERSUS_CENTER_CORRIDOR_PX) / 2
    : safeBounds.width - BOARD_RAIL_GAP_PX - POWER_RAIL_WIDTH_PX;
  const horizontalCellSize = horizontalBoardSpace / RULES.board.width;
  const fixedVerticalSpaceFor = (topHudHeight: number): number =>
    topHudHeight + TOP_HUD_BOARD_GAP_PX +
    BOARD_STATUS_GAP_PX + BOTTOM_STATUS_HEIGHT_PX;
  const cellSizeFor = (topHudHeight: number): number => Math.max(
    0,
    Math.min(
      horizontalCellSize,
      (safeBounds.height - fixedVerticalSpaceFor(topHudHeight)) /
        (RULES.board.height - RULES.board.hiddenRows),
    ),
  );
  const standardCellSize = cellSizeFor(STANDARD_TOP_HUD_HEIGHT_PX);
  const compactTopHud = standardCellSize * RULES.board.width <
    COMPACT_BOARD_WIDTH_THRESHOLD_PX;
  const topHudHeight = compactTopHud
    ? COMPACT_TOP_HUD_HEIGHT_PX
    : STANDARD_TOP_HUD_HEIGHT_PX;
  const compactWidthCeiling =
    (COMPACT_BOARD_WIDTH_THRESHOLD_PX - 0.001) / RULES.board.width;
  const cellSize = compactTopHud
    ? Math.min(cellSizeFor(topHudHeight), compactWidthCeiling)
    : standardCellSize;
  const fixedVerticalSpace = fixedVerticalSpaceFor(topHudHeight);
  const boardWidth = cellSize * RULES.board.width;
  const boardHeight =
    cellSize * (RULES.board.height - RULES.board.hiddenRows);
  const frameWidth = mode === "versus"
    ? boardWidth * 2 + VERSUS_CENTER_CORRIDOR_PX
    : boardWidth + BOARD_RAIL_GAP_PX + POWER_RAIL_WIDTH_PX;
  const frameHeight = fixedVerticalSpace + boardHeight;
  const frame = {
    x: safeBounds.x + (safeBounds.width - frameWidth) / 2,
    y: safeBounds.y + (safeBounds.height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
  const boardY = frame.y + topHudHeight + TOP_HUD_BOARD_GAP_PX;
  const statusY = boardY + boardHeight + BOARD_STATUS_GAP_PX;
  const leftBoardX = frame.x;
  const leftRailX = leftBoardX + boardWidth + BOARD_RAIL_GAP_PX;
  const rightRailX = leftRailX + POWER_RAIL_WIDTH_PX + INTER_RAIL_GAP_PX;
  const rightBoardX = rightRailX + POWER_RAIL_WIDTH_PX + BOARD_RAIL_GAP_PX;

  const viewportFor = (
    paneX: number,
    paneWidth: number,
    boardX: number,
    railX: number,
  ): BoardViewport => ({
    paneX,
    paneWidth,
    boardX,
    boardY,
    boardWidth,
    boardHeight,
    cellSize,
    hud: {
      header: { x: boardX, y: frame.y, width: boardWidth, height: topHudHeight },
      rail: { x: railX, y: boardY, width: POWER_RAIL_WIDTH_PX, height: boardHeight },
      timers: {
        x: boardX,
        y: statusY,
        width: boardWidth,
        height: BOTTOM_STATUS_HEIGHT_PX,
      },
      garbage: {
        x: railX,
        y: statusY,
        width: POWER_RAIL_WIDTH_PX,
        height: BOTTOM_STATUS_HEIGHT_PX,
      },
    },
  });
  const centerCorridor = mode === "versus"
    ? {
        x: leftBoardX + boardWidth,
        y: boardY,
        width: VERSUS_CENTER_CORRIDOR_PX,
        height: boardHeight,
      }
    : null;

  return {
    width: viewportWidth,
    height: viewportHeight,
    mode,
    left: viewportFor(0, leftPaneWidth, leftBoardX, leftRailX),
    right: mode === "versus"
      ? viewportFor(versusPaneSplitX, rightPaneWidth, rightBoardX, rightRailX)
      : null,
    safeBounds,
    frame,
    compactTopHud,
    topHudHeight,
    centerCorridor,
    dividerX: null,
  };
}

export class ThreeRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #options: ThreeRendererOptions;
  readonly #scene = new Scene();
  readonly #camera = new OrthographicCamera(0, 1, 1, 0, -100, 100);
  readonly #renderer: WebGLRenderer;
  readonly #cellGeometry = new RoundedBoxGeometry(1, 1, 0.18, 2, 0.06);
  readonly #acidGeometry = createAcidDropGeometry();
  readonly #effectGeometry = createUnitPanelGeometry();
  readonly #pools = new Map<string, CellPool>();
  readonly #effectPools = new Map<string, EffectPool>();
  readonly #textures = new Map<string, Texture>();
  readonly #matrix = new Matrix4();
  readonly #position = new Vector3();
  readonly #scale = new Vector3();
  readonly #instanceColor = new Color();
  readonly #quality: QualityController;
  readonly #markedCellPulses = new MarkedCellPulseTracker();
  readonly #panels: readonly [BoardPanel, BoardPanel];
  #layout: RendererLayout = calculateRendererLayout(1, 1, "versus");
  #lastLayoutKey = "";
  #contextLost = false;
  #disposed = false;
  #pixelRatio = 0;
  #palette: "standard" | "colorblind" = "standard";
  #effectInstanceCount = 0;
  #frameTimestampMs = 0;
  #staticMarkedCells = false;

  constructor(canvas: HTMLCanvasElement, options: ThreeRendererOptions = {}) {
    this.#canvas = canvas;
    this.#options = options;
    this.#quality = new QualityController(
      options.initialQuality === undefined
        ? {}
        : { initial: options.initialQuality },
    );
    try {
      this.#renderer = new WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch (error) {
      const unavailable = new WebGlUnavailableError(error);
      options.onUnsupported?.(unavailable);
      throw unavailable;
    }

    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#renderer.toneMapping = ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.05;
    this.#scene.background = new Color(0x070a13);
    this.#camera.position.set(0, 0, 50);
    this.#camera.lookAt(0, 0, 0);

    this.#scene.add(new AmbientLight(0x97b6ff, 1.6));
    const keyLight = new DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-1, 2, 5);
    this.#scene.add(keyLight);
    const rimLight = new DirectionalLight(0x4d6fff, 1.1);
    rimLight.position.set(2, -1, 3);
    this.#scene.add(rimLight);

    this.#panels = [this.#createPanel(), this.#createPanel()];
    for (const panel of this.#panels) {
      this.#scene.add(panel.fill, panel.border);
    }

    canvas.addEventListener("webglcontextlost", this.#onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.#onContextRestored, false);
  }

  get layout(): RendererLayout {
    return this.#layout;
  }

  get quality(): RenderQualityProfile {
    return this.#quality.profile;
  }

  setQuality(quality: EffectQuality): void {
    const previous = this.#quality.profile.effects;
    this.#quality.set(quality);
    if (this.#quality.profile.effects !== previous) {
      this.#pixelRatio = 0;
      this.#options.onQualityChanged?.(this.#quality.profile);
    }
  }

  setReducedEffects(reduced: boolean): void {
    this.setQuality(reduced ? "reduced" : "full");
  }

  noteSuspension(): void {
    this.#quality.noteSuspension();
  }

  setStaticMarkedCells(staticPresentation: boolean): void {
    this.#staticMarkedCells = staticPresentation;
  }

  setColorPalette(palette: "standard" | "colorblind"): void {
    if (this.#palette === palette) return;
    this.#palette = palette;
    for (const [key, pool] of this.#pools) {
      const [kind] = key.split(":") as [RenderCellKind];
      const color = new Color(this.#colors()[kind]);
      pool.material.color.copy(color);
      pool.material.emissive.setHex(0x000000);
      pool.material.needsUpdate = true;
    }
  }

  render(
    frame: GameRenderFrame,
    timestampMs = performance.now(),
    observedTargetFps: 60 | 30 = this.#quality.profile.targetFps,
  ): void {
    if (this.#disposed || this.#contextLost) return;
    const previousQuality = this.#quality.profile.effects;
    this.#quality.observeFrame(timestampMs, observedTargetFps);
    if (this.#quality.profile.effects !== previousQuality) {
      this.#pixelRatio = 0;
      this.#options.onQualityChanged?.(this.#quality.profile);
    }
    if (!this.#quality.shouldRender(timestampMs)) return;

    this.#frameTimestampMs = timestampMs;
    const decoratedFrame = this.#markedCellPulses.decorateFrame(frame, timestampMs);
    this.#resize(decoratedFrame.mode);
    for (const pool of this.#pools.values()) {
      pool.mesh.count = 0;
      pool.mesh.visible = false;
    }
    for (const pool of this.#effectPools.values()) {
      pool.mesh.count = 0;
      pool.mesh.visible = false;
    }
    this.#effectInstanceCount = 0;
    this.#scene.position.set(0, 0, 0);
    this.#drawBoard(
      decoratedFrame.left,
      this.#layout.left,
      this.#panels[0],
      boardMovementEffectFor(decoratedFrame.presentation, "left"),
    );
    this.#drawBoard(
      decoratedFrame.right,
      this.#layout.right,
      this.#panels[1],
      boardMovementEffectFor(decoratedFrame.presentation, "right"),
    );
    this.#drawPresentation(decoratedFrame.presentation);
    for (const pool of this.#pools.values()) {
      if (pool.mesh.count === 0) continue;
      pool.mesh.instanceMatrix.clearUpdateRanges();
      pool.mesh.instanceMatrix.addUpdateRange(0, pool.mesh.count * 16);
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const pool of this.#effectPools.values()) {
      if (pool.mesh.count === 0) continue;
      pool.mesh.instanceMatrix.clearUpdateRanges();
      pool.mesh.instanceMatrix.addUpdateRange(0, pool.mesh.count * 16);
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.mesh.instanceColor !== null) {
        pool.mesh.instanceColor.clearUpdateRanges();
        pool.mesh.instanceColor.addUpdateRange(0, pool.mesh.count * 3);
        pool.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.#renderer.render(this.#scene, this.#camera);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.#canvas.removeEventListener("webglcontextrestored", this.#onContextRestored);
    for (const pool of this.#pools.values()) pool.material.dispose();
    this.#pools.clear();
    for (const pool of this.#effectPools.values()) pool.material.dispose();
    this.#effectPools.clear();
    for (const texture of this.#textures.values()) texture.dispose();
    this.#textures.clear();
    this.#markedCellPulses.clear();
    this.#cellGeometry.dispose();
    this.#acidGeometry.dispose();
    this.#effectGeometry.dispose();
    for (const panel of this.#panels) {
      panel.fill.geometry.dispose();
      panel.fill.material.dispose();
      panel.border.geometry.dispose();
      panel.border.material.dispose();
    }
    this.#renderer.dispose();
  }

  #createPanel(): BoardPanel {
    const fill = new Mesh(
      createUnitPanelGeometry(),
      new MeshBasicMaterial({ color: 0x0c1322, transparent: true, opacity: 0.94 }),
    );
    fill.position.z = -2;
    const border = new LineLoop(
      createUnitBorderGeometry(),
      new LineBasicMaterial({ color: 0x53637d, transparent: true, opacity: 0.8 }),
    );
    border.position.z = -1.5;
    return { fill, border };
  }

  #resize(mode: GameRenderFrame["mode"]): void {
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    const hostWindow = this.#canvas.ownerDocument.defaultView;
    const devicePixelRatio = hostWindow?.devicePixelRatio ?? 1;
    const pixelRatio = Math.min(devicePixelRatio, this.#quality.profile.maxPixelRatio);
    const layoutKey = `${width}:${height}:${mode}:${pixelRatio}`;
    if (layoutKey === this.#lastLayoutKey && pixelRatio === this.#pixelRatio) return;

    this.#lastLayoutKey = layoutKey;
    this.#pixelRatio = pixelRatio;
    this.#renderer.setPixelRatio(pixelRatio);
    this.#renderer.setSize(width, height, false);
    this.#camera.left = 0;
    this.#camera.right = width;
    this.#camera.top = height;
    this.#camera.bottom = 0;
    this.#camera.updateProjectionMatrix();
    this.#layout = calculateRendererLayout(width, height, mode);
    this.#options.onLayout?.(this.#layout);
  }

  #drawBoard(
    board: BoardRenderModel | null,
    viewport: BoardViewport | null,
    panel: BoardPanel,
    movementEffect?: PresentationEffect,
  ): void {
    const visible = board !== null && viewport !== null;
    panel.fill.visible = visible;
    panel.border.visible = visible;
    if (!visible || board === null || viewport === null) return;

    const centerX = viewport.boardX + viewport.boardWidth / 2;
    const centerY = this.#layout.height - (viewport.boardY + viewport.boardHeight / 2);
    panel.fill.position.set(centerX, centerY, -2);
    panel.fill.scale.set(viewport.boardWidth, viewport.boardHeight, 1);
    panel.border.position.set(centerX, centerY, -1.5);
    panel.border.scale.set(viewport.boardWidth, viewport.boardHeight, 1);
    panel.border.material.color.setHex(board.focused ? 0xa9eaff : 0x53637d);
    panel.border.material.opacity = board.focused ? 1 : 0.65;

    if (board.concealed) return;
    for (const cell of board.cells) this.#drawCell(cell, viewport, movementEffect);
    this.#drawBoardStatus(board, viewport);
  }

  #drawCell(
    cell: RenderCellModel,
    viewport: BoardViewport,
    movementEffect?: PresentationEffect,
  ): void {
    if (
      cell.column < 0 ||
      cell.column >= RULES.board.width ||
      cell.row < RULES.board.hiddenRows ||
      cell.row >= RULES.board.height
    ) {
      return;
    }
    const pool = this.#poolFor(cell);
    if (pool.mesh.count >= MAX_INSTANCES_PER_POOL) return;
    pool.mesh.visible = true;

    const visualRow = movementEffect?.kind === "collapse"
      ? collapseCellVisualRow(movementEffect, cell.column, cell.row)
      : movementEffect?.kind === "garbage-rise"
        ? garbageCellVisualRow(movementEffect, cell.row)
        : cell.row;
    const visibleRow = visualRow - RULES.board.hiddenRows;
    const x = viewport.boardX + (cell.column + 0.5) * viewport.cellSize;
    const top = viewport.boardY + (visibleRow + 0.5) * viewport.cellSize;
    const y = this.#layout.height - top;
    const inset = cell.role === "ghost" ? 0.7 : 0.88;
    this.#position.set(x, y, cell.role === "active" ? 0.7 : 0);
    this.#scale.set(
      viewport.cellSize * inset,
      viewport.cellSize * inset,
      viewport.cellSize,
    );
    this.#matrix.compose(this.#position, this.#camera.quaternion, this.#scale);
    pool.mesh.setMatrixAt(pool.mesh.count, this.#matrix);
    pool.mesh.count += 1;
    if (cell.special !== undefined) {
      const presentation = markedCellPresentationAt(
        cell.special,
        cell.role,
        this.#markedCellQuality(),
        this.#frameTimestampMs,
        cell.specialEmphasis,
      );
      const haloZ = cell.role === "active" ? 0.45 : -0.2;
      this.#drawEffectTexture(
        `special-halo-${cell.role}-${cell.special}`,
        this.#specialHaloTexture(cell.special),
        x,
        y,
        viewport.cellSize * presentation.haloScale * 1.6,
        viewport.cellSize * presentation.haloScale * 1.6,
        1,
        {
          z: haloZ,
          additive: true,
          instanceIntensity: presentation.haloOpacity,
        },
      );
      const span = viewport.cellSize * presentation.rimScale;
      const edge = viewport.cellSize * (cell.role === "ghost" ? 0.035 : 0.07);
      for (const [rimX, rimY, width, height] of [
        [x, y - span / 2, span, edge],
        [x, y + span / 2, span, edge],
        [x - span / 2, y, edge, span],
        [x + span / 2, y, edge, span],
      ] as const) {
        this.#drawEffectRect(
          `special-rim-${cell.role}-${cell.special}`,
          presentation.accent,
          rimX,
          rimY,
          width,
          height,
          1,
          {
            z: cell.role === "active" ? 1.2 : 0.65,
            countsTowardPresentationLimit: false,
            instanceIntensity: presentation.rimOpacity,
          },
        );
      }
      if (cell.role !== "ghost") {
        this.#drawEffectTexture(
          `special-badge-${cell.special}`,
          this.#specialBadgeTexture(cell.special),
          x,
          y,
          viewport.cellSize,
          viewport.cellSize,
          1,
          {
            z: viewport.cellSize * 0.1 +
              (cell.role === "active" ? 0.7 : 0),
          },
        );
      }
    }
  }

  #drawBoardStatus(board: BoardRenderModel, viewport: BoardViewport): void {
    const bottomY = this.#layout.height - (viewport.boardY + viewport.boardHeight);
    const incoming = Math.max(0, board.incomingGarbage ?? 0);
    if (incoming > 0) {
      const strength = Math.min(1, incoming / 4);
      this.#drawEffectRect(
        "garbage-pressure",
        0xff755d,
        viewport.boardX + viewport.boardWidth / 2,
        bottomY - viewport.cellSize * 0.12,
        viewport.boardWidth,
        viewport.cellSize * (0.12 + strength * 0.18),
        0.25 + strength * 0.45,
      );
    }

    const capacity = Math.max(0, Math.min(4, board.barrierCapacity ?? 0));
    if (capacity > 0) {
      const gap = viewport.cellSize * 0.12;
      const segmentWidth = (viewport.boardWidth - gap * 3) / 4;
      for (let segment = 0; segment < 4; segment += 1) {
        this.#drawEffectRect(
          segment < capacity ? "barrier-active" : "barrier-empty",
          segment < capacity ? 0x68eaff : 0x263c52,
          viewport.boardX + segmentWidth / 2 + segment * (segmentWidth + gap),
          bottomY + viewport.cellSize * 0.08,
          segmentWidth,
          viewport.cellSize * 0.14,
          segment < capacity ? 0.82 : 0.28,
        );
      }
    }

    if (board.scrambled === true) {
      const width = viewport.cellSize * 0.1;
      this.#drawEffectRect(
        "scramble-edge",
        0xff5cdb,
        viewport.boardX + width / 2,
        bottomY + viewport.boardHeight / 2,
        width,
        viewport.boardHeight,
        0.72,
      );
      this.#drawEffectRect(
        "scramble-edge",
        0xff5cdb,
        viewport.boardX + viewport.boardWidth - width / 2,
        bottomY + viewport.boardHeight / 2,
        width,
        viewport.boardHeight,
        0.72,
      );
    }

    if (board.monominoRush === true) {
      for (const cell of board.cells) {
        if (cell.kind !== "monomino" || cell.role !== "active") continue;
        const point = this.#cellPoint(viewport, cell.column, cell.row);
        this.#drawEffectRect(
          "monomino-trail",
          0xc5f5ff,
          point.x,
          point.y + viewport.cellSize * 0.36,
          viewport.cellSize * 0.28,
          viewport.cellSize * 0.48,
          0.34,
        );
      }
    }
  }

  #drawPresentation(presentation: PresentationFrame | undefined): void {
    if (presentation === undefined) return;
    if (presentation.shake !== null && this.#quality.profile.screenShake) {
      this.#scene.position.set(
        presentation.shake.x * 3,
        presentation.shake.y * 3,
        0,
      );
    }
    for (const effect of presentation.effects) {
      const viewport = effect.board === "left" ? this.#layout.left : this.#layout.right;
      if (viewport === null) continue;
      this.#drawPresentationEffect(effect, viewport);
    }
  }

  #drawPresentationEffect(
    effect: PresentationEffect,
    viewport: BoardViewport,
  ): void {
    const visualEffect = this.#quality.profile.effects === "reduced"
      ? { ...effect, visualStyle: "fade" as const }
      : effect;
    const motion = presentationMotionTransform(visualEffect);
    const bottomY = this.#layout.height - (viewport.boardY + viewport.boardHeight);
    const centerX = viewport.boardX + viewport.boardWidth / 2;
    const centerY = bottomY + viewport.boardHeight / 2;
    if (effect.kind === "line-clear") {
      for (const row of effect.rows ?? []) {
        const point = this.#cellPoint(viewport, 0, row);
        const height = viewport.cellSize * (visualEffect.visualStyle === "fade"
          ? 0.28
          : effect.moment === "compress" ? 1 - effect.stageProgress * 0.62 : 0.28);
        this.#drawEffectRect(
          "line-clear",
          0xeaffff,
          centerX,
          point.y,
          viewport.boardWidth,
          height,
          effect.flash ? 0.92 : 0.52,
        );
      }
    } else if (effect.kind === "garbage-rise") {
      const rows = Math.max(1, effect.rowCount ?? 1);
      this.#drawEffectRect(
        "garbage-rise",
        0xff755d,
        centerX,
        bottomY - viewport.cellSize * 0.12 +
          motion.garbageLift * rows * viewport.cellSize * 0.5,
        viewport.boardWidth,
        Math.min(rows, 4) * viewport.cellSize * 0.32,
        0.58,
      );
    } else if (effect.kind === "offensive-transfer") {
      const sourceViewport = effect.source === "left"
        ? this.#layout.left
        : this.#layout.right;
      const targetViewport = effect.target === "left"
        ? this.#layout.left
        : this.#layout.right;
      if (sourceViewport !== null && targetViewport !== null) {
        const sourceX = sourceViewport.boardX + sourceViewport.boardWidth / 2;
        const targetX = targetViewport.boardX + targetViewport.boardWidth / 2;
        const transferX = sourceX + (targetX - sourceX) * motion.transferTravel;
        const color = offensiveTransferColor(effect.attack);
        if (effect.attack === "oversize") {
          const blockSize = viewport.cellSize * 0.42 * motion.oversizeScale;
          for (const [column, row] of [
            [-1, 0],
            [0, 0],
            [1, 0],
            [0, -1],
          ] as const) {
            this.#drawEffectRect(
              "transfer-oversize",
              color,
              transferX + column * blockSize,
              centerY + row * blockSize,
              blockSize * 0.84,
              blockSize * 0.84,
              visualEffect.visualStyle === "fade" ? 0.7 : 0.86,
            );
          }
        } else {
          this.#drawEffectRect(
            `transfer-${effect.attack ?? "power"}`,
            color,
            transferX,
            centerY,
            viewport.cellSize * (0.55 + (effect.moment === "impact" ? 0.8 : 0)),
            effect.attack === "ghost-jam"
              ? viewport.cellSize * 0.18
              : viewport.cellSize * 0.55,
            0.82,
          );
        }
      }
    } else if (effect.kind === "nuke" && effect.center !== undefined) {
      const point = this.#cellPoint(
        viewport,
        effect.center.column,
        effect.center.row,
      );
      const size = viewport.cellSize * 5;
      const scale = motion.nukeScale;
      if (effect.moment === "shockwave") {
        this.#drawEffectRect(
          "nuke-shockwave",
          0xffffff,
          point.x,
          point.y,
          size * scale,
          size * scale,
          0.5,
        );
      } else {
        const edge = viewport.cellSize * 0.09;
        const span = size * scale;
        for (const [x, y, width, height] of [
          [point.x, point.y - span / 2, span, edge],
          [point.x, point.y + span / 2, span, edge],
          [point.x - span / 2, point.y, edge, span],
          [point.x + span / 2, point.y, edge, span],
        ] as const) {
          this.#drawEffectRect(
            "nuke-reticle",
            0xffd35c,
            x,
            y,
            width,
            height,
            0.82,
          );
        }
      }
      this.#drawParticleBurst(effect, viewport, point.x, point.y, 0xffd35c);
    } else if (effect.kind === "acid-dissolve") {
      for (const row of effect.resolvedRows ?? []) {
        const point = this.#cellPoint(viewport, effect.column ?? 0, row);
        const scale = visualEffect.visualStyle === "fade"
          ? 1
          : Math.max(0.12, 1 - effect.stageProgress * 0.72);
        this.#drawEffectRect(
          "acid-dissolve",
          0x75ff55,
          point.x,
          point.y,
          viewport.cellSize * scale,
          viewport.cellSize * scale,
          0.7,
        );
      }
    } else if (effect.kind === "collapse") {
      const height = viewport.cellSize *
        (effect.moment === "fall" ? 0.18 + effect.stageProgress * 0.45 : 0.2);
      this.#drawEffectRect(
        "collapse",
        0x76d9ff,
        centerX,
        centerY - viewport.boardHeight * 0.35 * motion.collapseTravel,
        viewport.boardWidth,
        height,
        0.42,
      );
      for (const row of effect.completedRows ?? []) {
        const point = this.#cellPoint(viewport, 0, row);
        this.#drawEffectRect(
          "line-clear",
          0xeaffff,
          centerX,
          point.y,
          viewport.boardWidth,
          viewport.cellSize * 0.25,
          0.64,
        );
      }
    } else if (effect.kind === "barrier") {
      const capacity = Math.max(0, Math.min(4, effect.capacity ?? 4));
      const width = viewport.boardWidth / 4;
      for (let segment = 0; segment < capacity; segment += 1) {
        this.#drawEffectRect(
          "barrier-flare",
          0x68eaff,
          viewport.boardX + width * (segment + 0.5),
          bottomY + viewport.cellSize * 0.08,
          width * 0.82,
          viewport.cellSize * 0.18,
          0.9,
        );
      }
    } else if (effect.kind === "blackout") {
      const scale = visualEffect.visualStyle === "fade"
        ? 1
        : Math.max(0.04, effect.stageProgress);
      this.#drawEffectRect(
        "blackout-veil",
        0x02040a,
        centerX,
        centerY,
        viewport.boardWidth * scale,
        viewport.boardHeight,
        0.86,
        { additive: false },
      );
    } else if (effect.kind === "scramble") {
      const offset = motion.scrambleOscillation * viewport.cellSize;
      this.#drawEffectRect(
        "scramble-glitch",
        0xff5cdb,
        centerX + offset,
        centerY,
        viewport.boardWidth,
        viewport.cellSize * 0.16,
        0.58,
      );
    } else if (effect.kind === "ghost-jam") {
      if (effect.stage === "follow-through") {
        this.#drawParticleBurst(
          effect,
          viewport,
          centerX,
          centerY,
          SPECIAL_ACCENT_HEX.barrier,
        );
      } else {
        const jitter = visualEffect.visualStyle === "fade"
          ? 0
          : motion.ghostJamFlicker * viewport.cellSize * 0.16;
        const opacity = visualEffect.visualStyle === "fade"
          ? 0.58
          : motion.ghostJamOpacity *
            (0.46 + Math.abs(motion.ghostJamFlicker) * 0.34);
        const blockSize = viewport.cellSize * 0.74;
        for (const point of effect.ghostCells ?? []) {
          if (
            point.column < 0 ||
            point.column >= RULES.board.width ||
            point.row < RULES.board.hiddenRows ||
            point.row >= RULES.board.height
          ) continue;
          const cellX = viewport.boardX + (point.column + 0.5) * viewport.cellSize;
          const cellTop = viewport.boardY +
            (point.row - RULES.board.hiddenRows + 0.5) * viewport.cellSize;
          const cellY = this.#layout.height - cellTop;
          this.#drawEffectRect(
            "ghost-jam-cell",
            SPECIAL_ACCENT_HEX.barrier,
            cellX + jitter * (point.column % 2 === 0 ? 1 : -1),
            cellY,
            blockSize,
            blockSize,
            opacity * 0.48,
          );
        }
      }
    } else if (effect.kind === "monomino-rush") {
      if (visualEffect.visualStyle === "fade") {
        this.#drawEffectRect(
          "monomino-fade",
          0xc5f5ff,
          centerX,
          centerY,
          viewport.cellSize * 1.4,
          viewport.cellSize * 1.4,
          0.45,
        );
      } else {
        this.#drawParticleBurst(effect, viewport, centerX, centerY, 0xc5f5ff);
      }
    } else if (effect.kind === "acid-rain") {
      if (effect.stage !== "follow-through") {
        for (const column of [2, 5, 7]) {
          this.#drawCell(
            {
              column,
              row: RULES.board.hiddenRows + 1,
              kind: "acid",
              role: "active",
            },
            viewport,
          );
        }
      }
    } else if (effect.kind === "special-chain") {
      for (const special of effect.resolvedSpecials ?? []) {
        const point = this.#cellPoint(viewport, special.column, special.row);
        const color = SPECIAL_ACCENT_HEX[special.special];
        this.#drawEffectRect(
          `special-${special.special}`,
          color,
          point.x,
          point.y,
          viewport.cellSize * 1.3,
          viewport.cellSize * 1.3,
          0.5,
        );
        this.#drawParticleBurst(
          { ...effect, id: `${effect.id}:${special.row}:${special.column}` },
          viewport,
          point.x,
          point.y,
          color,
        );
      }
    }
  }

  #drawParticleBurst(
    effect: PresentationEffect,
    viewport: BoardViewport,
    centerX: number,
    centerY: number,
    color: number,
  ): void {
    const count = Math.min(effect.particleCount, MAX_PRESENTATION_PARTICLES);
    let seed = 0;
    for (let index = 0; index < effect.id.length; index += 1) {
      seed = (seed * 33 + effect.id.charCodeAt(index)) >>> 0;
    }
    for (let index = 0; index < count; index += 1) {
      const angle = ((seed + index * 2_654_435_761) >>> 0) / 0xffffffff * Math.PI * 2;
      const radius = viewport.cellSize *
        (0.25 + (index % 7) * 0.14) * (0.3 + effect.stageProgress * 1.8);
      const size = viewport.cellSize * (0.06 + (index % 3) * 0.025);
      this.#drawEffectRect(
        `particles-${color}`,
        color,
        centerX + Math.cos(angle) * radius,
        centerY + Math.sin(angle) * radius,
        size,
        size,
        0.72,
      );
    }
  }

  #cellPoint(
    viewport: BoardViewport,
    column: number,
    row: number,
  ): { readonly x: number; readonly y: number } {
    const visibleRow = row - RULES.board.hiddenRows;
    return {
      x: viewport.boardX + (column + 0.5) * viewport.cellSize,
      y: this.#layout.height -
        (viewport.boardY + (visibleRow + 0.5) * viewport.cellSize),
    };
  }

  #drawEffectRect(
    key: string,
    color: number,
    x: number,
    y: number,
    width: number,
    height: number,
    opacity: number,
    options: EffectRectOptions = {},
  ): void {
    const countsTowardPresentationLimit =
      options.countsTowardPresentationLimit ?? true;
    if (
      countsTowardPresentationLimit &&
      this.#effectInstanceCount >= MAX_PRESENTATION_PARTICLES
    ) {
      return;
    }
    const instanceLimit = countsTowardPresentationLimit
      ? MAX_PRESENTATION_PARTICLES
      : MAX_INSTANCES_PER_POOL;
    const pool = this.#effectPoolFor(
      key,
      color,
      options.additive ?? true,
      instanceLimit,
    );
    if (pool.mesh.count >= instanceLimit) return;
    pool.mesh.visible = true;
    const intensity = options.instanceIntensity;
    pool.material.opacity = intensity === undefined
      ? Math.max(0, Math.min(1, opacity))
      : 1;
    this.#position.set(x, y, options.z ?? 3);
    this.#scale.set(Math.max(0.01, width), Math.max(0.01, height), 1);
    this.#matrix.compose(this.#position, this.#camera.quaternion, this.#scale);
    pool.mesh.setMatrixAt(pool.mesh.count, this.#matrix);
    if (intensity !== undefined) {
      const value = Math.max(0, Math.min(1, intensity));
      this.#instanceColor.setRGB(value, value, value);
      pool.mesh.setColorAt(pool.mesh.count, this.#instanceColor);
    } else if (pool.mesh.instanceColor !== null) {
      this.#instanceColor.setRGB(1, 1, 1);
      pool.mesh.setColorAt(pool.mesh.count, this.#instanceColor);
    }
    pool.mesh.count += 1;
    if (countsTowardPresentationLimit) this.#effectInstanceCount += 1;
  }

  #drawEffectTexture(
    key: string,
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    opacity: number,
    options: EffectTextureOptions = {},
  ): void {
    const pool = this.#effectPoolFor(
      key,
      0xffffff,
      options.additive ?? false,
      MAX_INSTANCES_PER_POOL,
      texture,
    );
    if (pool.mesh.count >= MAX_INSTANCES_PER_POOL) return;
    pool.mesh.visible = true;
    const intensity = options.instanceIntensity;
    pool.material.opacity = intensity === undefined
      ? Math.max(0, Math.min(1, opacity))
      : 1;
    this.#position.set(x, y, options.z ?? 3);
    this.#scale.set(Math.max(0.01, width), Math.max(0.01, height), 1);
    this.#matrix.compose(this.#position, this.#camera.quaternion, this.#scale);
    pool.mesh.setMatrixAt(pool.mesh.count, this.#matrix);
    if (intensity !== undefined) {
      const value = Math.max(0, Math.min(1, intensity));
      this.#instanceColor.setRGB(value, value, value);
      pool.mesh.setColorAt(pool.mesh.count, this.#instanceColor);
    } else if (pool.mesh.instanceColor !== null) {
      this.#instanceColor.setRGB(1, 1, 1);
      pool.mesh.setColorAt(pool.mesh.count, this.#instanceColor);
    }
    pool.mesh.count += 1;
  }

  #effectPoolFor(
    key: string,
    color: number,
    additive: boolean,
    instanceLimit: number,
    texture?: Texture,
  ): EffectPool {
    const poolKey = `${key}:${additive ? "add" : "normal"}:${instanceLimit}`;
    const existing = this.#effectPools.get(poolKey);
    if (existing !== undefined) return existing;
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      map: texture ?? null,
      toneMapped: texture === undefined,
      ...(additive ? { blending: AdditiveBlending } : {}),
    });
    const mesh = new InstancedMesh(
      this.#effectGeometry,
      material,
      instanceLimit,
    );
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.#scene.add(mesh);
    const created = { mesh, material };
    this.#effectPools.set(poolKey, created);
    return created;
  }

  #poolFor(cell: RenderCellModel): CellPool {
    const key = `${cell.kind}:${cell.role}:${cell.special ?? "ordinary"}`;
    const existing = this.#pools.get(key);
    if (existing !== undefined) return existing;

    const baseColor = new Color(this.#colors()[cell.kind]);
    const isGhost = cell.role === "ghost";
    const texture = isGhost ? null : this.#patternTexture(cell.kind);
    const material = new MeshStandardMaterial({
      color: baseColor,
      map: texture,
      emissive: 0x000000,
      metalness: cell.kind === "garbage" ? 0.58 : 0.22,
      roughness: cell.kind === "garbage" ? 0.78 : 0.42,
      transparent: isGhost,
      opacity: isGhost ? 0.2 : 1,
      depthWrite: !isGhost,
      wireframe: isGhost,
    });
    const mesh = new InstancedMesh(
      cell.kind === "acid" ? this.#acidGeometry : this.#cellGeometry,
      material,
      MAX_INSTANCES_PER_POOL,
    );
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.#scene.add(mesh);
    const created = { mesh, material };
    this.#pools.set(key, created);
    return created;
  }

  #colors(): Readonly<Record<PieceVisualKind, string>> {
    return this.#palette === "colorblind"
      ? COLORBLIND_PIECE_COLORS
      : STANDARD_PIECE_COLORS;
  }

  #markedCellQuality(): EffectQuality {
    return this.#staticMarkedCells ? "reduced" : this.#quality.profile.effects;
  }

  #patternTexture(kind: RenderCellKind): Texture | null {
    const textureKey = `pattern:${kind}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 64, 64);
    context.strokeStyle = "rgba(18, 24, 38, 0.28)";
    context.fillStyle = "rgba(18, 24, 38, 0.25)";
    context.lineWidth = 5;

    switch (PIECE_PATTERNS[kind]) {
      case "diagonal":
        for (let offset = -64; offset <= 64; offset += 16) {
          context.beginPath();
          context.moveTo(offset, 64);
          context.lineTo(offset + 64, 0);
          context.stroke();
        }
        break;
      case "vertical":
        for (let x = 8; x < 64; x += 16) context.fillRect(x, 0, 5, 64);
        break;
      case "horizontal":
        for (let y = 8; y < 64; y += 16) context.fillRect(0, y, 64, 5);
        break;
      case "dots":
        for (let y = 12; y < 64; y += 20) {
          for (let x = 12; x < 64; x += 20) {
            context.beginPath();
            context.arc(x, y, 4, 0, Math.PI * 2);
            context.fill();
          }
        }
        break;
      case "chevron-left":
        for (let x = -16; x < 64; x += 24) {
          context.beginPath();
          context.moveTo(x, 16);
          context.lineTo(x + 12, 28);
          context.lineTo(x, 40);
          context.stroke();
        }
        break;
      case "crosses":
        for (let y = 16; y < 64; y += 32) {
          for (let x = 16; x < 64; x += 32) {
            context.fillRect(x - 3, y - 10, 6, 20);
            context.fillRect(x - 10, y - 3, 20, 6);
          }
        }
        break;
      case "chevron-right":
        for (let offset = -32; offset <= 64; offset += 24) {
          context.beginPath();
          context.moveTo(offset, 0);
          context.lineTo(offset + 28, 28);
          context.lineTo(offset, 56);
          context.stroke();
        }
        break;
      case "grid":
        context.lineWidth = 3;
        for (let index = 0; index <= 64; index += 16) {
          context.beginPath();
          context.moveTo(index, 0);
          context.lineTo(index, 64);
          context.moveTo(0, index);
          context.lineTo(64, index);
          context.stroke();
        }
        break;
      case "cross":
        context.lineWidth = 7;
        context.beginPath();
        context.moveTo(32, 5);
        context.lineTo(32, 59);
        context.moveTo(5, 32);
        context.lineTo(59, 32);
        context.stroke();
        break;
      case "circle":
        context.lineWidth = 6;
        context.beginPath();
        context.arc(32, 32, 17, 0, Math.PI * 2);
        context.stroke();
        break;
      case "bubbles":
        for (const [x, y, radius] of [
          [16, 18, 6],
          [43, 14, 4],
          [38, 43, 8],
          [13, 48, 3],
        ] as const) {
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.stroke();
        }
        break;
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(1.25, 1.25);
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #specialBadgeTexture(special: SpecialKind): Texture {
    const textureKey = `special-badge:${special}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for special badge");

    context.fillStyle = "rgba(5, 8, 16, 0.98)";
    context.strokeStyle = SPECIAL_ACCENT_COLORS[special];
    context.lineWidth = 3;
    context.beginPath();
    context.arc(32, 32, 26, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.strokeStyle = SPECIAL_ACCENT_COLORS[special];
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 5;
    context.save();
    context.translate(5.76, 5.76);
    context.scale(0.82, 0.82);
    context.stroke(new Path2D(SPECIAL_ICON_PATHS[special]));
    context.restore();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #specialHaloTexture(special: SpecialKind): Texture {
    const textureKey = `special-halo:${special}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for special halo");

    const accent = SPECIAL_ACCENT_HEX[special];
    const red = accent >> 16 & 0xff;
    const green = accent >> 8 & 0xff;
    const blue = accent & 0xff;
    const rgba = (alpha: number): string =>
      `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    const gradient = context.createRadialGradient(64, 64, 26, 64, 64, 64);
    gradient.addColorStop(0, rgba(0.78));
    gradient.addColorStop(0.28, rgba(0.52));
    gradient.addColorStop(0.58, rgba(0.22));
    gradient.addColorStop(0.82, rgba(0.08));
    gradient.addColorStop(1, rgba(0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  readonly #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.#contextLost = true;
    this.#options.onContextLost?.();
  };

  readonly #onContextRestored = (): void => {
    this.#contextLost = false;
    this.#pixelRatio = 0;
    this.#lastLayoutKey = "";
    this.#options.onContextRestored?.();
  };
}

export function createThreeRenderer(
  canvas: HTMLCanvasElement,
  options: ThreeRendererOptions = {},
): ThreeRenderer | null {
  try {
    return new ThreeRenderer(canvas, options);
  } catch (error) {
    if (error instanceof WebGlUnavailableError) return null;
    throw error;
  }
}
