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
  PIECE_CELL_ART,
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
  type PieceVisualKind,
} from "./piece-visual-tokens";
import {
  QualityController,
  type EffectQuality,
  type RenderQualityProfile,
} from "./quality";
import {
  markedCellPresentationAt,
  resolveMarkedNeighborFields,
  type MarkedCellPresentation,
} from "./marked-cell-field";
import { MarkedCellPulseTracker } from "./marked-cell-pulses";

export {
  MARKED_CELL_FIELD_DURATION_MS,
  markedCellFieldEnvelopeAt,
  markedCellPresentationAt,
  resolveMarkedNeighborFields,
} from "./marked-cell-field";

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
  /** Distinguishes the stronger spawn ignition from the quieter lock settle. */
  readonly specialEmphasisKind?: "spawn" | "lock";
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

const MARKED_ACTIVATION_HALO_SPAN = 1.72;

function markedCellClipMask(cell: Pick<RenderCellModel, "column" | "row">): string {
  return `${cell.column === 0 ? "l" : ""}${
    cell.column === RULES.board.width - 1 ? "r" : ""
  }${cell.row === RULES.board.hiddenRows ? "t" : ""}${
    cell.row === RULES.board.height - 1 ? "b" : ""
  }`;
}

function effectRenderOrderFor(key: string): number {
  if (key.startsWith("special-activation-")) return 30;
  if (key.startsWith("marked-neighbor-surface-")) return 5;
  if (key.startsWith("marked-neighbor-rim-")) return 6;
  if (key.startsWith("marked-source-face-")) return 7;
  if (key.startsWith("marked-source-rim-")) return 8;
  if (key.startsWith("marked-source-glyph-")) return 9;
  return 20;
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
      return 0xff8ade;
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
const BOARD_STATUS_GAP_PX = 6;
const POWER_RAIL_WIDTH_PX = 22;
const BOARD_RAIL_GAP_PX = 4;
const INTER_RAIL_GAP_PX = 2;
const VERSUS_CENTER_CORRIDOR_PX =
  BOARD_RAIL_GAP_PX * 2 + POWER_RAIL_WIDTH_PX * 2 + INTER_RAIL_GAP_PX;

interface CellPool {
  readonly mesh: InstancedMesh;
  readonly material: MeshStandardMaterial;
  readonly kind: RenderCellKind;
  readonly role: RenderCellRole;
  readonly special: SpecialKind | undefined;
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
  readonly #cellGeometry = new RoundedBoxGeometry(
    1,
    1,
    PIECE_CELL_ART.cornerRadius * 2,
    3,
    PIECE_CELL_ART.cornerRadius,
  );
  readonly #limitedCellGeometry = new RoundedBoxGeometry(
    1,
    1,
    PIECE_CELL_ART.cornerRadius * 2,
    2,
    PIECE_CELL_ART.cornerRadius,
  );
  readonly #reducedCellGeometry = new RoundedBoxGeometry(
    1,
    1,
    PIECE_CELL_ART.cornerRadius * 2,
    1,
    PIECE_CELL_ART.cornerRadius,
  );
  readonly #garbageGeometry = new RoundedBoxGeometry(
    1,
    1,
    PIECE_CELL_ART.garbageCornerRadius * 2,
    2,
    PIECE_CELL_ART.garbageCornerRadius,
  );
  readonly #reducedGarbageGeometry = new RoundedBoxGeometry(
    1,
    1,
    PIECE_CELL_ART.garbageCornerRadius * 2,
    1,
    PIECE_CELL_ART.garbageCornerRadius,
  );
  readonly #monominoGeometry = new RoundedBoxGeometry(1, 1, 0.92, 3, 0.46);
  readonly #limitedMonominoGeometry = new RoundedBoxGeometry(1, 1, 0.92, 2, 0.46);
  readonly #reducedMonominoGeometry = new RoundedBoxGeometry(1, 1, 0.92, 1, 0.46);
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
  #defaultEffectZ = 3;
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
      for (const pool of this.#pools.values()) {
        pool.mesh.geometry = this.#cellGeometryFor(pool.kind, pool.role);
        this.#refreshCellPoolMaterial(pool);
      }
      this.#pixelRatio = 0;
      this.#options.onQualityChanged?.(this.#quality.profile);
    }
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
    for (const pool of this.#pools.values()) this.#refreshCellPoolMaterial(pool);
  }

  render(frame: GameRenderFrame, timestampMs = performance.now()): void {
    if (this.#disposed || this.#contextLost) return;
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
    this.#defaultEffectZ = 3;
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
    this.#limitedCellGeometry.dispose();
    this.#reducedCellGeometry.dispose();
    this.#garbageGeometry.dispose();
    this.#reducedGarbageGeometry.dispose();
    this.#monominoGeometry.dispose();
    this.#limitedMonominoGeometry.dispose();
    this.#reducedMonominoGeometry.dispose();
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
    for (const cell of board.cells) {
      this.#drawCellBase(cell, viewport, movementEffect);
    }
    this.#drawMarkedNeighborFields(board, viewport, movementEffect);
    for (const cell of board.cells) {
      this.#drawMarkedSource(cell, viewport, movementEffect);
    }
    this.#drawBoardStatus(board, viewport);
  }

  #markedPresentation(cell: RenderCellModel): MarkedCellPresentation | null {
    if (cell.special === undefined) return null;
    return markedCellPresentationAt(
      cell.special,
      cell.role,
      this.#markedCellQuality(),
      this.#frameTimestampMs,
      cell.specialEmphasis,
      cell.specialEmphasisKind,
      this.#staticMarkedCells,
    );
  }

  #cellVisualPoint(
    cell: RenderCellModel,
    viewport: BoardViewport,
    movementEffect?: PresentationEffect,
  ): { readonly x: number; readonly y: number } {
    const visualRow = movementEffect?.kind === "collapse"
      ? collapseCellVisualRow(movementEffect, cell.column, cell.row)
      : movementEffect?.kind === "garbage-rise"
        ? garbageCellVisualRow(movementEffect, cell.row)
        : cell.row;
    return this.#cellPoint(viewport, cell.column, visualRow);
  }

  #cellIsVisible(cell: Pick<RenderCellModel, "column" | "row">): boolean {
    return cell.column >= 0 &&
      cell.column < RULES.board.width &&
      cell.row >= RULES.board.hiddenRows &&
      cell.row < RULES.board.height;
  }

  #drawCellBase(
    cell: RenderCellModel,
    viewport: BoardViewport,
    movementEffect?: PresentationEffect,
  ): void {
    if (!this.#cellIsVisible(cell)) return;
    const presentation = this.#markedPresentation(cell);
    const pool = this.#poolFor(cell);
    if (pool.mesh.count >= MAX_INSTANCES_PER_POOL) return;
    pool.mesh.visible = true;
    if (presentation !== null) {
      pool.material.emissive.setHex(presentation.accent);
      pool.material.emissiveIntensity = presentation.emissiveIntensity;
    }

    const { x, y } = this.#cellVisualPoint(cell, viewport, movementEffect);
    const inset = cell.role === "ghost"
      ? PIECE_CELL_ART.ghostInset
      : PIECE_CELL_ART.inset;
    const depthScale = cell.kind === "monomino"
      ? 0.3
      : cell.kind === "garbage" || cell.kind === "acid"
        ? 1
        : 0.75;
    this.#position.set(x, y, cell.role === "active" ? 0.7 : 0);
    this.#scale.set(
      viewport.cellSize * inset,
      viewport.cellSize * inset,
      viewport.cellSize * depthScale,
    );
    this.#matrix.compose(this.#position, this.#camera.quaternion, this.#scale);
    pool.mesh.setMatrixAt(pool.mesh.count, this.#matrix);
    pool.mesh.count += 1;
  }

  #drawMarkedNeighborFields(
    board: BoardRenderModel,
    viewport: BoardViewport,
    movementEffect?: PresentationEffect,
  ): void {
    const targets = new Map<string, RenderCellModel>();
    const visibleCells = board.cells.filter((cell) => this.#cellIsVisible(cell));
    for (const cell of visibleCells) {
      if (cell.role === "ghost") continue;
      const key = `${cell.column}:${cell.row}`;
      if (!targets.has(key)) targets.set(key, cell);
    }
    const overlayBaseZ = viewport.cellSize * 0.15 + 0.85;
    for (const field of resolveMarkedNeighborFields(visibleCells)) {
      const target = targets.get(`${field.targetColumn}:${field.targetRow}`);
      if (target === undefined) continue;
      const presentation = markedCellPresentationAt(
        field.sourceSpecial,
        field.sourceRole,
        this.#markedCellQuality(),
        this.#frameTimestampMs,
        field.sourceEmphasis,
        field.sourceEmphasisKind,
        this.#staticMarkedCells,
      );
      const { x, y } = this.#cellVisualPoint(target, viewport, movementEffect);
      const directionKey = `${field.directionX}:${field.directionY}`;
      const span = viewport.cellSize * 0.91;
      if (presentation.neighborSurfaceOpacity > 0) {
        this.#drawEffectTexture(
          `marked-neighbor-surface-${field.sourceSpecial}-${directionKey}`,
          this.#markedNeighborFieldTexture(
            field.sourceSpecial,
            field.directionX,
            field.directionY,
            "surface",
          ),
          x,
          y,
          span,
          span,
          1,
          {
            z: overlayBaseZ,
            additive: true,
            instanceIntensity:
              presentation.neighborSurfaceOpacity * field.attenuation,
          },
        );
      }
      if (presentation.neighborRimOpacity > 0) {
        this.#drawEffectTexture(
          `marked-neighbor-rim-${field.sourceSpecial}-${directionKey}`,
          this.#markedNeighborFieldTexture(
            field.sourceSpecial,
            field.directionX,
            field.directionY,
            "rim",
          ),
          x,
          y,
          span,
          span,
          1,
          {
            z: overlayBaseZ + 0.04,
            additive: true,
            instanceIntensity: presentation.neighborRimOpacity * field.attenuation,
          },
        );
      }
    }
  }

  #drawMarkedSource(
    cell: RenderCellModel,
    viewport: BoardViewport,
    movementEffect?: PresentationEffect,
  ): void {
    const presentation = this.#markedPresentation(cell);
    if (cell.special === undefined || presentation === null) return;
    if (!this.#cellIsVisible(cell)) return;
    const { x, y } = this.#cellVisualPoint(cell, viewport, movementEffect);
    const overlayBaseZ = viewport.cellSize * 0.15 + 0.85;
    const span = viewport.cellSize * (cell.role === "ghost" ? 0.72 : 0.91);
    if (presentation.sourceFaceOpacity > 0) {
      this.#drawEffectTexture(
        `marked-source-face-${cell.role}-${cell.special}`,
        this.#markedSourceFaceTexture(cell.special),
        x,
        y,
        span,
        span,
        1,
        {
          z: overlayBaseZ + 0.08,
          additive: true,
          instanceIntensity: presentation.sourceFaceOpacity,
        },
      );
    }
    if (presentation.sourceRimOpacity > 0) {
      this.#drawEffectTexture(
        `marked-source-rim-${cell.role}-${cell.special}`,
        this.#markedSourceRimTexture(cell.special),
        x,
        y,
        span,
        span,
        1,
        {
          z: overlayBaseZ + 0.12,
          additive: true,
          instanceIntensity: presentation.sourceRimOpacity,
        },
      );
    }
    this.#drawEffectTexture(
      `marked-source-glyph-${cell.role}-${cell.special}`,
      this.#markedSourceGlyphTexture(cell.special),
      x,
      y,
      viewport.cellSize,
      viewport.cellSize,
      presentation.glyphOpacity,
      { z: overlayBaseZ + 0.16 },
    );
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
    this.#defaultEffectZ = viewport.cellSize * 0.17 + 1.3;
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
    } else if (effect.kind === "barrier-hit" && effect.flash) {
      const fade = 1 - effect.stageProgress;
      const edgeThickness = viewport.cellSize * (
        visualEffect.visualStyle === "fade"
          ? 0.08
          : 0.08 + effect.stageProgress * 0.1
      );
      const opacity = visualEffect.visualStyle === "fade" ? 0.72 : fade * 0.96;
      for (const [x, y, width, height] of [
        [centerX, bottomY + edgeThickness / 2, viewport.boardWidth, edgeThickness],
        [
          centerX,
          bottomY + viewport.boardHeight - edgeThickness / 2,
          viewport.boardWidth,
          edgeThickness,
        ],
        [
          viewport.boardX + edgeThickness / 2,
          centerY,
          edgeThickness,
          viewport.boardHeight,
        ],
        [
          viewport.boardX + viewport.boardWidth - edgeThickness / 2,
          centerY,
          edgeThickness,
          viewport.boardHeight,
        ],
      ] as const) {
        this.#drawEffectRect(
          "barrier-hit",
          SPECIAL_ACCENT_HEX.barrier,
          x,
          y,
          width,
          height,
          opacity,
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
    } else if (effect.kind === "special-chain") {
      for (const special of effect.resolvedSpecials ?? []) {
        const point = this.#cellPoint(viewport, special.column, special.row);
        const color = SPECIAL_ACCENT_HEX[special.special];
        const dynamicSurge = visualEffect.visualStyle === "motion" && effect.flash;
        const surge = dynamicSurge ? Math.sin(effect.stageProgress * Math.PI) : 0;
        const clipMask = markedCellClipMask(special);
        const activationZ = viewport.cellSize * 0.18 + 1.6;
        this.#drawEffectTexture(
          `special-activation-halo-${special.special}-${clipMask}`,
          this.#specialHaloTexture(
            special.special,
            clipMask,
            MARKED_ACTIVATION_HALO_SPAN,
          ),
          point.x,
          point.y,
          viewport.cellSize * MARKED_ACTIVATION_HALO_SPAN,
          viewport.cellSize * MARKED_ACTIVATION_HALO_SPAN,
          1,
          {
            z: activationZ,
            additive: true,
            instanceIntensity: 0.24 + surge * 0.34,
          },
        );
        this.#drawEffectTexture(
          `special-activation-core-${special.special}`,
          this.#specialCoreTexture(special.special),
          point.x,
          point.y,
          viewport.cellSize * (0.8 + surge * 0.08),
          viewport.cellSize * (0.8 + surge * 0.08),
          1,
          {
            z: activationZ + 0.04,
            additive: true,
            instanceIntensity: 0.4 + surge * 0.34,
          },
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
    this.#position.set(x, y, options.z ?? this.#defaultEffectZ);
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
    this.#position.set(x, y, options.z ?? this.#defaultEffectZ);
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
    mesh.renderOrder = effectRenderOrderFor(key);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.#scene.add(mesh);
    const created = { mesh, material };
    this.#effectPools.set(poolKey, created);
    return created;
  }

  #cellGeometryFor(
    kind: RenderCellKind,
    role: RenderCellRole,
  ): BufferGeometry {
    const quality = role === "ghost"
      ? "reduced"
      : this.#quality.profile.effects;
    if (kind === "acid") return this.#acidGeometry;
    if (kind === "monomino") {
      return quality === "full"
        ? this.#monominoGeometry
        : quality === "limited"
          ? this.#limitedMonominoGeometry
          : this.#reducedMonominoGeometry;
    }
    if (kind === "garbage") {
      return quality === "full" ? this.#garbageGeometry : this.#reducedGarbageGeometry;
    }
    return quality === "full"
      ? this.#cellGeometry
      : quality === "limited"
        ? this.#limitedCellGeometry
        : this.#reducedCellGeometry;
  }

  #refreshCellPoolMaterial(pool: CellPool): void {
    const quality = this.#quality.profile.effects;
    const reduced = quality === "reduced";
    const limited = quality === "limited";
    const ghost = pool.role === "ghost";
    const baseColor = this.#cellBaseColor(pool.kind, pool.special);
    const material = pool.material;

    material.color.copy(baseColor);
    material.map = ghost ? null : this.#patternTexture(pool.kind);
    material.transparent = ghost;
    material.opacity = ghost ? reduced ? 0.27 : 0.22 : 1;
    material.depthWrite = !ghost;
    material.wireframe = ghost;

    if (pool.kind === "garbage") {
      material.metalness = reduced ? 0.08 : limited ? 0.24 : 0.38;
      material.roughness = reduced ? 0.8 : limited ? 0.7 : 0.64;
    } else if (pool.kind === "monomino") {
      material.metalness = reduced ? 0.02 : limited ? 0.08 : 0.12;
      material.roughness = reduced ? 0.55 : limited ? 0.34 : 0.24;
    } else if (pool.kind === "acid") {
      material.metalness = reduced ? 0 : limited ? 0.04 : 0.08;
      material.roughness = reduced ? 0.62 : limited ? 0.4 : 0.28;
    } else {
      material.metalness = reduced ? 0.02 : limited ? 0.08 : 0.12;
      material.roughness = reduced ? 0.62 : limited ? 0.46 : 0.36;
    }

    if (pool.role === "active" && pool.special === undefined) {
      material.emissive.copy(baseColor);
      material.emissiveIntensity = reduced ? 0.006 : limited ? 0.012 : 0.018;
    } else {
      material.emissive.setHex(0x000000);
      material.emissiveIntensity = 0;
    }
    material.needsUpdate = true;
  }

  #poolFor(cell: RenderCellModel): CellPool {
    const key = `${cell.kind}:${cell.role}:${cell.special ?? "ordinary"}`;
    const existing = this.#pools.get(key);
    if (existing !== undefined) return existing;

    const material = new MeshStandardMaterial();
    const mesh = new InstancedMesh(
      this.#cellGeometryFor(cell.kind, cell.role),
      material,
      MAX_INSTANCES_PER_POOL,
    );
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.#scene.add(mesh);
    const created: CellPool = {
      mesh,
      material,
      kind: cell.kind,
      role: cell.role,
      special: cell.special,
    };
    this.#refreshCellPoolMaterial(created);
    this.#pools.set(key, created);
    return created;
  }

  #colors(): Readonly<Record<PieceVisualKind, string>> {
    return this.#palette === "colorblind"
      ? COLORBLIND_PIECE_COLORS
      : STANDARD_PIECE_COLORS;
  }

  #cellBaseColor(kind: RenderCellKind, special?: SpecialKind): Color {
    const color = new Color(this.#colors()[kind]);
    if (special !== undefined) {
      // P4 treats the marked cell as the power's light source. Keep a trace of
      // the piece hue, while letting the power accent lead at the dim phase so
      // complementary piece colors cannot mix into a pale or muddy source.
      color.lerp(new Color(SPECIAL_ACCENT_HEX[special]), 0.96);
    }
    return color;
  }

  #markedCellQuality(): EffectQuality {
    return this.#quality.profile.effects;
  }

  #patternTexture(kind: RenderCellKind): Texture | null {
    const textureKey = `cell-surface:${this.#palette}:${kind}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = PIECE_CELL_ART.textureSize;
    canvas.height = PIECE_CELL_ART.textureSize;
    const context = canvas.getContext("2d");
    if (context === null) return null;

    const size = PIECE_CELL_ART.textureSize;
    const surface = kind === "monomino"
      ? context.createRadialGradient(47, 35, 0, 64, 64, 92)
      : kind === "acid"
        ? context.createRadialGradient(45, 34, 0, 64, 64, 102)
        : context.createLinearGradient(8, 4, 120, 126);
    if (kind === "monomino") {
      surface.addColorStop(0, "#ffffff");
      surface.addColorStop(0.28, "#f8fbff");
      surface.addColorStop(0.7, "#e3eaf2");
      surface.addColorStop(1, "#c7d1dd");
    } else if (kind === "acid") {
      surface.addColorStop(0, "#ffffff");
      surface.addColorStop(0.24, "#f6fff0");
      surface.addColorStop(0.68, "#dfecd8");
      surface.addColorStop(1, "#bbcbb4");
    } else {
      surface.addColorStop(0, "#ffffff");
      surface.addColorStop(0.32, "#f8faff");
      surface.addColorStop(0.72, "#e5eaf2");
      surface.addColorStop(1, kind === "garbage" ? "#c3cad4" : "#ced7e4");
    }
    context.fillStyle = surface;
    context.fillRect(0, 0, size, size);

    const patternAlpha = PIECE_CELL_ART.patternAlpha[this.#palette];
    const patternColor = `rgba(6, 14, 27, ${patternAlpha})`;
    context.strokeStyle = patternColor;
    context.fillStyle = patternColor;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 9;

    const drawChevron = (mirrored: boolean): void => {
      context.save();
      if (mirrored) {
        context.translate(size, 0);
        context.scale(-1, 1);
      }
      for (const x of [-20, 42, 104]) {
        context.beginPath();
        context.moveTo(x, 22);
        context.lineTo(x + 30, 64);
        context.lineTo(x, 106);
        context.stroke();
      }
      context.restore();
    };

    switch (PIECE_PATTERNS[kind]) {
      case "diagonal":
        context.lineWidth = 12;
        for (let offset = -96; offset <= 144; offset += 54) {
          context.beginPath();
          context.moveTo(offset, size);
          context.lineTo(offset + size, 0);
          context.stroke();
        }
        break;
      case "vertical":
        for (const x of [24, 64, 104]) context.fillRect(x - 6, 0, 12, size);
        break;
      case "horizontal":
        for (const y of [24, 64, 104]) context.fillRect(0, y - 6, size, 12);
        break;
      case "dots":
        for (const y of [24, 64, 104]) {
          for (const x of [24, 64, 104]) {
            context.beginPath();
            context.arc(x, y, 8, 0, Math.PI * 2);
            context.fill();
          }
        }
        break;
      case "chevron-left":
        drawChevron(false);
        break;
      case "crosses":
        for (const y of [32, 96]) {
          for (const x of [32, 96]) {
            context.fillRect(x - 5, y - 16, 10, 32);
            context.fillRect(x - 16, y - 5, 32, 10);
          }
        }
        break;
      case "chevron-right":
        drawChevron(true);
        break;
      case "grid":
        context.lineWidth = 5;
        for (let index = 0; index <= size; index += 32) {
          context.beginPath();
          context.moveTo(index, 0);
          context.lineTo(index, size);
          context.moveTo(0, index);
          context.lineTo(size, index);
          context.stroke();
        }
        break;
      case "cross":
        context.lineWidth = 13;
        context.beginPath();
        context.moveTo(64, 13);
        context.lineTo(64, 115);
        context.moveTo(13, 64);
        context.lineTo(115, 64);
        context.stroke();
        break;
      case "circle":
        context.lineWidth = 11;
        context.beginPath();
        context.arc(64, 64, 33, 0, Math.PI * 2);
        context.stroke();
        break;
      case "bubbles":
        for (const [x, y, radius] of [
          [32, 36, 12],
          [86, 28, 8],
          [76, 86, 16],
          [26, 96, 6],
        ] as const) {
          context.lineWidth = 7;
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.stroke();
        }
        break;
    }

    const sheen = context.createLinearGradient(10, 4, 94, 94);
    sheen.addColorStop(0, "rgba(255, 255, 255, 0.24)");
    sheen.addColorStop(0.38, "rgba(255, 255, 255, 0.08)");
    sheen.addColorStop(0.68, "rgba(255, 255, 255, 0)");
    context.fillStyle = sheen;
    context.fillRect(0, 0, size, size);

    const edgeRadius = kind === "garbage" ? 14 : 23;
    context.lineWidth = 5;
    context.strokeStyle = "rgba(255, 255, 255, 0.32)";
    context.beginPath();
    context.moveTo(12, 5);
    context.lineTo(size - 18, 5);
    context.moveTo(5, 12);
    context.lineTo(5, size - 18);
    context.stroke();
    context.strokeStyle = kind === "garbage"
      ? "rgba(4, 9, 18, 0.26)"
      : "rgba(4, 9, 18, 0.2)";
    context.beginPath();
    context.roundRect(4.5, 4.5, size - 9, size - 9, edgeRadius);
    context.stroke();
    context.lineWidth = 6;
    context.beginPath();
    context.moveTo(13, size - 5);
    context.lineTo(size - 18, size - 5);
    context.moveTo(size - 5, 13);
    context.lineTo(size - 5, size - 18);
    context.stroke();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #markedSourceGlyphTexture(special: SpecialKind): Texture {
    const textureKey = `marked-source-glyph:${special}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for marked glyph");

    context.lineCap = "round";
    context.lineJoin = "round";
    context.save();
    context.translate(12.8, 12.8);
    context.scale(1.6, 1.6);
    context.strokeStyle = "rgba(4, 8, 14, 0.98)";
    context.lineWidth = 7.8;
    context.stroke(new Path2D(SPECIAL_ICON_PATHS[special]));
    context.strokeStyle = "#fffdf4";
    context.lineWidth = 5;
    context.stroke(new Path2D(SPECIAL_ICON_PATHS[special]));
    context.restore();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #markedSourceFaceTexture(special: SpecialKind): Texture {
    const textureKey = `marked-source-face:${special}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for marked source face");
    const accent = SPECIAL_ACCENT_HEX[special];
    const red = accent >> 16 & 0xff;
    const green = accent >> 8 & 0xff;
    const blue = accent & 0xff;
    const rgba = (alpha: number): string =>
      `rgba(${red}, ${green}, ${blue}, ${alpha})`;

    context.save();
    context.beginPath();
    context.roundRect(7, 7, 114, 114, 25);
    context.clip();
    const wash = context.createLinearGradient(8, 5, 120, 123);
    wash.addColorStop(0, rgba(0.42));
    wash.addColorStop(0.46, rgba(0.86));
    wash.addColorStop(1, rgba(0.48));
    context.fillStyle = wash;
    context.fillRect(0, 0, 128, 128);
    context.restore();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #markedSourceRimTexture(special: SpecialKind): Texture {
    const textureKey = `marked-source-rim:${special}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for marked source rim");
    const accent = SPECIAL_ACCENT_COLORS[special];

    context.strokeStyle = accent;
    context.lineWidth = 7;
    context.shadowColor = accent;
    context.shadowBlur = 11;
    context.beginPath();
    context.roundRect(8.5, 8.5, 111, 111, 24);
    context.stroke();
    context.shadowBlur = 0;
    context.globalAlpha = 0.92;
    context.lineWidth = 2.5;
    context.stroke();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #markedNeighborFieldTexture(
    special: SpecialKind,
    directionX: -1 | 0 | 1,
    directionY: -1 | 0 | 1,
    layer: "surface" | "rim",
  ): Texture {
    const textureKey =
      `marked-neighbor-${layer}:${special}:${directionX}:${directionY}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for marked neighbor field");
    const accent = SPECIAL_ACCENT_HEX[special];
    const red = accent >> 16 & 0xff;
    const green = accent >> 8 & 0xff;
    const blue = accent & 0xff;
    const rgba = (alpha: number): string =>
      `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    const anchorX = directionX < 0 ? -3 : directionX > 0 ? 131 : 64;
    const anchorY = directionY < 0 ? -3 : directionY > 0 ? 131 : 64;

    if (layer === "surface") {
      context.save();
      context.beginPath();
      context.roundRect(7, 7, 114, 114, 25);
      context.clip();
      const radius = directionX !== 0 && directionY !== 0 ? 106 : 92;
      const wash = context.createRadialGradient(
        anchorX,
        anchorY,
        0,
        anchorX,
        anchorY,
        radius,
      );
      wash.addColorStop(0, rgba(0.78));
      wash.addColorStop(0.24, rgba(0.55));
      wash.addColorStop(0.58, rgba(0.18));
      wash.addColorStop(1, rgba(0));
      context.fillStyle = wash;
      context.fillRect(0, 0, 128, 128);
      context.restore();
    } else {
      context.strokeStyle = SPECIAL_ACCENT_COLORS[special];
      context.lineWidth = 7;
      context.shadowColor = SPECIAL_ACCENT_COLORS[special];
      context.shadowBlur = 10;
      context.beginPath();
      context.roundRect(8.5, 8.5, 111, 111, 24);
      context.stroke();
      context.shadowBlur = 0;
      context.globalAlpha = 0.96;
      context.lineWidth = 2.5;
      context.stroke();
      context.globalAlpha = 0.94;
      context.strokeStyle = "#fff8df";
      context.shadowColor = "rgba(255, 248, 223, 0.88)";
      context.shadowBlur = 5;
      context.lineWidth = 1.35;
      context.stroke();
      context.shadowBlur = 0;

      const maskRadius = directionX !== 0 && directionY !== 0 ? 88 : 76;
      const mask = context.createRadialGradient(
        anchorX,
        anchorY,
        0,
        anchorX,
        anchorY,
        maskRadius,
      );
      mask.addColorStop(0, "rgba(255, 255, 255, 1)");
      mask.addColorStop(0.55, "rgba(255, 255, 255, 0.82)");
      mask.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.globalCompositeOperation = "destination-in";
      context.globalAlpha = 1;
      context.fillStyle = mask;
      context.fillRect(0, 0, 128, 128);
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #specialCoreTexture(special: SpecialKind): Texture {
    const textureKey = `special-core:${special}`;
    const existing = this.#textures.get(textureKey);
    if (existing !== undefined) return existing;
    const canvas = this.#canvas.ownerDocument.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable for special core");

    const accent = SPECIAL_ACCENT_HEX[special];
    const red = accent >> 16 & 0xff;
    const green = accent >> 8 & 0xff;
    const blue = accent & 0xff;
    const rgba = (alpha: number): string =>
      `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    const gradient = context.createRadialGradient(64, 58, 0, 64, 64, 62);
    gradient.addColorStop(0, rgba(0.96));
    gradient.addColorStop(0.18, rgba(0.7));
    gradient.addColorStop(0.46, rgba(0.3));
    gradient.addColorStop(0.76, rgba(0.09));
    gradient.addColorStop(1, rgba(0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.#textures.set(textureKey, texture);
    return texture;
  }

  #specialHaloTexture(
    special: SpecialKind,
    clipMask: string,
    clipSpan: number,
  ): Texture {
    const textureKey = `special-halo:${special}:${clipMask}:${clipSpan}`;
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

    context.save();
    context.globalCompositeOperation = "lighter";
    context.fillStyle = rgba(0.055);
    context.shadowColor = rgba(0.2);
    context.shadowBlur = 22;
    context.beginPath();
    context.roundRect(23, 23, 82, 82, 25);
    context.fill();
    context.restore();

    const gradient = context.createRadialGradient(64, 64, 10, 64, 64, 64);
    gradient.addColorStop(0, rgba(0.66));
    gradient.addColorStop(0.22, rgba(0.48));
    gradient.addColorStop(0.48, rgba(0.23));
    gradient.addColorStop(0.72, rgba(0.09));
    gradient.addColorStop(0.9, rgba(0.025));
    gradient.addColorStop(1, rgba(0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    if (clipMask.length > 0) {
      const halfCell = 64 / Math.max(1, clipSpan);
      const left = clipMask.includes("l") ? 64 - halfCell : 0;
      const right = clipMask.includes("r") ? 64 + halfCell : 128;
      const top = clipMask.includes("t") ? 64 - halfCell : 0;
      const bottom = clipMask.includes("b") ? 64 + halfCell : 128;
      context.globalCompositeOperation = "destination-in";
      context.fillStyle = "#fff";
      context.fillRect(left, top, right - left, bottom - top);
    }

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
