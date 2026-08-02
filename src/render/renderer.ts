import {
  ACESFilmicToneMapping,
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
  SRGBColorSpace,
  type Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { RULES } from "../config/rules";
import type { CellKind, PlayerId, SpecialKind } from "../domain/types";
import {
  QualityController,
  type EffectQuality,
  type RenderQualityProfile,
} from "./quality";

export type RenderCellKind = CellKind | "acid";
export type RenderCellRole = "settled" | "active" | "ghost";

export interface RenderCellModel {
  readonly column: number;
  readonly row: number;
  readonly kind: RenderCellKind;
  readonly role: RenderCellRole;
  readonly special?: SpecialKind;
}

export interface BoardRenderModel {
  readonly playerId: PlayerId;
  readonly cells: readonly RenderCellModel[];
  readonly focused: boolean;
  readonly concealed: boolean;
}

export interface GameRenderFrame {
  readonly mode: "versus" | "practice";
  readonly left: BoardRenderModel | null;
  readonly right: BoardRenderModel | null;
}

export interface BoardViewport {
  readonly paneX: number;
  readonly paneWidth: number;
  readonly boardX: number;
  readonly boardY: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly cellSize: number;
}

export interface RendererLayout {
  readonly width: number;
  readonly height: number;
  readonly mode: GameRenderFrame["mode"];
  readonly left: BoardViewport;
  readonly right: BoardViewport | null;
  readonly dividerX: number | null;
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

const BASE_COLORS: Record<RenderCellKind, number> = {
  I: 0x2bd9fe,
  J: 0x3975ff,
  L: 0xff9029,
  O: 0xffd83d,
  S: 0x43dc78,
  T: 0xb65cff,
  Z: 0xff4f62,
  cross: 0xf5ff72,
  monomino: 0xf2f6ff,
  garbage: 0x768094,
  acid: 0x8dff5a,
};

const COLORBLIND_COLORS: Record<RenderCellKind, number> = {
  I: 0x56b4e9,
  J: 0x0072b2,
  L: 0xe69f00,
  O: 0xf0e442,
  S: 0x009e73,
  T: 0xcc79a7,
  Z: 0xd55e00,
  cross: 0xffffff,
  monomino: 0xbde8ff,
  garbage: 0x777777,
  acid: 0x8cff00,
};

const MAX_INSTANCES_PER_POOL = 512;
const BOARD_GUTTER_PX = 12;
const VERTICAL_GUTTER_PX = 16;

interface CellPool {
  readonly mesh: InstancedMesh;
  readonly material: MeshStandardMaterial;
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
): RendererLayout {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const paneWidth = mode === "versus" ? safeWidth / 2 : safeWidth;
  const cellSize = Math.max(
    1,
    Math.min(
      (paneWidth - BOARD_GUTTER_PX * 2) / RULES.board.width,
      (safeHeight - VERTICAL_GUTTER_PX * 2) /
        (RULES.board.height - RULES.board.hiddenRows),
    ),
  );
  const boardWidth = cellSize * RULES.board.width;
  const boardHeight =
    cellSize * (RULES.board.height - RULES.board.hiddenRows);

  const viewportFor = (paneX: number): BoardViewport => ({
    paneX,
    paneWidth,
    boardX: paneX + (paneWidth - boardWidth) / 2,
    boardY: (safeHeight - boardHeight) / 2,
    boardWidth,
    boardHeight,
    cellSize,
  });

  return {
    width: safeWidth,
    height: safeHeight,
    mode,
    left: viewportFor(0),
    right: mode === "versus" ? viewportFor(paneWidth) : null,
    dividerX: mode === "versus" ? paneWidth : null,
  };
}

export class ThreeRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #options: ThreeRendererOptions;
  readonly #scene = new Scene();
  readonly #camera = new OrthographicCamera(0, 1, 1, 0, -100, 100);
  readonly #renderer: WebGLRenderer;
  readonly #cellGeometry = new RoundedBoxGeometry(1, 1, 0.18, 2, 0.06);
  readonly #pools = new Map<string, CellPool>();
  readonly #textures = new Map<string, Texture>();
  readonly #matrix = new Matrix4();
  readonly #position = new Vector3();
  readonly #scale = new Vector3();
  readonly #quality: QualityController;
  readonly #panels: readonly [BoardPanel, BoardPanel];
  #layout: RendererLayout = calculateRendererLayout(1, 1, "versus");
  #lastLayoutKey = "";
  #contextLost = false;
  #disposed = false;
  #pixelRatio = 0;
  #palette: "standard" | "colorblind" = "standard";

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

  setColorPalette(palette: "standard" | "colorblind"): void {
    if (this.#palette === palette) return;
    this.#palette = palette;
    for (const [key, pool] of this.#pools) {
      const [kind, , special] = key.split(":") as [
        RenderCellKind,
        RenderCellRole,
        string,
      ];
      const color = new Color(this.#colors()[kind]);
      if (special !== "ordinary") color.offsetHSL(0, 0.08, 0.18);
      pool.material.color.copy(color);
      pool.material.emissive.setHex(
        special === "ordinary" ? 0x000000 : color.clone().multiplyScalar(0.42).getHex(),
      );
      pool.material.needsUpdate = true;
    }
  }

  render(frame: GameRenderFrame, timestampMs = performance.now()): void {
    if (this.#disposed || this.#contextLost) return;
    const previousQuality = this.#quality.profile.effects;
    this.#quality.observeFrame(timestampMs);
    if (this.#quality.profile.effects !== previousQuality) {
      this.#pixelRatio = 0;
      this.#options.onQualityChanged?.(this.#quality.profile);
    }
    if (!this.#quality.shouldRender(timestampMs)) return;

    this.#resize(frame.mode);
    for (const [key, pool] of this.#pools) {
      pool.mesh.count = 0;
      if (!key.endsWith(":ordinary")) {
        pool.material.emissiveIntensity =
          this.#quality.profile.effects === "reduced"
            ? 0.85
            : 0.85 + Math.sin(timestampMs / 180) * 0.2;
      }
    }
    this.#drawBoard(frame.left, this.#layout.left, this.#panels[0]);
    this.#drawBoard(frame.right, this.#layout.right, this.#panels[1]);
    for (const pool of this.#pools.values()) {
      pool.mesh.instanceMatrix.needsUpdate = true;
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
    for (const texture of this.#textures.values()) texture.dispose();
    this.#textures.clear();
    this.#cellGeometry.dispose();
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
    for (const cell of board.cells) this.#drawCell(cell, viewport);
  }

  #drawCell(cell: RenderCellModel, viewport: BoardViewport): void {
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

    const visibleRow = cell.row - RULES.board.hiddenRows;
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
  }

  #poolFor(cell: RenderCellModel): CellPool {
    const key = `${cell.kind}:${cell.role}:${cell.special ?? "ordinary"}`;
    const existing = this.#pools.get(key);
    if (existing !== undefined) return existing;

    const baseColor = new Color(this.#colors()[cell.kind]);
    const isGhost = cell.role === "ghost";
    const isSpecial = cell.special !== undefined;
    if (isSpecial) baseColor.offsetHSL(0, 0.08, 0.18);
    const material = new MeshStandardMaterial({
      color: baseColor,
      map: isGhost ? null : this.#patternTexture(cell.kind, cell.special),
      emissive: isSpecial ? baseColor.clone().multiplyScalar(0.42) : 0x000000,
      metalness: cell.kind === "garbage" ? 0.58 : 0.22,
      roughness: cell.kind === "garbage" ? 0.78 : 0.42,
      transparent: isGhost,
      opacity: isGhost ? 0.2 : 1,
      depthWrite: !isGhost,
      wireframe: isGhost,
    });
    const mesh = new InstancedMesh(
      this.#cellGeometry,
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

  #colors(): Readonly<Record<RenderCellKind, number>> {
    return this.#palette === "colorblind" ? COLORBLIND_COLORS : BASE_COLORS;
  }

  #patternTexture(
    kind: RenderCellKind,
    special: SpecialKind | undefined,
  ): Texture | null {
    const textureKey = `${kind}:${special ?? "ordinary"}`;
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

    switch (kind) {
      case "I":
        for (let offset = -64; offset <= 64; offset += 16) {
          context.beginPath();
          context.moveTo(offset, 64);
          context.lineTo(offset + 64, 0);
          context.stroke();
        }
        break;
      case "J":
        for (let x = 8; x < 64; x += 16) context.fillRect(x, 0, 5, 64);
        break;
      case "L":
        for (let y = 8; y < 64; y += 16) context.fillRect(0, y, 64, 5);
        break;
      case "O":
        for (let y = 12; y < 64; y += 20) {
          for (let x = 12; x < 64; x += 20) {
            context.beginPath();
            context.arc(x, y, 4, 0, Math.PI * 2);
            context.fill();
          }
        }
        break;
      case "S":
        for (let x = -16; x < 64; x += 24) {
          context.beginPath();
          context.moveTo(x, 16);
          context.lineTo(x + 12, 28);
          context.lineTo(x, 40);
          context.stroke();
        }
        break;
      case "T":
        for (let y = 16; y < 64; y += 32) {
          for (let x = 16; x < 64; x += 32) {
            context.fillRect(x - 3, y - 10, 6, 20);
            context.fillRect(x - 10, y - 3, 20, 6);
          }
        }
        break;
      case "Z":
        for (let offset = -32; offset <= 64; offset += 24) {
          context.beginPath();
          context.moveTo(offset, 0);
          context.lineTo(offset + 28, 28);
          context.lineTo(offset, 56);
          context.stroke();
        }
        break;
      case "garbage":
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
      case "monomino":
        context.lineWidth = 6;
        context.beginPath();
        context.arc(32, 32, 17, 0, Math.PI * 2);
        context.stroke();
        break;
      case "acid":
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

    if (special !== undefined) {
      context.fillStyle = "rgba(255, 255, 255, 0.86)";
      context.strokeStyle = "rgba(9, 12, 22, 0.92)";
      context.lineWidth = 5;
      context.beginPath();
      context.arc(32, 32, 16, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.strokeStyle = "rgba(9, 12, 22, 0.96)";
      context.fillStyle = "rgba(9, 12, 22, 0.96)";
      context.lineWidth = 4;
      if (special === "column-bomb") {
        context.beginPath();
        context.moveTo(32, 20);
        context.lineTo(32, 44);
        context.stroke();
        context.beginPath();
        context.arc(32, 38, 5, 0, Math.PI * 2);
        context.fill();
      } else if (special === "garbage-core") {
        context.strokeRect(23, 23, 18, 18);
        context.beginPath();
        context.moveTo(23, 32);
        context.lineTo(41, 32);
        context.moveTo(32, 23);
        context.lineTo(32, 41);
        context.stroke();
      } else {
        context.beginPath();
        context.moveTo(22, 24);
        context.lineTo(30, 31);
        context.lineTo(24, 40);
        context.moveTo(42, 24);
        context.lineTo(34, 31);
        context.lineTo(40, 40);
        context.stroke();
      }
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(1.25, 1.25);
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
