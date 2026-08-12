import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { RULES_HASH } from "../../src/config/rules-hash";
import { RULES } from "../../src/config/rules";
import { hashCanonicalHex } from "../../src/domain/hashing";
import { NETWORK_DIAGNOSTICS_STORAGE_KEY } from "../../src/network/diagnostics";
import { DEVICE_MATRIX } from "./device-matrix";

const APP_ORIGIN = "http://127.0.0.1:3000";

async function serializeMockWebxdcDurableAppends(
  context: BrowserContext,
): Promise<void> {
  await context.route(`${APP_ORIGIN}/webxdc.js`, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const headers = response.headers();
    delete headers["content-length"];
    await route.fulfill({
      response,
      headers,
      body: `${source}\n;(() => {
        const sendUpdate = window.webxdc.sendUpdate.bind(window.webxdc);
        window.webxdc.sendUpdate = (update, description) =>
          navigator.locks.request("split-stack-test-durable-append", () =>
            sendUpdate(update, description)
          );
      })();`,
    });
  });
}

test.beforeEach(async ({ context }) => {
  // The Vite mock uses a localStorage read/append/write cycle. Web Locks make
  // that cycle atomic across the multiple pages used by competitive tests,
  // matching the real Webxdc host's append-only durable log.
  await serializeMockWebxdcDurableAppends(context);
});

async function openApp(page: Page, identity = "Browser Tester"): Promise<void> {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await page.goto(
    `/#name=${encodeURIComponent(identity)}&addr=${encodeURIComponent(`${slug}@example.test`)}`,
  );
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function openLobby(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Lobby(?: ·|$)/ }).click();
  await expect(page.getByRole("heading", { name: "Lobby", exact: true })).toBeVisible();
}

async function waitForWaitingChallenge(page: Page): Promise<void> {
  const message = page.locator(".home-waiting-message");
  await expect(message).toBeVisible({ timeout: 15_000 });
  await expect(message).toContainText(/waiting for an opponent/i);
}

async function leaveThroughMatchMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Match menu" }).click();
  await page.getByRole("button", { name: "Leave match" }).click();
}

async function waitForEffectiveMatchStarted(
  page: Page,
  expectedSeatAPlayerId: string,
): Promise<string> {
  const effectiveMatchId = () => page.evaluate((seatAPlayerId) => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly href?: unknown;
      readonly info?: unknown;
      readonly payload?: {
        readonly kind?: unknown;
        readonly matchId?: unknown;
        readonly seatAPlayerId?: unknown;
      };
    }>;
    const started = updates.find((update) =>
      update.payload?.kind === "match-started" &&
      update.payload.seatAPlayerId === seatAPlayerId &&
      typeof update.payload.matchId === "string" &&
      typeof update.info === "string" &&
      typeof update.href === "string"
    );
    return typeof started?.payload?.matchId === "string"
      ? started.payload.matchId
      : null;
  }, expectedSeatAPlayerId);

  await expect.poll(effectiveMatchId, {
    message: `expected an effective match start for ${expectedSeatAPlayerId}`,
    timeout: 15_000,
  }).not.toBeNull();
  const matchId = await effectiveMatchId();
  if (matchId === null) {
    throw new Error(`Expected an effective match start for ${expectedSeatAPlayerId}`);
  }
  return matchId;
}

interface MarkedCellRenderMetrics {
  readonly neighborRimTroughLift: readonly number[];
  readonly neighborRimPeakLift: readonly number[];
  readonly neighborSurfaceTroughLift: readonly number[];
  readonly neighborSurfacePeakLift: readonly number[];
  readonly sourceTroughLift: number;
  readonly sourcePeakLift: number;
  readonly markedBaseAccentChromaDistance: number;
  readonly markedBaseOrdinaryChromaDistance: number;
  readonly markedSurfacePatternVariationRatio: number;
  readonly markedSurfaceShadingRange: number;
  readonly markedBevelContrast: number;
  readonly markedCentralDarkCoverageAtTrough: number;
  readonly markedCentralDarkCoverageAtPeak: number;
  readonly glyphIvoryFootprintRatioAtTrough: number;
  readonly glyphIvoryFootprintRatioAtPeak: number;
  readonly glyphIvoryRetentionRatio: number;
  readonly glyphIvoryMinimumColorDistanceAtTrough: number;
  readonly glyphIvoryMinimumColorDistanceAtPeak: number;
  readonly glyphStaticColorDelta: number;
  readonly glyphUnderstrokeCoverageAtTrough: number;
  readonly glyphUnderstrokeCoverageAtPeak: number;
  readonly glyphUnderstrokeFaceDropAtTrough: number;
  readonly glyphUnderstrokeFaceDropAtPeak: number;
  readonly glyphContrastAtTrough: number;
  readonly glyphContrastAtPeak: number;
  readonly sourceFacePeakClippedCoverage: number;
  readonly minimumNeighborPatternContrastRatioAtTrough: number;
  readonly minimumNeighborPatternContrastRatioAtPeak: number;
  readonly minimumLightChannelDelta: number;
  readonly outsideBoardLightDelta: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly overlapTargetRimDelta: number;
  readonly crossDirectionSurfaceLift: number;
  readonly gameplayCueLift: number;
  readonly activationOutsideBoardLightDelta: number;
  readonly activationBoundaryDelta: number;
}

interface DenseCellArtMetrics {
  readonly portrait: boolean;
  readonly cellSize: number;
  readonly cells: readonly {
    readonly kind: string;
    readonly contrast: number;
    readonly color: readonly [number, number, number];
  }[];
  readonly ghost: {
    readonly backgroundLuminance: number;
    readonly centerLuminance: number;
    readonly edgeLuminance: number;
    readonly solidCenterLuminance: number;
  };
  readonly silhouette: {
    readonly ordinaryCornerFillRatio: number;
    readonly monominoCornerFillRatio: number;
  };
}

interface CellPoolUploadMetrics {
  readonly arrayBufferUploads: readonly {
    readonly destinationByteOffset: number;
    readonly sourceByteLength: number;
    readonly sourceElementOffset: number | null;
    readonly sourceElementCount: number | null;
    readonly uploadedByteLength: number;
  }[];
}

async function readCellPoolUploadMetrics(
  page: Page,
): Promise<CellPoolUploadMetrics> {
  return page.evaluate(async () => {
    const rendererUrl = "/src/render/renderer.ts";
    const { ThreeRenderer } = await import(rendererUrl);
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:400px;height:800px";
    document.body.append(canvas);

    const renderer = new ThreeRenderer(canvas, { initialQuality: "full" });
    const frame = (
      cells: readonly {
        readonly column: number;
        readonly row: number;
        readonly kind: "I" | "T";
        readonly role: "active" | "settled";
      }[],
    ) => ({
      mode: "practice" as const,
      left: {
        playerId: "cell-pool-upload-test",
        cells,
        focused: true,
        concealed: false,
      },
      right: null,
    });
    const activeCells = [0, 1, 2, 3].map((column) => ({
      column,
      row: 12,
      kind: "I" as const,
      role: "active" as const,
    }));
    const settledCells = [0, 1, 2, 3].map((column) => ({
      column,
      row: 13,
      kind: "T" as const,
      role: "settled" as const,
    }));

    // Prime two distinct historical pools before observing the next frame.
    renderer.render(frame([...activeCells, ...settledCells]), 100);

    const gl = canvas.getContext("webgl2");
    if (gl === null) throw new Error("WebGL2 unavailable in browser test");
    gl.finish();
    const originalBufferSubData = gl.bufferSubData;
    const calls: {
      destinationByteOffset: number;
      sourceByteLength: number;
      sourceElementOffset: number | null;
      sourceElementCount: number | null;
      uploadedByteLength: number;
      target: number;
    }[] = [];
    const instrumented = function (...args: unknown[]): void {
      const target = args[0] as number;
      const destinationByteOffset = args[1] as number;
      const source = args[2] as ArrayBufferView & { readonly BYTES_PER_ELEMENT?: number };
      const sourceElementOffset = typeof args[3] === "number" ? args[3] : null;
      const sourceElementCount = typeof args[4] === "number" ? args[4] : null;
      const bytesPerElement = source.BYTES_PER_ELEMENT ?? 1;
      calls.push({
        destinationByteOffset,
        sourceByteLength: source.byteLength,
        sourceElementOffset,
        sourceElementCount,
        uploadedByteLength: sourceElementCount === null
          ? source.byteLength
          : sourceElementCount * bytesPerElement,
        target,
      });
      Reflect.apply(originalBufferSubData, gl, args);
    };
    Object.defineProperty(gl, "bufferSubData", {
      configurable: true,
      value: instrumented,
    });

    try {
      renderer.render(frame(activeCells), 200);
      gl.finish();
    } finally {
      Object.defineProperty(gl, "bufferSubData", {
        configurable: true,
        value: originalBufferSubData,
      });
      renderer.dispose();
      canvas.remove();
    }

    return {
      arrayBufferUploads: calls
        .filter((call) => call.target === gl.ARRAY_BUFFER)
        .map(({ target: _target, ...call }) => call),
    };
  });
}

async function readDenseCellArtMetrics(
  page: Page,
  palette: "standard" | "colorblind",
  quality: "full" | "limited" | "reduced",
): Promise<DenseCellArtMetrics> {
  return page.evaluate(async ({ palette, quality }) => {
    const rendererUrl = "/src/render/renderer.ts";
    const { ThreeRenderer } = await import(rendererUrl);
    const portrait = window.innerHeight > window.innerWidth;
    const cssWidth = Math.min(900, Math.max(320, window.innerWidth - 24));
    const cssHeight = Math.min(780, Math.max(520, window.innerHeight - 24));
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      `position:fixed;left:0;top:0;width:${cssWidth}px;height:${cssHeight}px;z-index:9999`;
    document.body.append(canvas);

    const renderer = new ThreeRenderer(canvas, { initialQuality: quality });
    const kinds = [
      "I",
      "J",
      "L",
      "O",
      "S",
      "T",
      "Z",
      "cross",
      "small-cross",
      "monomino",
      "garbage",
      "acid",
    ] as const;
    type CellKind = typeof kinds[number];
    const cells: {
      column: number;
      row: number;
      kind: CellKind;
      role: "settled" | "ghost";
    }[] = kinds.flatMap((kind, rowIndex) =>
      Array.from({ length: 10 }, (_, column) => ({
        column,
        row: 2 + rowIndex,
        kind,
        role: "settled" as const,
      }))
    );
    cells.push(
      { column: 2, row: 15, kind: "T", role: "ghost" },
      { column: 7, row: 15, kind: "T", role: "settled" },
    );
    const frame = {
      mode: "practice" as const,
      left: {
        playerId: `dense-cell-art-${palette}-${quality}`,
        cells,
        focused: true,
        concealed: false,
      },
      right: null,
    };

    // Prime the standard materials so the colorblind read proves that a live
    // palette switch updates every existing pool, including ghost and garbage.
    if (palette === "colorblind") {
      renderer.render(frame, 100);
      renderer.setColorPalette("colorblind");
    }
    renderer.render(frame, 200);

    const gl = canvas.getContext("webgl2");
    if (gl === null) throw new Error("WebGL2 unavailable in browser test");
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const capture = (): Uint8Array => {
      gl.finish();
      const captured = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, captured);
      return captured;
    };
    const pixels = capture();
    renderer.render({
      ...frame,
      left: {
        ...frame.left,
        cells: [
          { column: 3, row: 10, kind: "J" as const, role: "settled" as const },
          {
            column: 6,
            row: 10,
            kind: "monomino" as const,
            role: "settled" as const,
          },
        ],
      },
    }, 400);
    const silhouettePixels = capture();
    renderer.render({
      ...frame,
      left: { ...frame.left, cells: [] },
    }, 600);
    const emptyPixels = capture();
    const viewport = renderer.layout.left;
    const scaleX = width / canvas.clientWidth;
    const scaleY = height / canvas.clientHeight;
    const pixelColor = (
      sourcePixels: Uint8Array,
      x: number,
      y: number,
    ): readonly [number, number, number] => {
      const offset = (y * width + x) * 4;
      return [
        sourcePixels[offset]!,
        sourcePixels[offset + 1]!,
        sourcePixels[offset + 2]!,
      ];
    };
    const sampleColor = (
      sourcePixels: Uint8Array,
      column: number,
      row: number,
      offsetX = 0,
      offsetY = 0,
    ): readonly [number, number, number] => {
      const cssX = viewport.boardX + (column + 0.5 + offsetX) * viewport.cellSize;
      const cssY = canvas.clientHeight -
        (viewport.boardY + (row - 2 + 0.5 + offsetY) * viewport.cellSize);
      const x = Math.round(cssX * scaleX);
      const y = Math.round(cssY * scaleY);
      const radius = Math.max(1, Math.round(Math.min(scaleX, scaleY)));
      const total: [number, number, number] = [0, 0, 0];
      let count = 0;
      for (let sampleY = y - radius; sampleY <= y + radius; sampleY += 1) {
        for (let sampleX = x - radius; sampleX <= x + radius; sampleX += 1) {
          const color = pixelColor(sourcePixels, sampleX, sampleY);
          total[0] += color[0];
          total[1] += color[1];
          total[2] += color[2];
          count += 1;
        }
      }
      return [total[0] / count, total[1] / count, total[2] / count];
    };
    const luminance = (color: readonly [number, number, number]): number =>
      color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    const offsets = [-0.3, -0.15, 0, 0.15, 0.3];
    const metrics = kinds.map((kind, rowIndex) => {
      const colors = offsets.flatMap((offsetY) =>
        offsets.map((offsetX) =>
          sampleColor(pixels, 4, 2 + rowIndex, offsetX, offsetY)
        )
      );
      const luminances = colors.map(luminance);
      const meanLuminance = luminances.reduce((total, value) => total + value, 0) /
        luminances.length;
      const color = colors.reduce<[number, number, number]>(
        (total, value) => [
          total[0] + value[0],
          total[1] + value[1],
          total[2] + value[2],
        ],
        [0, 0, 0],
      ).map((channel) => channel / colors.length) as [number, number, number];
      const contrast = Math.sqrt(
        luminances.reduce(
          (total, value) => total + (value - meanLuminance) ** 2,
          0,
        ) / luminances.length,
      );
      return { kind, contrast, color };
    });
    const backgroundLuminance = luminance(sampleColor(pixels, 4, 15));
    const centerLuminance = luminance(sampleColor(pixels, 2, 15));
    const edgeLuminance = luminance(sampleColor(pixels, 2, 15, 0.35));
    const solidCenterLuminance = luminance(sampleColor(pixels, 7, 15));
    const colorDistance = (
      left: readonly [number, number, number],
      right: readonly [number, number, number],
    ): number => Math.hypot(
      left[0] - right[0],
      left[1] - right[1],
      left[2] - right[2],
    );
    const cornerFillRatio = (column: number): number => {
      const centerFill = colorDistance(
        sampleColor(silhouettePixels, column, 10),
        sampleColor(emptyPixels, column, 10),
      );
      const cornerFill = [
        [-0.38, -0.38], [0.38, -0.38],
        [-0.38, 0.38], [0.38, 0.38],
      ].reduce((total, [offsetX, offsetY]) =>
        total + colorDistance(
          sampleColor(silhouettePixels, column, 10, offsetX, offsetY),
          sampleColor(emptyPixels, column, 10, offsetX, offsetY),
        ), 0) / 4;
      return cornerFill / Math.max(1, centerFill);
    };

    const result = {
      portrait,
      cellSize: viewport.cellSize,
      cells: metrics,
      ghost: {
        backgroundLuminance,
        centerLuminance,
        edgeLuminance,
        solidCenterLuminance,
      },
      silhouette: {
        ordinaryCornerFillRatio: cornerFillRatio(3),
        monominoCornerFillRatio: cornerFillRatio(6),
      },
    };
    renderer.dispose();
    canvas.remove();
    return result;
  }, { palette, quality });
}

async function readMarkedCellRenderMetrics(
  page: Page,
): Promise<MarkedCellRenderMetrics> {
  return page.evaluate(async () => {
    const rendererUrl = "/src/render/renderer.ts";
    const { ThreeRenderer } = await import(rendererUrl);
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;inset:0;width:400px;height:800px;z-index:9999";
    document.body.append(canvas);

    const renderer = new ThreeRenderer(canvas, { initialQuality: "full" });
    const source = {
      column: 4,
      row: 12,
      kind: "J" as const,
      role: "settled" as const,
    };
    const markedSource = { ...source, special: "blackout" as const };
    const neighbors = [
      { column: 3, row: 11, kind: "Z" as const, role: "settled" as const },
      { column: 4, row: 11, kind: "S" as const, role: "settled" as const },
      { column: 5, row: 11, kind: "O" as const, role: "settled" as const },
      { column: 3, row: 12, kind: "T" as const, role: "settled" as const },
      { column: 5, row: 12, kind: "L" as const, role: "settled" as const },
      { column: 3, row: 13, kind: "I" as const, role: "settled" as const },
      { column: 4, row: 13, kind: "J" as const, role: "settled" as const },
      { column: 5, row: 13, kind: "S" as const, role: "settled" as const },
    ];
    const frame = (
      cells: readonly Record<string, unknown>[],
      presentation?: Record<string, unknown>,
    ) => ({
      mode: "practice" as const,
      left: {
        playerId: "visual-test",
        cells,
        focused: true,
        concealed: false,
      },
      right: null,
      ...(presentation === undefined ? {} : { presentation }),
    });

    const gl = canvas.getContext("webgl2");
    if (gl === null) throw new Error("WebGL2 unavailable in browser test");
    const capture = (): Uint8Array => {
      gl.finish();
      const captured = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        captured,
      );
      return captured;
    };

    // The settled source does not receive transient spawn emphasis. P4 is at
    // its trough on 2.8 s multiples and at its peak 1.4 s later.
    renderer.render(frame([source, ...neighbors]), 4_200);
    const baselinePixels = capture();
    renderer.render(frame([markedSource, ...neighbors]), 5_600);
    const troughPixels = capture();
    renderer.render(frame([markedSource, ...neighbors]), 7_000);
    const peakPixels = capture();
    renderer.render(frame([markedSource]), 9_800);
    const isolatedPeakPixels = capture();
    renderer.render(
      frame([
        { ...source, column: 0, special: "blackout" as const },
        { ...source, column: 9, special: "barrier" as const },
        { ...source, column: 4, row: 2, special: "glitch-core" as const },
        { ...source, column: 4, row: 21, special: "column-bomb" as const },
      ]),
      11_200,
    );
    const edgePixels = capture();
    renderer.render(frame([]), 14_000);
    const emptyPixels = capture();
    renderer.render(
      frame([
        { ...source, row: 11, special: "blackout" as const },
        source,
      ]),
      15_400,
    );
    const singleFieldPixels = capture();
    renderer.render(
      frame([
        { ...source, row: 11, special: "blackout" as const },
        { ...source, column: 3, special: "barrier" as const },
        source,
      ]),
      18_200,
    );
    const overlapPixels = capture();
    renderer.render(
      frame(
        [markedSource],
        {
          atMs: 21_000,
          blocking: true,
          shake: null,
          effects: [{
            id: "marked-line-clear",
            kind: "line-clear",
            board: "left",
            stage: "action",
            moment: "impact",
            progress: 0.5,
            stageProgress: 0.5,
            rows: [12],
            visualStyle: "motion",
            particleCount: 0,
            flash: true,
          }],
        },
      ),
      21_000,
    );
    const gameplayCuePixels = capture();
    const activationPresentation = (
      stage: "action" | "follow-through",
      stageProgress: number,
      flash: boolean,
    ) => ({
      atMs: 0,
      blocking: stage === "action",
      shake: null,
      effects: [{
        id: "edge-special-chain",
        kind: "special-chain",
        board: "left",
        stage,
        moment: "special-burst",
        progress: stage === "action" ? 0.5 : 0.8,
        stageProgress,
        visualStyle: "motion",
        particleCount: 0,
        flash,
        resolvedSpecials: [{ special: "barrier", column: 0, row: 12 }],
      }],
    });
    renderer.render(frame([], activationPresentation("action", 1, true)), 23_800);
    const activationActionEndPixels = capture();
    renderer.render(
      frame([], activationPresentation("follow-through", 0, false)),
      26_600,
    );
    const activationFollowPixels = capture();

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    const viewport = renderer.layout.left;
    const centerCssX = viewport.boardX + (4 + 0.5) * viewport.cellSize;
    const centerCssY = viewport.boardY + (12 - 2 + 0.5) * viewport.cellSize;
    const scaleX = width / canvas.clientWidth;
    const scaleY = height / canvas.clientHeight;
    const centerX = centerCssX * scaleX;
    const centerY = height - centerCssY * scaleY;
    const pixelColor = (
      pixels: Uint8Array,
      x: number,
      y: number,
    ): readonly [number, number, number] => {
      const offset = (y * width + x) * 4;
      return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    };
    const luminance = (color: readonly [number, number, number]): number =>
      color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    const sampleColor = (
      pixels: Uint8Array,
      cellOffsetX: number,
      cellOffsetY = 0,
    ): readonly [number, number, number] => {
      const sampleX = Math.round(centerX + viewport.cellSize * cellOffsetX * scaleX);
      const sampleY = Math.round(centerY - viewport.cellSize * cellOffsetY * scaleY);
      const radius = Math.max(1, Math.round(Math.min(scaleX, scaleY)));
      const total: [number, number, number] = [0, 0, 0];
      let count = 0;
      for (let y = sampleY - radius; y <= sampleY + radius; y += 1) {
        for (let x = sampleX - radius; x <= sampleX + radius; x += 1) {
          const color = pixelColor(pixels, x, y);
          total[0] += color[0];
          total[1] += color[1];
          total[2] += color[2];
          count += 1;
        }
      }
      return [total[0]! / count, total[1]! / count, total[2]! / count];
    };
    const sampleLuminance = (
      pixels: Uint8Array,
      cellOffsetX: number,
      cellOffsetY = 0,
    ): number => luminance(sampleColor(pixels, cellOffsetX, cellOffsetY));
    const luminanceLift = (
      pixels: Uint8Array,
      baseline: Uint8Array,
      cellOffsetX: number,
      cellOffsetY: number,
    ): number =>
      sampleLuminance(pixels, cellOffsetX, cellOffsetY) -
      sampleLuminance(baseline, cellOffsetX, cellOffsetY);

    const targetDirections = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ] as const;
    const samplePoints = targetDirections.map(([targetX, targetY]) => {
      const diagonal = targetX !== 0 && targetY !== 0;
      const rimInset = diagonal ? 0.36 : 0.42;
      const surfaceInset = diagonal ? 0.22 : 0.25;
      return {
        rim: [targetX * (1 - rimInset), targetY * (1 - rimInset)] as const,
        surface: [
          targetX * (1 - surfaceInset),
          targetY * (1 - surfaceInset),
        ] as const,
      };
    });
    const neighborRimTroughLift = samplePoints.map(({ rim }) =>
      luminanceLift(troughPixels, baselinePixels, rim[0], rim[1])
    );
    const neighborRimPeakLift = samplePoints.map(({ rim }) =>
      luminanceLift(peakPixels, baselinePixels, rim[0], rim[1])
    );
    const neighborSurfaceTroughLift = samplePoints.map(({ surface }) =>
      luminanceLift(troughPixels, baselinePixels, surface[0], surface[1])
    );
    const neighborSurfacePeakLift = samplePoints.map(({ surface }) =>
      luminanceLift(peakPixels, baselinePixels, surface[0], surface[1])
    );

    const sourceFacePoints = [
      [-0.27, -0.27], [0.27, -0.27],
      [-0.27, 0.27], [0.27, 0.27],
    ] as const;
    const averageSourceLuminance = (pixels: Uint8Array): number =>
      sourceFacePoints.reduce(
        (total, [offsetX, offsetY]) =>
          total + sampleLuminance(pixels, offsetX, offsetY),
        0,
      ) / sourceFacePoints.length;
    const sourceBaseline = averageSourceLuminance(baselinePixels);
    const sourceTroughLift = averageSourceLuminance(troughPixels) - sourceBaseline;
    const sourcePeakLift = averageSourceLuminance(peakPixels) - sourceBaseline;

    const colorDistance = (
      left: readonly [number, number, number],
      right: readonly [number, number, number],
    ): number => Math.hypot(
      left[0] - right[0],
      left[1] - right[1],
      left[2] - right[2],
    );
    const accentColor = [0x9b, 0x7b, 0xff] as const;
    const ordinaryColor = [0x48, 0x68, 0xe8] as const;
    const ivoryColor = [0xff, 0xf8, 0xdf] as const;
    const understrokeColor = [0x03, 0x07, 0x11] as const;
    const chromaDistance = (
      left: readonly [number, number, number],
      right: readonly [number, number, number],
    ): number => {
      const leftTotal = Math.max(1, left[0] + left[1] + left[2]);
      const rightTotal = Math.max(1, right[0] + right[1] + right[2]);
      return Math.hypot(
        left[0] / leftTotal - right[0] / rightTotal,
        left[1] / leftTotal - right[1] / rightTotal,
        left[2] / leftTotal - right[2] / rightTotal,
      );
    };
    const averageSourceColor = (
      pixels: Uint8Array,
    ): readonly [number, number, number] => {
      const total = sourceFacePoints.reduce<[number, number, number]>(
        (sum, [offsetX, offsetY]) => {
          const color = sampleColor(pixels, offsetX, offsetY);
          sum[0] += color[0];
          sum[1] += color[1];
          sum[2] += color[2];
          return sum;
        },
        [0, 0, 0],
      );
      return [
        total[0] / sourceFacePoints.length,
        total[1] / sourceFacePoints.length,
        total[2] / sourceFacePoints.length,
      ];
    };
    const markedBaseColor = averageSourceColor(troughPixels);
    const glyphStats = (pixels: Uint8Array) => {
      const cellSpanX = viewport.cellSize * scaleX;
      const cellSpanY = viewport.cellSize * scaleY;
      // Cover the full 56% glyph carrier. The ivory classifier stays distinct
      // from the power-colored face at both ends of the P4 pulse.
      const minimumX = Math.floor(centerX - cellSpanX * 0.28);
      const maximumX = Math.ceil(centerX + cellSpanX * 0.28);
      const minimumY = Math.floor(centerY - cellSpanY * 0.28);
      const maximumY = Math.ceil(centerY + cellSpanY * 0.28);
      const ivory = new Set<number>();
      const sampled = new Map<number, {
        readonly x: number;
        readonly y: number;
        readonly color: readonly [number, number, number];
        readonly luminance: number;
      }>();
      let ivoryLuminance = 0;
      let ivoryMinimumX = Number.POSITIVE_INFINITY;
      let ivoryMaximumX = Number.NEGATIVE_INFINITY;
      let ivoryMinimumY = Number.POSITIVE_INFINITY;
      let ivoryMaximumY = Number.NEGATIVE_INFINITY;
      let minimumIvoryColorDistance = Number.POSITIVE_INFINITY;
      const keyFor = (x: number, y: number): number => y * width + x;

      for (let y = minimumY; y <= maximumY; y += 1) {
        for (let x = minimumX; x <= maximumX; x += 1) {
          const color = pixelColor(pixels, x, y);
          const ivoryDistance = colorDistance(color, ivoryColor);
          const isIvory = ivoryDistance <= 48;
          const key = keyFor(x, y);
          const sampleLuminance = luminance(color);
          sampled.set(key, {
            x,
            y,
            color,
            luminance: sampleLuminance,
          });
          minimumIvoryColorDistance = Math.min(
            minimumIvoryColorDistance,
            ivoryDistance,
          );
          if (isIvory) {
            ivory.add(key);
            ivoryLuminance += sampleLuminance;
            ivoryMinimumX = Math.min(ivoryMinimumX, x);
            ivoryMaximumX = Math.max(ivoryMaximumX, x);
            ivoryMinimumY = Math.min(ivoryMinimumY, y);
            ivoryMaximumY = Math.max(ivoryMaximumY, y);
          }
        }
      }

      const meanIvoryLuminance = ivoryLuminance / Math.max(1, ivory.size);
      const voidDark = new Set<number>();
      const understrokeCandidates = new Set<number>();
      for (const [key, sample] of sampled) {
        if (colorDistance(sample.color, understrokeColor) <= 70) {
          voidDark.add(key);
        }
        if (sample.luminance <= meanIvoryLuminance - 45) {
          understrokeCandidates.add(key);
        }
      }
      const adjacencyRadius = Math.max(
        1,
        Math.round(Math.min(cellSpanX, cellSpanY) * 0.04),
      );
      let adjacentDarkPixels = 0;
      let adjacentDarkLuminance = 0;
      for (const key of understrokeCandidates) {
        const sample = sampled.get(key)!;
        const { x, y } = sample;
        let touchesAccent = false;
        for (let offsetY = -adjacencyRadius; offsetY <= adjacencyRadius; offsetY += 1) {
          for (let offsetX = -adjacencyRadius; offsetX <= adjacencyRadius; offsetX += 1) {
            if (ivory.has(keyFor(x + offsetX, y + offsetY))) {
              touchesAccent = true;
              break;
            }
          }
          if (touchesAccent) break;
        }
        if (!touchesAccent) continue;
        adjacentDarkPixels += 1;
        adjacentDarkLuminance += sample.luminance;
      }

      const footprintRatio = ivory.size === 0
        ? 0
        : Math.max(
          (ivoryMaximumX - ivoryMinimumX + 1) / cellSpanX,
          (ivoryMaximumY - ivoryMinimumY + 1) / cellSpanY,
        );
      const meanUnderstrokeLuminance = adjacentDarkLuminance /
        Math.max(1, adjacentDarkPixels);
      return {
        ivory,
        sampled,
        ivoryPixels: ivory.size,
        footprintRatio,
        minimumIvoryColorDistance,
        understrokeCoverage: adjacentDarkPixels / Math.max(1, ivory.size),
        understrokeFaceDrop: averageSourceLuminance(pixels) -
          meanUnderstrokeLuminance,
        centralDarkCoverage: voidDark.size / Math.max(1, sampled.size),
        contrast: adjacentDarkPixels === 0
          ? 0
          : meanIvoryLuminance - meanUnderstrokeLuminance,
      };
    };
    const troughGlyph = glyphStats(troughPixels);
    const peakGlyph = glyphStats(peakPixels);
    let retainedIvoryPixels = 0;
    let glyphStaticColorDeltaTotal = 0;
    for (const key of troughGlyph.ivory) {
      if (!peakGlyph.ivory.has(key)) continue;
      retainedIvoryPixels += 1;
      glyphStaticColorDeltaTotal += colorDistance(
        troughGlyph.sampled.get(key)!.color,
        peakGlyph.sampled.get(key)!.color,
      );
    }

    const standardDeviation = (values: readonly number[]): number => {
      const mean = values.reduce((total, value) => total + value, 0) / values.length;
      return Math.sqrt(
        values.reduce((total, value) => total + (value - mean) ** 2, 0) /
          values.length,
      );
    };
    const surfacePatternOffsets = [-0.28, -0.14, 0, 0.14, 0.28];
    const baselinePatternSurface = surfacePatternOffsets.map((offsetX) =>
      sampleLuminance(baselinePixels, offsetX, -0.3)
    );
    const markedPatternSurface = surfacePatternOffsets.map((offsetX) =>
      sampleLuminance(troughPixels, offsetX, -0.3)
    );
    const markedSurfaceSamples = ([
      [-0.27, -0.27], [0.27, -0.27],
      [-0.27, 0.27], [0.27, 0.27],
    ] as const).map(([offsetX, offsetY]) =>
      sampleLuminance(troughPixels, offsetX, offsetY)
    );
    const bevelDirections = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
    ] as const;
    const markedBevelContrast = bevelDirections.reduce(
      (total, [directionX, directionY]) =>
        total + Math.abs(
          sampleLuminance(
            troughPixels,
            directionX * 0.4,
            directionY * 0.4,
          ) - sampleLuminance(
            troughPixels,
            directionX * 0.31,
            directionY * 0.31,
          ),
        ),
      0,
    ) / bevelDirections.length;
    let clippedSourcePixels = 0;
    let sampledSourcePixels = 0;
    for (
      let y = Math.floor(centerY - viewport.cellSize * scaleY * 0.4);
      y <= Math.ceil(centerY + viewport.cellSize * scaleY * 0.4);
      y += 1
    ) {
      for (
        let x = Math.floor(centerX - viewport.cellSize * scaleX * 0.4);
        x <= Math.ceil(centerX + viewport.cellSize * scaleX * 0.4);
        x += 1
      ) {
        const offsetX = Math.abs((x - centerX) / (viewport.cellSize * scaleX));
        const offsetY = Math.abs((y - centerY) / (viewport.cellSize * scaleY));
        if (offsetX <= 0.25 && offsetY <= 0.25) continue;
        const [red, green, blue] = pixelColor(peakPixels, x, y);
        sampledSourcePixels += 1;
        if (red >= 249 && green >= 249 && blue >= 249) clippedSourcePixels += 1;
      }
    }

    const patternOffsets = [-0.28, -0.14, 0, 0.14, 0.28];
    const patternContrast = (
      pixels: Uint8Array,
      targetX: number,
      targetY: number,
    ): number => {
      const values = patternOffsets.flatMap((offsetY) =>
        patternOffsets.map((offsetX) =>
          sampleLuminance(pixels, targetX + offsetX, targetY + offsetY)
        )
      );
      const mean = values.reduce((total, value) => total + value, 0) / values.length;
      return Math.sqrt(
        values.reduce((total, value) => total + (value - mean) ** 2, 0) /
          values.length,
      );
    };
    const minimumNeighborPatternContrastRatioAt = (pixels: Uint8Array): number =>
      Math.min(
        ...targetDirections.map(([targetX, targetY]) =>
          patternContrast(pixels, targetX, targetY) /
            Math.max(0.001, patternContrast(baselinePixels, targetX, targetY))
        ),
      );
    const minimumLightChannelDelta = Math.min(
      ...[troughPixels, peakPixels].flatMap((pixels) =>
        samplePoints.flatMap(({ rim, surface }) =>
          [rim, surface].flatMap(([offsetX, offsetY]) => {
            const marked = sampleColor(pixels, offsetX, offsetY);
            const baseline = sampleColor(baselinePixels, offsetX, offsetY);
            return marked.map((channel, index) => channel - baseline[index]!);
          })
        )
      ),
    );

    const metrics = {
      neighborRimTroughLift,
      neighborRimPeakLift,
      neighborSurfaceTroughLift,
      neighborSurfacePeakLift,
      sourceTroughLift,
      sourcePeakLift,
      markedBaseAccentChromaDistance: chromaDistance(markedBaseColor, accentColor),
      markedBaseOrdinaryChromaDistance:
        chromaDistance(markedBaseColor, ordinaryColor),
      markedSurfacePatternVariationRatio:
        standardDeviation(markedPatternSurface) /
          Math.max(0.001, standardDeviation(baselinePatternSurface)),
      markedSurfaceShadingRange:
        Math.max(...markedSurfaceSamples) - Math.min(...markedSurfaceSamples),
      markedBevelContrast,
      markedCentralDarkCoverageAtTrough: troughGlyph.centralDarkCoverage,
      markedCentralDarkCoverageAtPeak: peakGlyph.centralDarkCoverage,
      glyphIvoryFootprintRatioAtTrough: troughGlyph.footprintRatio,
      glyphIvoryFootprintRatioAtPeak: peakGlyph.footprintRatio,
      glyphIvoryRetentionRatio: retainedIvoryPixels /
        Math.max(1, troughGlyph.ivoryPixels, peakGlyph.ivoryPixels),
      glyphIvoryMinimumColorDistanceAtTrough:
        troughGlyph.minimumIvoryColorDistance,
      glyphIvoryMinimumColorDistanceAtPeak: peakGlyph.minimumIvoryColorDistance,
      glyphStaticColorDelta: glyphStaticColorDeltaTotal /
        Math.max(1, retainedIvoryPixels),
      glyphUnderstrokeCoverageAtTrough: troughGlyph.understrokeCoverage,
      glyphUnderstrokeCoverageAtPeak: peakGlyph.understrokeCoverage,
      glyphUnderstrokeFaceDropAtTrough: troughGlyph.understrokeFaceDrop,
      glyphUnderstrokeFaceDropAtPeak: peakGlyph.understrokeFaceDrop,
      glyphContrastAtTrough: troughGlyph.contrast,
      glyphContrastAtPeak: peakGlyph.contrast,
      sourceFacePeakClippedCoverage: clippedSourcePixels /
        Math.max(1, sampledSourcePixels),
      minimumNeighborPatternContrastRatioAtTrough:
        minimumNeighborPatternContrastRatioAt(troughPixels),
      minimumNeighborPatternContrastRatioAtPeak:
        minimumNeighborPatternContrastRatioAt(peakPixels),
      minimumLightChannelDelta,
      outsideBoardLightDelta: {
        left: Math.abs(
          sampleLuminance(edgePixels, -4.62) -
            sampleLuminance(emptyPixels, -4.62),
        ),
        right: Math.abs(
          sampleLuminance(edgePixels, 5.62) -
            sampleLuminance(emptyPixels, 5.62),
        ),
        top: Math.abs(
          sampleLuminance(edgePixels, 0, -10.62) -
            sampleLuminance(emptyPixels, 0, -10.62),
        ),
        bottom: Math.abs(
          sampleLuminance(edgePixels, 0, 9.62) -
          sampleLuminance(emptyPixels, 0, 9.62),
        ),
      },
      overlapTargetRimDelta: Math.abs(
        sampleLuminance(overlapPixels, 0, -0.42) -
          sampleLuminance(singleFieldPixels, 0, -0.42),
      ),
      crossDirectionSurfaceLift: Math.abs(
        sampleLuminance(overlapPixels, 0, -0.25) -
          sampleLuminance(singleFieldPixels, 0, -0.25),
      ),
      gameplayCueLift: sampleLuminance(gameplayCuePixels, 0, 0) -
        sampleLuminance(isolatedPeakPixels, 0, 0),
      activationOutsideBoardLightDelta: Math.abs(
        sampleLuminance(activationFollowPixels, -4.62) -
          sampleLuminance(emptyPixels, -4.62),
      ),
      activationBoundaryDelta: Math.abs(
        sampleLuminance(activationActionEndPixels, -4) -
          sampleLuminance(activationFollowPixels, -4),
      ),
    };
    renderer.dispose();
    canvas.remove();
    return metrics;
  });
}

async function readMarkedCellOrderDifference(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const rendererUrl = "/src/render/renderer.ts";
    const { ThreeRenderer } = await import(rendererUrl);
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;inset:0;width:400px;height:800px;z-index:9999";
    document.body.append(canvas);
    const renderer = new ThreeRenderer(canvas, { initialQuality: "full" });
    const bright = {
      column: 3,
      row: 12,
      kind: "J",
      role: "settled",
      special: "blackout",
      specialEmphasis: 1,
    } as const;
    const dim = {
      column: 6,
      row: 12,
      kind: "J",
      role: "settled",
      special: "blackout",
      specialEmphasis: 0.2,
    } as const;
    const frame = (cells: readonly [typeof bright, typeof dim] | readonly [typeof dim, typeof bright]) => ({
      mode: "practice" as const,
      left: {
        playerId: "visual-order-test",
        cells,
        focused: true,
        concealed: false,
      },
      right: null,
    });
    const gl = canvas.getContext("webgl2");

    renderer.render(frame([bright, dim]), 825);
    if (gl === null) throw new Error("WebGL2 unavailable in browser test");
    gl.finish();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const first = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, first);

    renderer.render(frame([dim, bright]), 3_625);
    gl.finish();
    const second = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, second);

    let changedPixels = 0;
    for (let offset = 0; offset < first.length; offset += 4) {
      if (
        Math.abs(first[offset]! - second[offset]!) > 1 ||
        Math.abs(first[offset + 1]! - second[offset + 1]!) > 1 ||
        Math.abs(first[offset + 2]! - second[offset + 2]!) > 1
      ) {
        changedPixels += 1;
      }
    }
    renderer.dispose();
    canvas.remove();
    return changedPixels / (width * height);
  });
}

async function seedLegacyCompletedMatch(page: Page): Promise<void> {
  const challengeId = "reload-challenge";
  const matchId = `${challengeId}:round:1`;
  const seed = "00112233445566778899aabbccddeeff";
  const alice = { id: "alice@example.test", displayName: "Alice" };
  const bob = { id: "bob@example.test", displayName: "Bob" };
  const configHash = hashCanonicalHex({
    rulesVersion: RULES.rulesVersion,
    rulesHash: RULES_HASH,
    seed,
    seatAPlayerId: alice.id,
    seatBPlayerId: bob.id,
  });
  const emptyStats = {
    score: 0,
    lines: 0,
    garbageSent: 0,
    powersActivated: 0,
    tetrises: 0,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  };
  const payloads = [
    {
      schema: "split-stack/lobby/v1",
      kind: "challenge-created",
      eventId: "challenge-created",
      logicalClock: 1,
      challengeId,
      actor: alice,
      seatBVacancyId: "vacancy-b",
      rulesHash: RULES_HASH,
    },
    {
      schema: "split-stack/lobby/v1",
      kind: "seat-claimed",
      eventId: "seat-b-claimed",
      logicalClock: 2,
      challengeId,
      actor: bob,
      vacancyId: "vacancy-b",
    },
    {
      schema: "split-stack/session-claim/v1",
      kind: "session-claim",
      challengeId,
      occupancyEventId: "challenge-created",
      runtimeSessionId: "old-runtime-a",
      actor: alice,
      logicalClock: 3,
      eventId: "seat-a-session",
    },
    {
      schema: "split-stack/session-claim/v1",
      kind: "session-claim",
      challengeId,
      occupancyEventId: "seat-b-claimed",
      runtimeSessionId: "old-runtime-b",
      actor: bob,
      logicalClock: 4,
      eventId: "seat-b-session",
    },
    {
      schema: "split-stack/match-announcement/v1",
      eventId: "round-one-announcement",
      logicalClock: 5,
      challengeId,
      matchId,
      round: 1,
      rulesHash: RULES_HASH,
      configHash,
      seed,
      seedHash: hashCanonicalHex({ seed }),
      seatAPlayerId: alice.id,
      seatBPlayerId: bob.id,
      actor: alice,
    },
    {
      schema: "split-stack/result/v1",
      matchId,
      seedHash: hashCanonicalHex({ seed }),
      players: [alice, bob],
      outcome: "seat-a",
      reason: "top-out",
      durationTicks: 600,
      finalLevel: 1,
      statsByPlayer: {
        [alice.id]: { ...emptyStats, score: 2_400, lines: 12 },
        [bob.id]: { ...emptyStats, topOutTick: 600 },
      },
      completedBy: alice.id,
    },
  ];
  const updates = payloads.map((payload, index) => ({
    payload,
    serial: index + 1,
    _sender: index === 1 || index === 3 ? bob.id : alice.id,
  }));
  await page.addInitScript((records) => {
    window.localStorage.setItem("__xdcUpdatesKey__", JSON.stringify(records));
  }, updates);
}

async function seedOfflineOpenChallenge(page: Page): Promise<void> {
  const alice = { id: "alice@example.test", displayName: "Alice" };
  await page.addInitScript((records) => {
    window.localStorage.setItem("__xdcUpdatesKey__", JSON.stringify(records));
  }, [{
    payload: {
      schema: "split-stack/competition/v2",
      kind: "challenge-created",
      eventId: "offline-challenge-created",
      logicalClock: 1,
      actor: alice,
      challengeId: "offline-challenge",
      rulesHash: RULES_HASH,
      vacancyId: "offline-vacancy",
    },
    serial: 1,
    _sender: alice.id,
  }]);
}

async function seedLobbyLayoutData(page: Page): Promise<void> {
  const alice = {
    id: "alice@example.test",
    displayName: "Alice With A Deliberately Long Competitive Name",
  };
  const bob = { id: "bob@example.test", displayName: "Bob" };
  const carol = { id: "carol@example.test", displayName: "Carol" };
  const seriesId = "layout-series";
  const pairingId = "layout-pairing";
  const matchId = `${seriesId}:round:1`;
  const startedEventId = "layout-match-started";
  const seed = "0123456789abcdeffedcba9876543210";
  const stats = (score: number, topOutTick?: number) => ({
    score,
    lines: 12,
    garbageSent: 4,
    powersActivated: 2,
    tetrises: 1,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
    ...(topOutTick === undefined ? {} : { topOutTick }),
  });
  const payloads = [
    {
      schema: "split-stack/competition/v2",
      kind: "challenge-created",
      eventId: "layout-series-created",
      logicalClock: 1,
      actor: alice,
      challengeId: seriesId,
      rulesHash: RULES_HASH,
      vacancyId: "layout-series-vacancy",
    },
    {
      schema: "split-stack/competition/v2",
      kind: "challenge-claimed",
      eventId: pairingId,
      logicalClock: 2,
      actor: bob,
      challengeId: seriesId,
      vacancyId: "layout-series-vacancy",
    },
    {
      schema: "split-stack/competition/v2",
      kind: "runtime-claimed",
      eventId: "layout-runtime-alice",
      logicalClock: 3,
      actor: alice,
      pairingId,
      runtimeSessionId: "layout-session-alice",
    },
    {
      schema: "split-stack/competition/v2",
      kind: "runtime-claimed",
      eventId: "layout-runtime-bob",
      logicalClock: 4,
      actor: bob,
      pairingId,
      runtimeSessionId: "layout-session-bob",
    },
    {
      schema: "split-stack/competition/v2",
      kind: "ready-changed",
      eventId: "layout-ready-alice",
      logicalClock: 5,
      actor: alice,
      pairingId,
      runtimeSessionId: "layout-session-alice",
      ready: true,
    },
    {
      schema: "split-stack/competition/v2",
      kind: "ready-changed",
      eventId: "layout-ready-bob",
      logicalClock: 6,
      actor: bob,
      pairingId,
      runtimeSessionId: "layout-session-bob",
      ready: true,
    },
    {
      schema: "split-stack/competition/v2",
      kind: "match-started",
      eventId: startedEventId,
      logicalClock: 7,
      actor: alice,
      pairingId,
      seriesId,
      round: 1,
      matchId,
      rulesHash: RULES_HASH,
      configHash: hashCanonicalHex({
        rulesVersion: RULES.rulesVersion,
        rulesHash: RULES_HASH,
        seed,
        seatAPlayerId: alice.id,
        seatBPlayerId: bob.id,
      }),
      seed,
      seedHash: hashCanonicalHex({ seed }),
      seatAPlayerId: alice.id,
      seatBPlayerId: bob.id,
      seatASessionId: "layout-session-alice",
      seatBSessionId: "layout-session-bob",
    },
    {
      schema: "split-stack/competition/v2",
      kind: "match-finished",
      eventId: "layout-match-finished",
      logicalClock: 8,
      actor: alice,
      matchId,
      startedEventId,
      result: {
        schema: "split-stack/result/v1",
        matchId,
        seedHash: hashCanonicalHex({ seed }),
        players: [alice, bob],
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 1_200,
        finalLevel: 4,
        statsByPlayer: {
          [alice.id]: stats(12_400),
          [bob.id]: stats(9_800, 1_200),
        },
        completedBy: alice.id,
      },
    },
    ...[alice, bob].map((actor, index) => ({
      schema: "split-stack/competition/v2",
      kind: "practice-completed",
      eventId: `layout-practice-${actor.id}`,
      logicalClock: 9 + index,
      actor,
      rulesHash: RULES_HASH,
      runId: `layout-run-${actor.id}`,
      endReason: "top-out",
      score: 20_000 - index * 2_500,
      durationTicks: 1_200,
      finalLevel: 4,
      finalStats: stats(20_000 - index * 2_500, 1_200),
    })),
    {
      schema: "split-stack/competition/v2",
      kind: "challenge-created",
      eventId: "layout-open-created",
      logicalClock: 11,
      actor: carol,
      challengeId: "layout-open-challenge",
      rulesHash: RULES_HASH,
      vacancyId: "layout-open-vacancy",
    },
  ];
  const updates = payloads.map((payload, index) => ({
    payload,
    serial: index + 1,
    _sender: payload.actor.id,
  }));
  await page.addInitScript((records) => {
    window.localStorage.setItem("__xdcUpdatesKey__", JSON.stringify(records));
  }, updates);
}

function localScore(page: Page): Locator {
  return page
    .locator('[data-side="left"] .hud-stats .hud-stat-value')
    .first();
}

async function numericText(locator: Locator): Promise<number> {
  const value = Number.parseInt((await locator.textContent()) ?? "", 10);
  return Number.isFinite(value) ? value : 0;
}

async function expectScoreAbove(locator: Locator, baseline: number): Promise<void> {
  await expect
    .poll(() => numericText(locator), {
      message: `expected the score to increase above ${baseline}`,
    })
    .toBeGreaterThan(baseline);
}

async function openVersusPair(
  context: BrowserContext,
  seatAPage: Page,
): Promise<{ seatA: Page; seatB: Page }> {
  await openApp(seatAPage, "Alice");
  await seatAPage.getByRole("button", { name: "Create challenge" }).click();
  await waitForWaitingChallenge(seatAPage);

  const seatBPage = await context.newPage();
  await openApp(seatBPage, "Bob");
  await openLobby(seatBPage);
  const joinButton = seatBPage.getByRole("button", { name: "Join Alice", exact: true });
  await expect(joinButton).toBeEnabled();
  await joinButton.click();

  await expect(seatAPage.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatAPage.getByRole("application", { name: "Opponent board" })).toBeVisible();
  await expect(seatBPage.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
  return { seatA: seatAPage, seatB: seatBPage };
}

async function openNamedVersusPair(
  context: BrowserContext,
  seatAName: string,
  seatBName: string,
): Promise<{ seatA: Page; seatB: Page }> {
  const seatA = await context.newPage();
  await openApp(seatA, seatAName);
  await seatA.getByRole("button", { name: "Create challenge" }).click();
  await waitForWaitingChallenge(seatA);

  const seatB = await context.newPage();
  await openApp(seatB, seatBName);
  await openLobby(seatB);
  await seatB.getByRole("button", {
    name: `Join ${seatAName}`,
    exact: true,
  }).click();
  await expect(
    seatA.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    seatB.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  return { seatA, seatB };
}

interface ElementRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rectRight(rect: ElementRect): number {
  return rect.x + rect.width;
}

function rectBottom(rect: ElementRect): number {
  return rect.y + rect.height;
}

function rectCenterX(rect: ElementRect): number {
  return rect.x + rect.width / 2;
}

function rectanglesOverlap(left: ElementRect, right: ElementRect): boolean {
  return (
    left.x < rectRight(right) &&
    rectRight(left) > right.x &&
    left.y < rectBottom(right) &&
    rectBottom(left) > right.y
  );
}

function expectNear(actual: number, expected: number, label: string, tolerance = 1.25): void {
  expect(
    Math.abs(actual - expected),
    `${label}: expected ${actual} to be within ${tolerance}px of ${expected}`,
  ).toBeLessThanOrEqual(tolerance);
}

async function elementRect(locator: Locator): Promise<ElementRect> {
  await expect(locator).toBeAttached();
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

async function expectPlayerFrameGeometry(
  page: Page,
  side: "left" | "right",
  board: ElementRect,
  rail: ElementRect,
  availableBottom: number,
): Promise<void> {
  const pane = page.locator(`.player-pane[data-side="${side}"]`);
  const header = await elementRect(pane.locator(".hud-top-info"));
  const name = await elementRect(pane.locator(".player-name"));
  const stats = await elementRect(pane.locator(".hud-stats"));
  const hold = await elementRect(pane.locator(".hold-preview"));
  const next = await elementRect(pane.locator(".next-preview"));
  const footer = await elementRect(pane.locator(".status-row"));
  const garbage = await elementRect(pane.locator(".incoming-garbage"));
  const icon = await elementRect(pane.locator(".upcoming-power-icon"));
  const meter = await elementRect(pane.locator(".power-meter"));
  const menu = await elementRect(page.getByRole("button", { name: "Match menu" }));
  const headerHeight = board.width < 160 ? 64 : 72;
  const completeFrameHeight = headerHeight + 4 + board.height + 6 + 40;
  const expectedFrameTop = (availableBottom - completeFrameHeight) / 2;

  expectNear(board.y, expectedFrameTop + headerHeight + 4, `${side} board top`);
  expect(expectedFrameTop).toBeGreaterThanOrEqual(3.5);
  expectNear(footer.x, board.x, `${side} footer left`);
  expectNear(footer.y, rectBottom(board) + 6, `${side} footer top`);
  expectNear(footer.width, board.width, `${side} footer width`);
  expectNear(footer.height, 40, `${side} footer height`);
  expect(availableBottom - rectBottom(footer)).toBeGreaterThanOrEqual(3.5);

  for (const [label, content] of [
    ["player name", name],
    ["stats", stats],
    ["Hold", hold],
    ["Next", next],
  ] as const) {
    if (content.width === 0 || content.height === 0) continue;
    expect(content.y, `${side} ${label} starts inside the header band`).toBeGreaterThanOrEqual(
      expectedFrameTop - 0.5,
    );
    expect(
      rectBottom(content),
      `${side} ${label} remains above the board`,
    ).toBeLessThanOrEqual(board.y - 3.5);
    expect(content.x, `${side} ${label} starts at or inside the board edge`)
      .toBeGreaterThanOrEqual(board.x - 0.5);
    expect(rectRight(content), `${side} ${label} ends at or inside the board edge`)
      .toBeLessThanOrEqual(rectRight(board) + 0.5);
    expect(rectanglesOverlap(menu, content), `menu clears ${side} ${label}`).toBe(false);
  }
  expect(rectanglesOverlap(stats, hold)).toBe(false);
  expect(rectanglesOverlap(stats, next)).toBe(false);
  expect(rectanglesOverlap(hold, next)).toBe(false);
  expectNear(header.x, board.x, `${side} header left`);
  expectNear(header.width, board.width, `${side} header width`);

  expectNear(rail.width, 22, `${side} rail width`);
  expectNear(rail.y, board.y, `${side} rail top`);
  expectNear(rail.height, board.height, `${side} rail height`);
  expectNear(icon.width, 18, `${side} icon width`);
  expectNear(icon.height, 18, `${side} icon height`);
  expectNear(rectCenterX(icon), rectCenterX(rail), `${side} icon centering`);
  expectNear(icon.y, rail.y + 2, `${side} rail top padding`);
  expect(rectBottom(icon)).toBeLessThanOrEqual(rectBottom(rail) + 0.5);
  expectNear(meter.width, 18, `${side} visible meter width`);
  expectNear(rectCenterX(meter), rectCenterX(rail), `${side} meter centering`);
  expectNear(meter.y, rectBottom(icon) + 3, `${side} icon-to-meter gap`);
  expectNear(rectBottom(meter), rectBottom(rail) - 2, `${side} rail bottom padding`);

  expectNear(rectCenterX(garbage), rectCenterX(rail), `${side} garbage column alignment`);
  expect(garbage.y).toBeGreaterThanOrEqual(footer.y - 0.5);
  expect(rectBottom(garbage)).toBeLessThanOrEqual(rectBottom(footer) + 0.5);
  expect(rectanglesOverlap(footer, garbage)).toBe(false);
  expect(rectanglesOverlap(menu, board)).toBe(false);
  expect(rectanglesOverlap(menu, footer)).toBe(false);
}

async function expectVersusFrameGeometry(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
  availableBottom = viewport.height,
): Promise<void> {
  const leftBoard = await elementRect(
    page.getByRole("application", { name: "Your board" }),
  );
  const rightBoard = await elementRect(
    page.getByRole("application", { name: "Opponent board" }),
  );
  const leftRail = await elementRect(
    page.locator('.player-pane[data-side="left"] .power-rail'),
  );
  const rightRail = await elementRect(
    page.locator('.player-pane[data-side="right"] .power-rail'),
  );

  expectNear(leftBoard.width, rightBoard.width, "equal board widths");
  expectNear(leftBoard.height, rightBoard.height, "equal board heights");
  expectNear(leftBoard.y, rightBoard.y, "aligned board tops");
  expectNear(rightBoard.x - rectRight(leftBoard), 54, "fixed center corridor");
  expectNear(leftRail.x, rectRight(leftBoard) + 4, "local board-to-rail gap");
  expectNear(rightRail.x, rectRight(leftRail) + 2, "inter-rail gap");
  expectNear(rightBoard.x, rectRight(rightRail) + 4, "opponent rail-to-board gap");
  expectNear(
    (leftBoard.x + rectRight(rightBoard)) / 2,
    viewport.width / 2,
    "packed PvP frame center",
  );
  expect(leftBoard.x).toBeGreaterThanOrEqual(7.5);
  expect(rectRight(rightBoard)).toBeLessThanOrEqual(viewport.width - 7.5);

  const menu = await elementRect(page.getByRole("button", { name: "Match menu" }));
  expectNear(rectCenterX(menu), viewport.width / 2, "PvP menu corridor centering");
  expect(menu.x).toBeGreaterThanOrEqual(rectRight(leftBoard) - 0.5);
  expect(rectRight(menu)).toBeLessThanOrEqual(rightBoard.x + 0.5);
  expect(rectBottom(menu)).toBeLessThanOrEqual(leftBoard.y - 3.5);

  await expectPlayerFrameGeometry(page, "left", leftBoard, leftRail, availableBottom);
  await expectPlayerFrameGeometry(page, "right", rightBoard, rightRail, availableBottom);
}

async function expectPracticeFrameGeometry(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
  availableBottom = viewport.height,
): Promise<void> {
  const board = await elementRect(page.getByRole("application", { name: "Your board" }));
  const rail = await elementRect(
    page.locator('.player-pane[data-side="left"] .power-rail'),
  );

  expectNear(rail.x, rectRight(board) + 4, "Practice board-to-rail gap");
  expectNear(
    (board.x + rectRight(rail)) / 2,
    viewport.width / 2,
    "centered Practice board-and-rail unit",
  );
  expect(board.x).toBeGreaterThanOrEqual(7.5);
  expect(rectRight(rail)).toBeLessThanOrEqual(viewport.width - 7.5);
  await expectPlayerFrameGeometry(page, "left", board, rail, availableBottom);
}

async function enforceSingleRealtimeListener(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const lifecycle = {
      joins: 0,
      leaves: 0,
      listeners: 0,
      active: 0,
      maxActive: 0,
    };
    (window as unknown as { __splitStackRealtimeLifecycle: typeof lifecycle })
      .__splitStackRealtimeLifecycle = lifecycle;
    let failNextJoin = false;
    let sendBlocked = false;
    let sendCount = 0;
    (
      window as unknown as {
        __splitStackFailNextRealtimeJoin: () => void;
      }
    ).__splitStackFailNextRealtimeJoin = () => {
      failNextJoin = true;
    };
    (
      window as unknown as {
        __splitStackSetRealtimeSendBlocked: (blocked: boolean) => void;
      }
    ).__splitStackSetRealtimeSendBlocked = (blocked) => {
      sendBlocked = blocked;
    };
    (
      window as unknown as {
        __splitStackRealtimeSendCount: () => number;
      }
    ).__splitStackRealtimeSendCount = () => sendCount;
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const join = host.joinRealtimeChannel?.bind(host);
        let backingChannel: WebxdcRealtimeChannel | undefined;
        if (join !== undefined) {
          host.joinRealtimeChannel = () => {
            lifecycle.joins += 1;
            if (lifecycle.active > 0) {
              throw new Error("realtime listener already exists");
            }
            if (failNextJoin) {
              failNextJoin = false;
              throw new Error("realtime channel temporarily unavailable");
            }
            const channel = (backingChannel ??= join());
            lifecycle.active += 1;
            lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active);
            let facadeActive = true;
            return {
              setListener: (listener) => {
                if (!facadeActive) throw new Error("realtime listener has left");
                lifecycle.listeners += 1;
                channel.setListener((data) => {
                  if (facadeActive) listener(data);
                });
              },
              send: (data) => {
                if (!facadeActive) throw new Error("realtime listener has left");
                sendCount += 1;
                if (sendBlocked) return;
                channel.send(data);
              },
              leave: () => {
                if (!facadeActive) return;
                facadeActive = false;
                lifecycle.leaves += 1;
                lifecycle.active -= 1;
              },
            };
          };
        }
        installedHost = host;
      },
    });
  });
}

async function dropFirstPeerRuntimeClaimDelivery(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const setUpdateListener = host.setUpdateListener.bind(host);
        let droppedPeerClaim = false;
        (
          window as unknown as {
            __splitStackDroppedPeerRuntimeClaimCount: () => number;
          }
        ).__splitStackDroppedPeerRuntimeClaimCount = () =>
          droppedPeerClaim ? 1 : 0;
        host.setUpdateListener = (listener, serial) =>
          setUpdateListener((update) => {
            const payload = update.payload as {
              readonly kind?: string;
              readonly actor?: { readonly id?: string };
            };
            if (
              !droppedPeerClaim &&
              payload.kind === "runtime-claimed" &&
              payload.actor?.id !== host.selfAddr
            ) {
              droppedPeerClaim = true;
              return;
            }
            listener(update);
          }, serial);
        installedHost = host;
      },
    });
  });
}

async function forceWebxdcIdentityOnRoute(
  page: Page,
  identity: string,
): Promise<void> {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await page.addInitScript(({ displayName, address }) => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        Object.defineProperty(host, "selfName", {
          configurable: true,
          value: displayName,
        });
        Object.defineProperty(host, "selfAddr", {
          configurable: true,
          value: address,
        });
        installedHost = host;
      },
    });
  }, {
    displayName: identity,
    address: `${slug}@example.test`,
  });
}

async function forceIdentityWithSuppressedRealtimeInbound(
  page: Page,
  identity: string,
): Promise<void> {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await page.addInitScript(({ displayName, address }) => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        Object.defineProperty(host, "selfName", {
          configurable: true,
          value: displayName,
        });
        Object.defineProperty(host, "selfAddr", {
          configurable: true,
          value: address,
        });
        const join = host.joinRealtimeChannel?.bind(host);
        if (join !== undefined) {
          host.joinRealtimeChannel = () => {
            const channel = join();
            return {
              setListener: () => channel.setListener(() => {}),
              send: (data) => channel.send(data),
              leave: () => channel.leave?.(),
            };
          };
        }
        installedHost = host;
      },
    });
  }, {
    displayName: identity,
    address: `${slug}@example.test`,
  });
}

async function failFirstDurableUpdate(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        const sendUpdate = host.sendUpdate.bind(host);
        let failed = false;
        host.sendUpdate = async (update, description) => {
          if (!failed) {
            failed = true;
            throw new Error("simulated transient durable failure");
          }
          await sendUpdate(update, description);
        };
        installedHost = host;
      },
    });
  });
}

async function dropOwnChallengeCreatedEchoes(
  context: BrowserContext,
  maximumDrops: number,
): Promise<void> {
  await context.addInitScript((dropLimit) => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const setUpdateListener = host.setUpdateListener.bind(host);
        let dropped = 0;
        (
          window as unknown as {
            __splitStackDroppedChallengeEchoes: () => number;
          }
        ).__splitStackDroppedChallengeEchoes = () => dropped;
        host.setUpdateListener = (listener, serial) =>
          setUpdateListener((update) => {
            const payload = update.payload as {
              readonly kind?: string;
              readonly actor?: { readonly id?: string };
            };
            if (
              dropped < dropLimit &&
              payload.kind === "challenge-created" &&
              payload.actor?.id === host.selfAddr
            ) {
              dropped += 1;
              return;
            }
            listener(update);
          }, serial);
        installedHost = host;
      },
    });
  }, maximumDrops);
}

async function suppressOwnMatchConcededEchoes(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    let installedHost: WebxdcHost | undefined;
    let suppressEchoes = true;
    (
      window as unknown as {
        __splitStackReleaseOwnMatchConcededEchoes: () => void;
      }
    ).__splitStackReleaseOwnMatchConcededEchoes = () => {
      suppressEchoes = false;
    };
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const setUpdateListener = host.setUpdateListener.bind(host);
        host.setUpdateListener = (listener, serial) =>
          setUpdateListener((update) => {
            const payload = update.payload as {
              readonly kind?: string;
              readonly actor?: { readonly id?: string };
            };
            if (
              suppressEchoes &&
              payload.kind === "match-conceded" &&
              payload.actor?.id === host.selfAddr
            ) {
              return;
            }
            listener(update);
          }, serial);
        installedHost = host;
      },
    });
  });
}

async function failFirstChatFeedbackUpdate(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const sendUpdate = host.sendUpdate.bind(host);
        host.sendUpdate = async (update, description) => {
          const hasChatFeedback = update.info !== undefined ||
            update.href !== undefined ||
            update.summary !== undefined ||
            update.notify !== undefined;
          if (
            hasChatFeedback &&
            window.localStorage.getItem("__splitStackFailedChatFeedbackOnce__") === null
          ) {
            window.localStorage.setItem("__splitStackFailedChatFeedbackOnce__", "1");
            throw new Error("simulated close before chat feedback retry");
          }
          await sendUpdate(update, description);
        };
        installedHost = host;
      },
    });
  });
}

async function duplicateRawDuringFirstChatFeedbackFailure(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        host.sendUpdateInterval = 0;
        const sendUpdate = host.sendUpdate.bind(host);
        let firstRaw: WebxdcUpdate | undefined;
        let failedFeedback = false;
        host.sendUpdate = async (update, description) => {
          const hasChatFeedback = update.info !== undefined ||
            update.href !== undefined ||
            update.summary !== undefined ||
            update.notify !== undefined;
          if (!hasChatFeedback && firstRaw === undefined) {
            firstRaw = update;
          }
          if (hasChatFeedback && !failedFeedback && firstRaw !== undefined) {
            failedFeedback = true;
            await sendUpdate(firstRaw, description);
            throw new Error("simulated metadata failure after a delayed raw echo");
          }
          await sendUpdate(update, description);
        };
        installedHost = host;
      },
    });
  });
}

async function failFirstRealtimeJoinOnFuturePages(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    let installedHost: WebxdcHost | undefined;
    Object.defineProperty(window, "webxdc", {
      configurable: true,
      get: () => installedHost,
      set: (host: WebxdcHost) => {
        const join = host.joinRealtimeChannel?.bind(host);
        let failed = false;
        if (join !== undefined) {
          host.joinRealtimeChannel = () => {
            if (!failed) {
              failed = true;
              throw new Error("simulated first realtime join failure");
            }
            return join();
          };
        }
        installedHost = host;
      },
    });
  });
}

async function installControllableMonotonicClock(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const realNow = performance.now.bind(performance);
    let offsetMs = 0;
    let frozenNowMs: number | null = null;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => frozenNowMs ?? realNow() + offsetMs,
    });
    (
      window as unknown as {
        __splitStackAdvanceMonotonic: (milliseconds: number) => void;
        __splitStackFreezeMonotonic: () => void;
      }
    ).__splitStackAdvanceMonotonic = (milliseconds) => {
      if (frozenNowMs === null) offsetMs += milliseconds;
      else frozenNowMs += milliseconds;
    };
    (
      window as unknown as {
        __splitStackFreezeMonotonic: () => void;
      }
    ).__splitStackFreezeMonotonic = () => {
      frozenNowMs = realNow() + offsetMs;
    };
  });
}

async function advanceMonotonic(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((amount) => {
    (
      window as unknown as {
        __splitStackAdvanceMonotonic: (milliseconds: number) => void;
      }
    ).__splitStackAdvanceMonotonic(amount);
  }, milliseconds);
}

async function advancePairMonotonic(
  seatA: Page,
  seatB: Page,
  milliseconds: number,
  stepMs = 250,
): Promise<void> {
  let remainingMs = milliseconds;
  while (remainingMs > 0) {
    const incrementMs = Math.min(stepMs, remainingMs);
    await Promise.all([
      advanceMonotonic(seatA, incrementMs),
      advanceMonotonic(seatB, incrementMs),
    ]);
    remainingMs -= incrementMs;
    // Yield one pump interval so traffic remains continuous while the
    // controllable clock advances; wall time is not used for the assertion.
    await seatA.waitForTimeout(60);
  }
}

async function advanceMonotonicUntilVisible(
  page: Page,
  locator: Locator,
  maxAdvanceMs: number,
  stepMs = 100,
): Promise<number> {
  let advancedMs = 0;
  while (advancedMs < maxAdvanceMs && !(await locator.isVisible())) {
    const incrementMs = Math.min(stepMs, maxAdvanceMs - advancedMs);
    await advanceMonotonic(page, incrementMs);
    advancedMs += incrementMs;
    await page.waitForTimeout(60);
  }
  return advancedMs;
}

async function freezeMonotonic(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as {
        __splitStackFreezeMonotonic: () => void;
      }
    ).__splitStackFreezeMonotonic();
  });
}

async function setVisibilityState(
  page: Page,
  visibilityState: "hidden" | "visible",
): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibilityState);
}

async function setRealtimeSendBlocked(page: Page, blocked: boolean): Promise<void> {
  await page.evaluate((nextBlocked) => {
    (
      window as unknown as {
        __splitStackSetRealtimeSendBlocked: (blocked: boolean) => void;
      }
    ).__splitStackSetRealtimeSendBlocked(nextBlocked);
  }, blocked);
}

async function realtimeSendCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __splitStackRealtimeSendCount: () => number;
      }
    ).__splitStackRealtimeSendCount()
  );
}

async function expectRecoveryStatusCentered(page: Page): Promise<void> {
  const [box, viewport] = await Promise.all([
    page.locator(".center-overlay-card").boundingBox(),
    Promise.resolve(page.viewportSize()),
  ]);
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) return;
  expect(
    Math.abs(box.x + box.width / 2 - viewport.width / 2),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(box.y + box.height / 2 - viewport.height / 2),
  ).toBeLessThanOrEqual(2);
}

test("Home stays compact and opens the sectioned Lobby", async ({ page }) => {
  await openApp(page);

  const actions = page.locator(".home-actions button:visible");
  await expect(actions).toHaveCount(3);
  await expect(actions.nth(0)).toHaveAccessibleName("Create challenge");
  await expect(actions.nth(1)).toHaveAccessibleName(/^Lobby ·/);
  await expect(actions.nth(2)).toHaveAccessibleName("Practice");
  await expect(page.getByRole("heading", { name: "Open challenges" })).toBeHidden();

  await openLobby(page);
  await expect(
    page.getByRole("heading", { name: "Open challenges", exact: true }),
  ).toBeVisible();
  for (const heading of [
    "Your activity",
    "Starting soon",
    "Live games",
    "Recent results",
    "Standings",
    "Practice leaderboard",
  ]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeHidden();
  }

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open challenges" })).toBeHidden();
});

test("Lobby actions and tables keep their responsive layout", DEVICE_MATRIX, async ({ page }) => {
  await seedLobbyLayoutData(page);
  await openApp(page, "Layout Viewer");
  await openLobby(page);

  const challenge = page.locator(".lobby-challenge-row").filter({ hasText: "Carol" });
  const copy = challenge.locator(".lobby-row-copy");
  const join = challenge.getByRole("button", { name: "Join Carol", exact: true });
  await Promise.all([
    expect(challenge).toBeVisible(),
    expect(copy).toBeVisible(),
    expect(join).toBeVisible(),
  ]);

  const { challengeRect, copyRect, joinRect } = await challenge.evaluate((row) => {
    const copyNode = row.querySelector<HTMLElement>(".lobby-row-copy");
    const joinNode = row.querySelector<HTMLElement>(".lobby-row-action");
    if (copyNode === null || joinNode === null) {
      throw new Error("Challenge row is missing its copy or Join action");
    }
    const readRect = (node: Element): ElementRect => {
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      challengeRect: readRect(row),
      copyRect: readRect(copyNode),
      joinRect: readRect(joinNode),
    };
  });
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (viewport === null) return;

  if (viewport.width <= 520) {
    expect(joinRect.y).toBeGreaterThanOrEqual(rectBottom(copyRect) + 7);
    expectNear(joinRect.x, copyRect.x, "portrait Join left edge");
    expectNear(joinRect.width, copyRect.width, "portrait Join full width");
  } else {
    expect(joinRect.x).toBeGreaterThanOrEqual(rectRight(copyRect) + 7);
    expectNear(
      joinRect.y + joinRect.height / 2,
      challengeRect.y + challengeRect.height / 2,
      "desktop Join vertical centering",
    );
    expect(joinRect.width).toBeLessThan(challengeRect.width * 0.4);
    expect(joinRect.height).toBeLessThan(challengeRect.height - 8);
  }

  for (const [label, table] of [
    ["Standings", page.locator("table.standings-table")],
    ["Practice leaderboard", page.locator("table.practice-table")],
  ] as const) {
    await expect(table).toBeVisible();
    const section = table.locator("xpath=ancestor::section[1]");
    const body = section.locator(".lobby-section-body");
    const [sectionRect, bodyRect, tableRect] = await Promise.all([
      elementRect(section),
      elementRect(body),
      elementRect(table),
    ]);

    expectNear(tableRect.x, bodyRect.x, `${label} table left edge`);
    expectNear(tableRect.width, bodyRect.width, `${label} table full width`);
    expect(tableRect.x).toBeGreaterThanOrEqual(sectionRect.x - 0.5);
    expect(rectRight(tableRect)).toBeLessThanOrEqual(rectRight(sectionRect) + 0.5);
    expect(
      await section.evaluate((node) => node.scrollWidth - node.clientWidth),
      `${label} card must not scroll horizontally`,
    ).toBeLessThanOrEqual(1);

    const headers = table.locator("thead th");
    const firstRowCells = table.locator("tbody tr").first().locator("th, td");
    const columnCount = await headers.count();
    expect(await firstRowCells.count()).toBe(columnCount);
    const [headerAlignments, bodyAlignments] = await Promise.all([
      headers.evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).textAlign)
      ),
      firstRowCells.evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).textAlign)
      ),
    ]);
    expect(bodyAlignments).toEqual(headerAlignments);
    for (let index = 0; index < columnCount; index += 1) {
      const [headerRect, cellRect] = await Promise.all([
        elementRect(headers.nth(index)),
        elementRect(firstRowCells.nth(index)),
      ]);
      expectNear(cellRect.x, headerRect.x, `${label} column ${index + 1} left edge`);
      expectNear(cellRect.width, headerRect.width, `${label} column ${index + 1} width`);
    }
  }
});

test("a stale deeplink falls back once to a non-blocking Lobby notice", async ({
  page,
}) => {
  await forceWebxdcIdentityOnRoute(page, "Alice");
  await page.goto("/?deeplink=1#match/stale-match");

  await expect(
    page.getByRole("heading", { name: "Lobby", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("This link is no longer active.", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await openLobby(page);
  await expect(
    page.getByText("This link is no longer active.", { exact: true }),
  ).toBeHidden();
});

test("valid challenge, result, and leaderboard deeplinks open once after replay", async ({
  page,
}) => {
  await seedLobbyLayoutData(page);
  await forceWebxdcIdentityOnRoute(page, "Viewer");

  await page.goto("/?deeplink=challenge#lobby/challenge/layout-open-challenge");
  await expect(
    page.getByRole("heading", { name: "Lobby", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-challenge-id="layout-open-challenge"]'),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

  await page.goto("/?deeplink=result#result/layout-series%3Around%3A1");
  await expect(page.getByRole("heading", { name: "Alice With A Deliberately Long Competitive Name" }))
    .toBeVisible();
  await expect(page.locator('.results-summary[aria-label="Final scores"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

  await page.goto(
    `/?deeplink=practice#practice/leaderboard/${encodeURIComponent(RULES_HASH)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Lobby", exact: true }),
  ).toBeVisible();
  await expect(page.locator("table.practice-table")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
});

test("a creator can cancel a waiting challenge from Home", async ({ page }) => {
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();

  await waitForWaitingChallenge(page);
  await expect(page.locator(".home-status")).toBeEmpty();
  const waitingActions = page.locator(".home-actions button:visible");
  await expect(waitingActions).toHaveCount(3);
  await expect(waitingActions.nth(0)).toHaveAccessibleName("Cancel challenge");
  await expect(waitingActions.nth(1)).toHaveAccessibleName(/^Lobby ·/);
  await expect(waitingActions.nth(2)).toHaveAccessibleName("Practice");
  const cancel = page.getByRole("button", { name: "Cancel challenge" });
  await expect(cancel).toHaveClass(/destructive/);
  await cancel.click();

  await expect(page.getByRole("button", { name: "Create challenge" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel challenge" })).toBeHidden();
  await openLobby(page);
  await expect(page.getByText("No one is waiting for an opponent.")).toBeVisible();
});

test("challenge creation announces once while cancellation stays silent", async ({ page }) => {
  await openApp(page, "Alice");
  const create = page.getByRole("button", { name: "Create challenge" });
  await create.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await waitForWaitingChallenge(page);

  const feedbackCount = (kind: string) => page.evaluate((eventKind) => {
    const raw = window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]";
    const updates = JSON.parse(raw) as Array<{
      payload?: { kind?: string; eventId?: string };
      info?: string;
    }>;
    return {
      eventIds: [...new Set(updates
        .filter((update) => update.payload?.kind === eventKind)
        .map((update) => update.payload?.eventId))],
      infos: updates.filter((update) =>
        update.payload?.kind === eventKind && typeof update.info === "string"
      ).map((update) => update.info),
    };
  }, kind);

  await expect.poll(() => feedbackCount("challenge-created"), { timeout: 10_000 })
    .toEqual({
      eventIds: [expect.any(String)],
      infos: ["Alice is waiting for an opponent."],
    });

  const cancel = page.getByRole("button", { name: "Cancel challenge" });
  await cancel.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(create).toBeVisible();
  await expect.poll(
    async () => (await feedbackCount("challenge-cancelled")).eventIds,
    { timeout: 10_000 },
  ).toEqual([expect.any(String)]);
  const durableInterval = await page.evaluate(() =>
    Math.max(0, window.webxdc?.sendUpdateInterval ?? 0)
  );
  await page.waitForTimeout(durableInterval + 500);
  expect(await feedbackCount("challenge-cancelled")).toEqual({
    eventIds: [expect.any(String)],
    infos: [],
  });
});

test("accepted challenge chat feedback recovers once after a reload before retry", async ({
  context,
  page,
}) => {
  await failFirstChatFeedbackUpdate(context);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();

  await expect.poll(() => page.evaluate(() => ({
    failed: window.localStorage.getItem("__splitStackFailedChatFeedbackOnce__"),
    updates: (JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{ payload?: { kind?: string }; info?: string }>).filter(
      (update) => update.payload?.kind === "challenge-created",
    ).map((update) => update.info ?? null),
  })), { timeout: 10_000 }).toEqual({
    failed: "1",
    updates: [null],
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{ payload?: { kind?: string; eventId?: string }; info?: string }>;
    const created = updates.filter(
      (update) => update.payload?.kind === "challenge-created",
    );
    const feedbackJournal = Object.keys(window.localStorage)
      .find((key) => key.startsWith("split-stack/pending-chat-feedback/v2:"));
    return {
      eventIds: [...new Set(created.map((update) => update.payload?.eventId))],
      infos: created.flatMap((update) =>
        update.info === undefined ? [] : [update.info]
      ),
      journal: feedbackJournal === undefined
        ? []
        : JSON.parse(window.localStorage.getItem(feedbackJournal) ?? "[]"),
    };
  }), { timeout: 10_000 }).toEqual({
    eventIds: [expect.any(String)],
    infos: ["Alice is waiting for an opponent."],
    journal: [],
  });
});

test("a delayed raw echo cannot acknowledge queued challenge feedback", async ({
  context,
  page,
}) => {
  await duplicateRawDuringFirstChatFeedbackFailure(context);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();

  await expect.poll(() => page.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{ payload?: { kind?: string; eventId?: string }; info?: string }>;
    const created = updates.filter(
      (update) => update.payload?.kind === "challenge-created",
    );
    return {
      eventIds: [...new Set(created.map((update) => update.payload?.eventId))],
      rawCount: created.filter((update) => update.info === undefined).length,
      infos: created.flatMap((update) =>
        update.info === undefined ? [] : [update.info]
      ),
    };
  }), { timeout: 10_000 }).toEqual({
    eventIds: [expect.any(String)],
    rawCount: 2,
    infos: ["Alice is waiting for an opponent."],
  });
});

test("a transient durable failure retries the challenge until its echo arrives", async ({
  context,
  page,
}) => {
  await failFirstDurableUpdate(context);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();

  await waitForWaitingChallenge(page);
  await openLobby(page);
  await expect(
    page.locator(".lobby-challenge-row").filter({ hasText: "Alice" }),
  ).toBeVisible();
});

test("a dropped first self echo is repaired by one accepted-send retry", async ({
  context,
  page,
}) => {
  await dropOwnChallengeCreatedEchoes(context, 1);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();

  await waitForWaitingChallenge(page);
  await expect.poll(() => page.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{ payload?: { kind?: string }; info?: string }>;
    return {
      dropped: (
        window as unknown as {
          __splitStackDroppedChallengeEchoes: () => number;
        }
      ).__splitStackDroppedChallengeEchoes(),
      rawCount: updates.filter((update) =>
        update.payload?.kind === "challenge-created" && update.info === undefined
      ).length,
    };
  }), { timeout: 10_000 }).toEqual({ dropped: 1, rawCount: 2 });
});

test("accepted durable sends stop retrying when every self echo is missing", async ({
  context,
  page,
}) => {
  await dropOwnChallengeCreatedEchoes(context, Number.MAX_SAFE_INTEGER);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();

  const outboxState = () => page.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      payload?: { kind?: string; eventId?: string };
      info?: string;
    }>;
    const created = updates.filter((update) =>
      update.payload?.kind === "challenge-created" && update.info === undefined
    );
    const feedbackKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith("split-stack/pending-chat-feedback/v2:")
    );
    const journal = feedbackKey === undefined
      ? []
      : JSON.parse(window.localStorage.getItem(feedbackKey) ?? "[]") as Array<{
        resolved?: boolean;
      }>;
    return {
      rawCount: created.length,
      eventIds: [...new Set(created.map((update) => update.payload?.eventId))],
      journalResolved: journal.map((entry) => entry.resolved),
    };
  });

  await expect.poll(outboxState, { timeout: 10_000 }).toEqual({
    rawCount: 2,
    eventIds: [expect.any(String)],
    journalResolved: [false],
  });
  await page.waitForTimeout(3_500);
  expect(await outboxState()).toEqual({
    rawCount: 2,
    eventIds: [expect.any(String)],
    journalResolved: [false],
  });
});

test("an offline creator remains joinable and the joiner can withdraw", async ({ page }) => {
  await seedOfflineOpenChallenge(page);
  await openApp(page, "Bob");
  await openLobby(page);

  const challenge = page.locator(".lobby-challenge-row").filter({ hasText: "Alice" });
  await expect(challenge.getByText("Creator offline · You can still join")).toBeVisible();
  const join = challenge.getByRole("button", { name: "Join Alice", exact: true });
  await expect(join).toBeEnabled();
  await join.click();

  const withdraw = page.getByRole("button", { name: "Withdraw", exact: true });
  await expect(withdraw).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("button", { name: "Retry connection", exact: true }),
  ).toBeVisible();
  await withdraw.click();

  await openLobby(page);
  const reopened = page.locator(".lobby-challenge-row").filter({ hasText: "Alice" });
  await expect(
    reopened.getByRole("button", { name: "Join Alice", exact: true }),
  ).toBeEnabled({ timeout: 10_000 });
});

test("both players reach ready-up when each first peer runtime claim is lost", async ({
  context,
  page,
}) => {
  test.setTimeout(35_000);
  await dropFirstPeerRuntimeClaimDelivery(context);

  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();
  await waitForWaitingChallenge(page);
  await page.close();

  const seatB = await context.newPage();
  await openApp(seatB, "Bob");
  await openLobby(seatB);
  await seatB.getByRole("button", { name: "Join Alice", exact: true }).click();
  await expect.poll(() => seatB.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly actor?: { readonly id?: string };
      };
    }>;
    return updates.some((update) =>
      update.payload?.kind === "runtime-claimed" &&
      update.payload.actor?.id === "bob@example.test"
    );
  }), { timeout: 10_000 }).toBe(true);

  const reopenedSeatA = await context.newPage();
  await reopenedSeatA.goto("/#name=Alice&addr=alice%40example.test");
  await expect(
    reopenedSeatA.getByRole("main", { name: "Split Stack" }),
  ).toBeVisible();
  await reopenedSeatA.waitForLoadState("networkidle");
  await expect.poll(async () => Promise.all(
    [reopenedSeatA, seatB].map((candidate) =>
      candidate.evaluate(() =>
        (
          window as unknown as {
            __splitStackDroppedPeerRuntimeClaimCount: () => number;
          }
        ).__splitStackDroppedPeerRuntimeClaimCount()
      )
    ),
  ), { timeout: 10_000 }).toEqual([1, 1]);

  await expect(
    reopenedSeatA.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    seatB.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => seatB.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly actor?: { readonly id?: string };
      };
      readonly info?: string;
      readonly href?: string;
      readonly summary?: string;
      readonly notify?: Readonly<Record<string, string>>;
    }>;
    const claims = updates.filter(
      (update) => update.payload?.kind === "runtime-claimed",
    );
    const idsFor = (actorId: string) => [...new Set(claims
      .filter((update) => update.payload?.actor?.id === actorId)
      .map((update) => update.payload?.eventId))];
    return {
      aliceEventIds: idsFor("alice@example.test"),
      bobEventIds: idsFor("bob@example.test"),
      metadataCount: claims.filter((update) =>
        update.info !== undefined ||
        update.href !== undefined ||
        update.summary !== undefined ||
        update.notify !== undefined
      ).length,
    };
  })).toEqual({
    aliceEventIds: [expect.any(String)],
    bobEventIds: [expect.any(String)],
    metadataCount: 0,
  });

  await reopenedSeatA.close();
  await seatB.close();
});

test("Home keeps help opt-in and exposes the complete settings surface", async ({ page }) => {
  await openApp(page);

  await expect(page.getByRole("button", { name: "Practice", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to Play" })).toBeHidden();

  await page.getByRole("button", { name: "How to Play" }).click();
  await expect(page.getByRole("heading", { name: "How to Play" })).toBeVisible();
  await expect(page.getByText(/keep your stack below the top/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meter powers" })).toBeVisible();
  await expect(page.locator('[data-help-group="meter"] [data-power-icon]')).toHaveCount(7);
  await expect(page.getByRole("heading", { name: "Marked-piece powers" })).toBeVisible();
  await expect(
    page.locator('[data-help-group="marked"] .special-guide-card > svg[data-special-icon]'),
  ).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "Special pieces" })).toBeVisible();
  const markedIconStyles = await page
    .locator('[data-help-group="marked"] .special-guide-card > svg[data-special-icon]')
    .first()
    .evaluate((icon) => {
      const style = getComputedStyle(icon);
      return {
        animation: style.animationName,
        color: style.color,
        height: Number.parseFloat(style.height),
        width: Number.parseFloat(style.width),
      };
    });
  expect(markedIconStyles).toMatchObject({
    animation: "none",
    color: "rgb(255, 179, 63)",
  });
  expect(markedIconStyles.height).toBeCloseTo(36.8, 1);
  expect(markedIconStyles.width).toBeCloseTo(36.8, 1);
  await expect(
    page.locator('[data-help-group="pieces"] .special-piece-sample[data-source="monomino"]'),
  ).toBeVisible();
  const glitchCellWidths = await page.evaluate(async () => {
    const piecePreviewUrl = "/src/ui/piece-preview.ts";
    const { renderPiecePreviewSlot } = await import(piecePreviewUrl);
    const sample = document.createElement("div");
    sample.className = "special-piece-sample special-piece-illustration";
    document.body.append(sample);
    const descriptor = {
      source: "glitch" as const,
      shape: "I" as const,
      previewCosmetics: {
        kind: "glitch-cycle" as const,
        shapes: ["I", "J", "L", "O", "S", "T", "Z"] as const,
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    };
    const options = {
      colorPalette: "standard" as const,
      reducedMotion: false,
      reducedFlashes: false,
    };
    const widthAt = (elapsedMs: number): number => {
      renderPiecePreviewSlot(sample, descriptor, { ...options, elapsedMs });
      return sample.querySelector(".piece-preview-cell")!.getBoundingClientRect().width;
    };
    const widths = [widthAt(0), widthAt(450)];
    sample.remove();
    return widths;
  });
  expect(Math.abs(glitchCellWidths[0]! - glitchCellWidths[1]!)).toBeLessThan(1);
  await page.getByRole("button", { name: "Back" }).click();

  await expect(page.getByRole("button", { name: "Power Glossary" })).toHaveCount(0);
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Controls", exact: true })).toBeVisible();
  await expect(page.getByText(/entire gameplay area/i)).toBeVisible();
  await expect(page.locator(".gesture-control-row")).toHaveCount(6);
  await expect(page.locator("[data-control-action]")).toHaveCount(7);
  await expect(page.getByRole("heading", { name: "Keyboard controls" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Move left\/right.*A.*D/i })).toBeVisible();
  await expect(page.getByRole("row", { name: /Hard drop.*Space/i })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Effects", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Effects volume")).toHaveAttribute("type", "range");
  await expect(page.getByLabel("Music", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Music volume")).toHaveAttribute("type", "range");
  await expect(page.getByLabel("Touch controls")).toHaveValue("gestures");
  await expect(page.getByLabel("Graphics")).toHaveValue("auto");
  await expect(page.getByText(/^Auto currently uses (Normal|Low|Very Low)\.$/)).toBeVisible();
  await expect(page.locator(".split-stack-app")).toHaveAttribute(
    "data-graphics-tier",
    /^(normal|low|very-low)$/,
  );
  await expect(page.getByLabel("Gameplay tips")).not.toBeChecked();
  await page.getByRole("button", { name: "Clear diagnostics" }).click();
  await expect(page.getByText("Diagnostics cleared.")).toBeVisible();
  const soundLibraryButton = page.getByRole("button", {
    name: "Sound library",
    includeHidden: true,
  });
  await expect(page.getByLabel("Debug tools")).not.toBeChecked();
  await expect(soundLibraryButton).toBeHidden();
  await page.getByLabel("Debug tools").check();
  await expect(soundLibraryButton).toBeVisible();
  await soundLibraryButton.click();
  await expect(page.getByRole("heading", { name: "Sound library" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Debug tools")).toBeChecked();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Debug tools")).toBeChecked();
  await expect(soundLibraryButton).toBeVisible();
});

test("dense renderer cell art survives palette switches at common sizes", DEVICE_MATRIX, async ({
  page,
}) => {
  await openApp(page);
  const standard = await readDenseCellArtMetrics(page, "standard", "full");
  const colorblind = await readDenseCellArtMetrics(page, "colorblind", "full");
  const expectedKinds = [
    "I", "J", "L", "O", "S", "T", "Z", "cross", "small-cross", "monomino",
    "garbage", "acid",
  ];
  const viewport = page.viewportSize();

  expect(standard.portrait).toBe(
    viewport === null ? standard.portrait : viewport.height > viewport.width,
  );
  expect(colorblind.portrait).toBe(standard.portrait);
  expect(standard.cellSize).toBeGreaterThan(12);
  expect(colorblind.cellSize).toBeCloseTo(standard.cellSize);
  expect(standard.cells.map(({ kind }) => kind)).toEqual(expectedKinds);
  expect(colorblind.cells.map(({ kind }) => kind)).toEqual(expectedKinds);

  for (let index = 0; index < expectedKinds.length; index += 1) {
    const standardCell = standard.cells[index]!;
    const colorblindCell = colorblind.cells[index]!;
    expect(standardCell.contrast).toBeGreaterThan(2);
    expect(colorblindCell.contrast).toBeGreaterThan(2);
    expect(colorblindCell.contrast / standardCell.contrast).toBeGreaterThan(0.45);
    expect(colorblindCell.contrast / standardCell.contrast).toBeLessThan(2.2);
    expect(Math.hypot(
      standardCell.color[0] - colorblindCell.color[0],
      standardCell.color[1] - colorblindCell.color[1],
      standardCell.color[2] - colorblindCell.color[2],
    )).toBeGreaterThan(2);
  }

  for (const metrics of [standard, colorblind]) {
    const garbage = metrics.cells.find(({ kind }) => kind === "garbage")!;
    expect(garbage.contrast).toBeGreaterThan(3);
    expect(metrics.ghost.solidCenterLuminance - metrics.ghost.centerLuminance)
      .toBeGreaterThan(12);
    expect(metrics.ghost.edgeLuminance - metrics.ghost.backgroundLuminance)
      .toBeGreaterThan(0);
    expect(metrics.silhouette.ordinaryCornerFillRatio).toBeGreaterThan(0.2);
    expect(metrics.silhouette.monominoCornerFillRatio).toBeGreaterThan(0.2);
    expect(Math.abs(
      metrics.silhouette.monominoCornerFillRatio -
        metrics.silhouette.ordinaryCornerFillRatio,
    )).toBeLessThan(0.3);
  }
});

test("graphics tiers retain every dense pattern and ghost silhouette", async ({ page }) => {
  await openApp(page);
  const full = await readDenseCellArtMetrics(page, "standard", "full");
  const limited = await readDenseCellArtMetrics(page, "standard", "limited");
  const reduced = await readDenseCellArtMetrics(page, "standard", "reduced");

  expect(limited.cellSize).toBeCloseTo(full.cellSize);
  expect(reduced.cellSize).toBeCloseTo(full.cellSize);
  for (let index = 0; index < full.cells.length; index += 1) {
    const fullContrast = full.cells[index]!.contrast;
    const limitedContrast = limited.cells[index]!.contrast;
    const reducedContrast = reduced.cells[index]!.contrast;
    expect(limitedContrast).toBeGreaterThan(2);
    expect(reducedContrast).toBeGreaterThan(2);
    expect(limitedContrast / fullContrast).toBeGreaterThan(0.5);
    expect(reducedContrast / fullContrast).toBeGreaterThan(0.45);
  }
  for (const metrics of [full, limited, reduced]) {
    expect(metrics.ghost.solidCenterLuminance - metrics.ghost.centerLuminance)
      .toBeGreaterThan(12);
    expect(metrics.ghost.edgeLuminance - metrics.ghost.backgroundLuminance)
      .toBeGreaterThan(0);
    expect(metrics.silhouette.ordinaryCornerFillRatio).toBeGreaterThan(0.2);
    expect(metrics.silhouette.monominoCornerFillRatio).toBeGreaterThan(0.2);
    expect(Math.abs(
      metrics.silhouette.monominoCornerFillRatio -
        metrics.silhouette.ordinaryCornerFillRatio,
    )).toBeLessThan(0.3);
  }
});

test("gameplay marked cells render the synchronized P4 field", DEVICE_MATRIX, async ({
  page,
}) => {
  await openApp(page);
  const {
    neighborRimTroughLift,
    neighborRimPeakLift,
    neighborSurfaceTroughLift,
    neighborSurfacePeakLift,
    sourceTroughLift,
    sourcePeakLift,
    markedBaseAccentChromaDistance,
    markedBaseOrdinaryChromaDistance,
    markedSurfacePatternVariationRatio,
    markedSurfaceShadingRange,
    markedBevelContrast,
    markedCentralDarkCoverageAtTrough,
    markedCentralDarkCoverageAtPeak,
    glyphIvoryFootprintRatioAtTrough,
    glyphIvoryFootprintRatioAtPeak,
    glyphIvoryRetentionRatio,
    glyphIvoryMinimumColorDistanceAtTrough,
    glyphIvoryMinimumColorDistanceAtPeak,
    glyphStaticColorDelta,
    glyphUnderstrokeCoverageAtTrough,
    glyphUnderstrokeCoverageAtPeak,
    glyphUnderstrokeFaceDropAtTrough,
    glyphUnderstrokeFaceDropAtPeak,
    glyphContrastAtTrough,
    glyphContrastAtPeak,
    sourceFacePeakClippedCoverage,
    minimumNeighborPatternContrastRatioAtTrough,
    minimumNeighborPatternContrastRatioAtPeak,
    minimumLightChannelDelta,
    outsideBoardLightDelta,
    overlapTargetRimDelta,
    crossDirectionSurfaceLift,
    gameplayCueLift,
    activationOutsideBoardLightDelta,
    activationBoundaryDelta,
  } = await readMarkedCellRenderMetrics(page);

  expect(neighborRimTroughLift).toHaveLength(8);
  expect(neighborRimPeakLift).toHaveLength(8);
  expect(neighborSurfaceTroughLift).toHaveLength(8);
  expect(neighborSurfacePeakLift).toHaveLength(8);
  for (let index = 0; index < 8; index += 1) {
    expect(neighborRimTroughLift[index]).toBeGreaterThan(0);
    expect(
      neighborRimPeakLift[index]! - neighborRimTroughLift[index]!,
    ).toBeGreaterThan(2);
    expect(neighborSurfaceTroughLift[index]).toBeGreaterThanOrEqual(0);
    expect(
      neighborSurfacePeakLift[index]! - neighborSurfaceTroughLift[index]!,
    ).toBeGreaterThan(1);
  }
  expect(sourcePeakLift - sourceTroughLift).toBeGreaterThan(5);
  expect(markedBaseAccentChromaDistance).toBeLessThan(
    markedBaseOrdinaryChromaDistance,
  );
  expect(markedBaseAccentChromaDistance).toBeLessThan(0.1);
  // Marked cells remove their piece pattern but retain the cell surface's
  // directional shading and rounded bevel instead of becoming a flat tile.
  expect(markedSurfacePatternVariationRatio).toBeLessThan(0.75);
  expect(markedSurfaceShadingRange).toBeGreaterThan(3);
  expect(markedBevelContrast).toBeGreaterThan(1);
  // A socket or badge would occupy most of the central face with a near-black
  // field; the narrow antialiased glyph understroke must not form one.
  expect(markedCentralDarkCoverageAtTrough).toBeLessThan(0.3);
  expect(markedCentralDarkCoverageAtPeak).toBeLessThan(0.3);
  // The glyph uses a static 56% carrier. Individual paths occupy less than the
  // carrier, stay ivory, and never bloom beyond it.
  for (const footprint of [
    glyphIvoryFootprintRatioAtTrough,
    glyphIvoryFootprintRatioAtPeak,
  ]) {
    expect(footprint).toBeGreaterThan(0.3);
    expect(footprint).toBeLessThanOrEqual(0.57);
  }
  // At portrait cell sizes antialiased edges cross the ivory classifier in
  // whole-pixel steps even though the carrier and texture stay static.
  expect(Math.abs(
    glyphIvoryFootprintRatioAtPeak - glyphIvoryFootprintRatioAtTrough,
  )).toBeLessThan(0.2);
  expect(glyphIvoryRetentionRatio).toBeGreaterThan(0.85);
  expect(glyphIvoryMinimumColorDistanceAtTrough).toBeLessThan(36);
  expect(glyphIvoryMinimumColorDistanceAtPeak).toBeLessThan(36);
  expect(glyphStaticColorDelta).toBeLessThan(2);
  expect(glyphUnderstrokeCoverageAtTrough).toBeGreaterThan(0.04);
  expect(glyphUnderstrokeCoverageAtPeak).toBeGreaterThan(0.04);
  expect(glyphUnderstrokeCoverageAtTrough).toBeLessThan(3);
  expect(glyphUnderstrokeCoverageAtPeak).toBeLessThan(3);
  expect(glyphUnderstrokeFaceDropAtTrough).toBeGreaterThan(3);
  expect(glyphUnderstrokeFaceDropAtPeak).toBeGreaterThan(3);
  expect(glyphContrastAtTrough).toBeGreaterThan(65);
  expect(glyphContrastAtPeak).toBeGreaterThan(65);
  expect(sourceFacePeakClippedCoverage).toBeLessThan(0.02);
  expect(minimumNeighborPatternContrastRatioAtTrough).toBeGreaterThan(0.65);
  expect(minimumNeighborPatternContrastRatioAtPeak).toBeGreaterThan(0.65);
  expect(minimumLightChannelDelta).toBeGreaterThanOrEqual(-1);
  expect(outsideBoardLightDelta.left).toBeLessThan(1);
  expect(outsideBoardLightDelta.right).toBeLessThan(1);
  expect(outsideBoardLightDelta.top).toBeLessThan(1);
  expect(outsideBoardLightDelta.bottom).toBeLessThan(1);
  expect(overlapTargetRimDelta).toBeLessThan(1);
  // A second source-facing direction must not alter the first direction's rim,
  // while the two clipped inward washes may overlap on the target surface.
  expect(crossDirectionSurfaceLift).toBeGreaterThan(2);
  expect(crossDirectionSurfaceLift).toBeLessThan(15);
  expect(gameplayCueLift).toBeGreaterThan(20);
  expect(activationOutsideBoardLightDelta).toBeLessThan(1);
  expect(activationBoundaryDelta).toBeLessThan(0.001);
});

test("Auto Very Low keeps the cheap marked-source pulse while explicit accessibility is static", async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(async () => {
    const rendererUrl = "/src/render/renderer.ts";
    const graphicsPolicyUrl = "/src/app/graphics-policy.ts";
    const [{ ThreeRenderer }, { GraphicsAutoController }] = await Promise.all([
      import(rendererUrl),
      import(graphicsPolicyUrl),
    ]);
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:400px;height:800px;z-index:9999";
    document.body.append(canvas);
    const frame = {
      mode: "practice" as const,
      left: {
        playerId: "adaptive-marked",
        cells: [{
          column: 4,
          row: 12,
          kind: "J" as const,
          role: "settled" as const,
          special: "blackout" as const,
        }],
        focused: true,
        concealed: false,
      },
      right: null,
    };
    const sampleSourceFace = (renderer: InstanceType<typeof ThreeRenderer>): number => {
      const gl = canvas.getContext("webgl2");
      if (gl === null) throw new Error("WebGL2 unavailable in browser test");
      gl.finish();
      const viewport = renderer.layout.left;
      const x = Math.round(
        (viewport.boardX + (4 + 0.5 + 0.27) * viewport.cellSize) *
          gl.drawingBufferWidth / canvas.clientWidth,
      );
      const y = Math.round(
        (canvas.clientHeight -
          (viewport.boardY + (12 - 2 + 0.5 + 0.27) * viewport.cellSize)) *
          gl.drawingBufferHeight / canvas.clientHeight,
      );
      const pixel = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[0]! * 0.2126 + pixel[1]! * 0.7152 + pixel[2]! * 0.0722;
    };
    const auto = new GraphicsAutoController();
    for (let timestamp = 0; timestamp <= 384; timestamp += 16) auto.observeFrame(timestamp);
    auto.observeFrame(700);
    auto.observeFrame(3_000);
    const adaptive = new ThreeRenderer(canvas, { initialQuality: "full" });
    adaptive.setQuality(auto.tier === "very-low" ? "reduced" : "full");
    const adaptiveQuality = adaptive.quality.effects;
    adaptive.render(frame, 5_600);
    const adaptiveTrough = sampleSourceFace(adaptive);
    adaptive.render(frame, 7_000);
    const adaptivePeak = sampleSourceFace(adaptive);
    adaptive.dispose();

    const explicitStatic = new ThreeRenderer(canvas, { initialQuality: "reduced" });
    explicitStatic.setStaticMarkedCells(true);
    explicitStatic.render(frame, 5_600);
    const staticTrough = sampleSourceFace(explicitStatic);
    explicitStatic.render(frame, 7_000);
    const staticPeak = sampleSourceFace(explicitStatic);
    explicitStatic.dispose();
    canvas.remove();
    return {
      adaptiveQuality,
      adaptiveDelta: adaptivePeak - adaptiveTrough,
      staticDelta: Math.abs(staticPeak - staticTrough),
    };
  });

  expect(result.adaptiveQuality).toBe("reduced");
  expect(result.adaptiveDelta).toBeGreaterThan(2);
  expect(result.staticDelta).toBeLessThan(0.001);
});

test("simultaneous marked-cell pulses are independent of render order", async ({ page }) => {
  await openApp(page);

  expect(await readMarkedCellOrderDifference(page)).toBeLessThan(0.0001);
});

test("renderer uploads only the live cell-pool matrix prefix", async ({ page }) => {
  await openApp(page);

  expect(await readCellPoolUploadMetrics(page)).toEqual({
    arrayBufferUploads: [{
      destinationByteOffset: 0,
      sourceByteLength: 512 * 16 * Float32Array.BYTES_PER_ELEMENT,
      sourceElementOffset: 0,
      sourceElementCount: 4 * 16,
      uploadedByteLength: 4 * 16 * Float32Array.BYTES_PER_ELEMENT,
    }],
  });
});

test("Practice accepts keyboard and compact touch-button actions", async ({ page }) => {
  await openApp(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Touch controls").selectOption("buttons");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  const board = page.getByRole("application", { name: "Your board" });
  const hold = page.locator('[data-side="left"] .hold-preview .piece-preview-slot');
  const holdButton = page.getByRole("button", { name: "Hold piece" });
  const previewShapes = () =>
    page
      .locator('[data-side="left"] .next-preview .piece-preview-slot')
      .evaluateAll((slots) =>
        slots.map((slot) => (slot as HTMLElement).dataset.displayShape ?? "empty"),
      );
  const expectOnePreviewAdvance = async (before: readonly string[]) => {
    expect(before).toHaveLength(5);
    await expect.poll(async () => (await previewShapes()).slice(0, 4)).toEqual(
      before.slice(1),
    );
  };
  await expect(board).toBeVisible();
  const matchMenuButton = page.getByRole("button", { name: "Match menu" });
  await expect(matchMenuButton).toBeVisible();

  await matchMenuButton.click();
  await expect(page.getByRole("dialog", { name: "Match menu" })).toBeVisible();
  await expect(page.getByText(/Practice is paused/i)).toBeVisible();
  const pausedBaseline = await numericText(localScore(page));
  await page.getByRole("dialog", { name: "Match menu" }).evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press("Space");
  await expect.poll(() => numericText(localScore(page))).toBe(pausedBaseline);
  await page.getByRole("button", { name: "Resume", exact: true }).click();

  const focusedControlBaseline = await numericText(localScore(page));
  await holdButton.press("Space");
  await expect(hold.locator(".piece-preview-grid")).toBeVisible();
  await expect.poll(() => numericText(localScore(page))).toBe(focusedControlBaseline);

  await holdButton.evaluate((button) => (button as HTMLElement).blur());
  const keyboardBaseline = await numericText(localScore(page));
  await page.keyboard.press("Space");
  await expectScoreAbove(localScore(page), keyboardBaseline);

  await holdButton.click();
  const touchBaseline = await numericText(localScore(page));
  const beforePointerDrop = await previewShapes();
  await page.getByRole("button", { name: "Hard drop" }).click();
  await expectScoreAbove(localScore(page), touchBaseline);
  await expectOnePreviewAdvance(beforePointerDrop);

  const keyboardButtonBaseline = await numericText(localScore(page));
  const beforeKeyboardDrop = await previewShapes();
  await page.getByRole("button", { name: "Hard drop" }).press("Enter");
  await expectScoreAbove(localScore(page), keyboardButtonBaseline);
  await expectOnePreviewAdvance(beforeKeyboardDrop);
});

test("wide Practice gameplay frame reserves its header, footer, and external rail", async ({
  page,
}) => {
  const viewport = { width: 1_280, height: 720 };
  await page.setViewportSize(viewport);
  await openApp(page);
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  const hud = page.locator('[data-side="left"] .player-hud');
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
  await expectPracticeFrameGeometry(page, viewport);

  await expect(hud.locator(".hud-stat-label-full", { hasText: "Score" })).toBeVisible();
  await expect(hud.locator(".hud-stat-label-full", { hasText: "Level" })).toBeVisible();
  await expect(hud.locator(".hud-stat-label-full", { hasText: "Lines" })).toBeVisible();
  await expect(hud.locator(".power-meter-segment")).toHaveCount(7);
  await expect(hud.locator(".power-meter-segment").first()).toHaveCSS(
    "background-color",
    "rgba(29, 43, 59, 0.96)",
  );
  await expect(hud.locator(".hold-preview")).toHaveCSS("border-top-style", "none");
  await expect(hud.locator(".incoming-garbage svg")).toHaveCSS(
    "color",
    "rgb(127, 137, 154)",
  );
});

test("constrained Practice keeps its menu clear of the scaled previews", async ({
  page,
}) => {
  const viewport = { width: 320, height: 520 };
  await page.setViewportSize(viewport);
  await openApp(page);
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  await expectPracticeFrameGeometry(page, viewport);
  await expect(page.locator('[data-side="left"] .player-name')).toBeHidden();
  await expect(page.locator('[data-side="left"] .hud-stat-label-short').first())
    .toBeVisible();
});

test("wide PvP gameplay frame stays packed in a fixed 54px center corridor", async ({
  context,
  page,
}) => {
  const viewport = { width: 1_280, height: 720 };
  await page.setViewportSize(viewport);
  const { seatA, seatB } = await openVersusPair(context, page);

  await expectVersusFrameGeometry(seatA, viewport);

  const dividerVisible = await seatA.locator(".arena").evaluate((arena) => {
    const style = getComputedStyle(arena, "::after");
    const content = style.content.trim().toLowerCase();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0 &&
      Number.parseFloat(style.width || "0") > 0 &&
      content !== "none" &&
      content !== "normal"
    );
  });
  expect(dividerVisible, "the centered frame has no decorative divider").toBe(false);

  await seatB.close();
});

test("the centered Ready panel shows both players and supports a clear undo", async ({
  context,
  page,
}) => {
  const { seatA, seatB } = await openVersusPair(context, page);
  const panel = seatA.locator(".ready-panel");
  const localStatus = panel.locator('[data-player="local"]');
  const opponentStatus = panel.locator('[data-player="opponent"]');

  await expect(panel).toBeVisible();
  await expect(localStatus).toContainText("Not ready");
  await expect(opponentStatus).toContainText("Not ready");

  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.getByRole("button", { name: /You’re ready/ })).toBeDisabled();
  await expect(seatA.getByRole("button", { name: "Cancel readiness" })).toBeVisible();
  await expect(localStatus).toContainText("Ready");
  await expect(seatB.locator('[data-player="opponent"]')).toContainText("Ready");

  await seatA.getByRole("button", { name: "Cancel readiness" }).click();
  await expect(seatA.getByRole("button", { name: "Ready up", exact: true })).toBeEnabled();
  await expect(localStatus).toContainText("Not ready");

  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await expect(panel).toBeHidden();
  await seatB.close();
});

test("gesture controls accept a hard-drop flick over the opponent board", async ({
  context,
  page,
}) => {
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });

  await expect(seatA.locator(".split-stack-app")).toHaveCSS("touch-action", "none");

  const opponentBoard = seatA.getByRole("application", { name: "Opponent board" });
  const bounds = await opponentBoard.boundingBox();
  expect(bounds).not.toBeNull();
  const x = Math.floor(bounds!.x + bounds!.width / 2);
  const startY = Math.floor(bounds!.y + bounds!.height * 0.25);
  const baseline = await numericText(localScore(seatA));

  await seatA.mouse.move(x, startY);
  await seatA.mouse.down();
  await seatA.mouse.move(x, startY + Math.max(90, bounds!.height * 0.3), { steps: 2 });
  await seatA.mouse.up();

  await expectScoreAbove(localScore(seatA), baseline);
  await seatB.close();
});

test("replaces a silent competitive channel without registering a second listener", DEVICE_MATRIX, async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installControllableMonotonicClock(context);
  await enforceSingleRealtimeListener(context);

  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await expect(seatB.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await advancePairMonotonic(seatA, seatB, 4_000, 250);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await expect(seatB.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });

  // Keep setup realistic, then make the short-lived outage states deterministic.
  await Promise.all([freezeMonotonic(seatA), freezeMonotonic(seatB)]);
  const seatBSendsBeforeKeepalive = await realtimeSendCount(seatB);
  await advanceMonotonic(seatB, RULES.network.keepaliveMs + 1);
  await expect.poll(() => realtimeSendCount(seatB), { timeout: 5_000 }).toBeGreaterThan(
    seatBSendsBeforeKeepalive,
  );
  await setRealtimeSendBlocked(seatB, true);
  const recoveryOverlay = seatA.locator(".center-overlay");
  const localPane = seatA.locator('.player-pane[data-side="left"]');
  const warning = seatA.getByText("Connection unstable…", { exact: true });
  await advanceMonotonicUntilVisible(
    seatA,
    warning,
    RULES.network.missingPeerMs,
  );
  await expect(warning).toBeVisible();
  await expect(recoveryOverlay).toHaveAttribute("data-presentation", "banner");
  await expect(localPane).toHaveAttribute("aria-disabled", "false");
  await expectRecoveryStatusCentered(seatA);

  const reconnecting = seatA.getByText(
    /Reconnecting\.{1,3}\s*Match ends in \d+s if your opponent does not return\./,
  );
  await advanceMonotonicUntilVisible(
    seatA,
    reconnecting,
    RULES.network.missingPeerMs,
  );
  await expect(reconnecting).toBeVisible();
  await expect(recoveryOverlay).toHaveAttribute("data-presentation", "status");
  await expect(localPane).toHaveAttribute("aria-disabled", "true");
  await expectRecoveryStatusCentered(seatA);

  await advanceMonotonic(seatA, RULES.network.reconnectingMs);
  await seatA.waitForTimeout(60);

  await expect
    .poll(
      () =>
        seatA.evaluate(
          () =>
            (
              window as unknown as {
                __splitStackRealtimeLifecycle: { joins: number };
              }
            ).__splitStackRealtimeLifecycle.joins,
        ),
      { timeout: 5_000 },
    )
    .toBe(2);
  expect(
    await seatA.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: {
              joins: number;
              leaves: number;
              listeners: number;
              active: number;
              maxActive: number;
            };
          }
        ).__splitStackRealtimeLifecycle,
    ),
  ).toEqual({ joins: 2, leaves: 1, listeners: 2, active: 1, maxActive: 1 });
  expect(pageErrors).toEqual([]);
  const diagnosticEvents = await seatA.evaluate((storageKey) => {
    const serialized = window.localStorage.getItem(storageKey);
    if (serialized === null) return [];
    const snapshot = JSON.parse(serialized) as {
      incidents: Array<{
        events: Array<{ kind: string; telemetry?: unknown }>;
      }>;
    };
    const latest = snapshot.incidents[snapshot.incidents.length - 1];
    return latest?.events ?? [];
  }, NETWORK_DIAGNOSTICS_STORAGE_KEY);
  expect(diagnosticEvents.map((event) => event.kind)).toEqual(
    expect.arrayContaining([
      "connection-unstable",
      "channel-replacement-requested",
      "channel-detached",
      "channel-attached",
    ]),
  );
  expect(
    diagnosticEvents
      .filter((event) => event.telemetry !== undefined)
      .map((event) => event.kind),
  ).toEqual([
    "connection-unstable",
    "channel-replacement-requested",
    "channel-detached",
  ]);
  await seatB.close();
});

test("keeps a healthy realtime channel across a visibility restore", DEVICE_MATRIX, async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  await installControllableMonotonicClock(context);
  await enforceSingleRealtimeListener(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await expect(seatB.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await expect(seatB.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await expect(seatA.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await expect(seatB.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "false",
  );

  await setVisibilityState(seatA, "hidden");
  await setVisibilityState(seatA, "visible");
  await expect(seatA.getByText("Resynchronizing…", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  await expect(seatA.locator(".center-overlay")).toHaveAttribute(
    "data-presentation",
    "status",
  );
  await expect(seatA.locator(".center-overlay")).not.toContainText(/\d/);
  await expectRecoveryStatusCentered(seatA);

  const recoveryLeadMs =
    (RULES.network.rollbackResumeCountdownTicks * 1_000) /
    RULES.timing.ticksPerSecond;
  await advancePairMonotonic(
    seatA,
    seatB,
    RULES.network.recoveryStabilityMs + recoveryLeadMs + 500,
  );
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await expect(seatB.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await expect(seatA.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await expect(seatB.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "false",
  );

  // Stay well past the replacement threshold while regular keepalives and
  // snapshots continue. A healthy handle must remain the sole subscription.
  await advancePairMonotonic(
    seatA,
    seatB,
    RULES.network.reconnectingMs + 500,
    500,
  );
  await expect(seatA.locator(".center-overlay")).toBeHidden();
  await expect(seatB.locator(".center-overlay")).toBeHidden();

  const [seatALifecycle, seatBLifecycle] = await Promise.all([
    seatA.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: {
              joins: number;
              leaves: number;
              listeners: number;
              active: number;
              maxActive: number;
            };
          }
        ).__splitStackRealtimeLifecycle,
    ),
    seatB.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: {
              joins: number;
              leaves: number;
              listeners: number;
              active: number;
              maxActive: number;
            };
          }
        ).__splitStackRealtimeLifecycle,
    ),
  ]);
  expect(seatALifecycle).toEqual({
    joins: 1,
    leaves: 0,
    listeners: 1,
    active: 1,
    maxActive: 1,
  });
  expect(seatBLifecycle).toEqual({
    joins: 1,
    leaves: 0,
    listeners: 1,
    active: 1,
    maxActive: 1,
  });
  await seatB.close();
});

test("keeps competitive recovery paused when WebGL restores in a hidden document", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  await installControllableMonotonicClock(context);
  await enforceSingleRealtimeListener(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.getByText(/match starts in/i)).toBeVisible({ timeout: 10_000 });
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });

  await freezeMonotonic(seatA);
  await setVisibilityState(seatA, "hidden");
  const pausedMessage = seatA.getByText(
    "Connection interrupted — game paused…",
    { exact: true },
  );
  await expect(pausedMessage).toBeVisible({ timeout: 5_000 });
  await seatA.waitForTimeout(100);
  const [sendsBeforeContextRestore, sendsAfterContextRestore] = await seatA
    .locator("canvas.game-canvas")
    .evaluate((canvas) => {
      const sendCount = (
        window as unknown as {
          __splitStackRealtimeSendCount: () => number;
        }
      ).__splitStackRealtimeSendCount;
      const before = sendCount();
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      return [before, sendCount()] as const;
    });

  expect(sendsAfterContextRestore).toBe(sendsBeforeContextRestore);
  await expect(pausedMessage).toBeVisible();
  await expect(seatA.getByText("Resynchronizing…", { exact: true })).toBeHidden();

  const sendsBeforeVisibilityRestore = await realtimeSendCount(seatA);
  await setVisibilityState(seatA, "visible");
  await expect.poll(() => realtimeSendCount(seatA)).toBeGreaterThan(
    sendsBeforeVisibilityRestore,
  );
  await expect(seatA.getByText("Resynchronizing…", { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  await seatB.close();
});

for (const viewport of [
  { width: 360, height: 640 },
  { width: 640, height: 360 },
] as const) {
  test(`PvP gameplay frame stays equal and non-overlapping at ${viewport.width}x${viewport.height}`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { seatA, seatB } = await openVersusPair(context, page);

    await expectVersusFrameGeometry(seatA, viewport);
    for (const side of ["left", "right"] as const) {
      const hud = seatA.locator(`.player-pane[data-side="${side}"]`);
      await expect(hud.locator(".player-name")).toBeHidden();
      await expect(hud.locator(".hud-stat-label-short")).toHaveCount(3);
      await expect(hud.locator(".hud-stat-label-short").first()).toBeVisible();
      await expect(hud.locator(".hud-stat-label-full").first()).toBeHidden();
    }

    await seatB.close();
  });
}

test("landscape PvP gameplay frame stays above the touch-button tray", async ({
  context,
  page,
}) => {
  const viewport = { width: 640, height: 360 };
  await page.setViewportSize(viewport);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Touch controls").selectOption("buttons");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Create challenge" }).click();
  const seatA = page;
  const seatB = await context.newPage();
  await openApp(seatB, "Bob");
  await openLobby(seatB);
  await seatB.getByRole("button", { name: "Join Alice", exact: true }).click();
  await expect(seatA.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });

  const tray = seatA.locator(".touch-buttons");
  await expect(tray).toBeVisible();
  await expect(seatA.locator(".split-stack-app"))
    .toHaveAttribute("data-touch-buttons-visible", "true");
  const trayRect = await elementRect(tray);
  await expectVersusFrameGeometry(seatA, viewport, trayRect.y);

  await seatB.close();
});

test("landscape Practice gameplay frame and footer stay above the touch-button tray", async ({
  page,
}) => {
  const viewport = { width: 640, height: 360 };
  await page.setViewportSize(viewport);
  await openApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Touch controls").selectOption("buttons");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  const tray = page.locator(".touch-buttons");
  await expect(tray).toBeVisible();
  const trayRect = await elementRect(tray);
  await expectPracticeFrameGeometry(page, viewport, trayRect.y);

  const footer = await elementRect(
    page.locator('.player-pane[data-side="left"] .status-row'),
  );
  expect(
    trayRect.y - rectBottom(footer),
    "the complete gameplay frame clears the touch-button tray",
  ).toBeGreaterThanOrEqual(3.5);
});

test("a third participant explicitly watches an active match as a read-only spectator", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  const matchId = await waitForEffectiveMatchStarted(
    seatA,
    "alice@example.test",
  );

  const spectator = await context.newPage();
  await forceWebxdcIdentityOnRoute(spectator, "Charlie");
  await spectator.goto(`/?deeplink=live#match/${encodeURIComponent(matchId)}`);
  await expect(spectator.getByRole("application", { name: "Seat A board" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(spectator.getByRole("application", { name: "Seat B board" })).toBeVisible();
  await expect(spectator.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect.poll(() => spectator.evaluate(() => window.location.hash)).toBe("");

  await spectator.reload();
  await expect(spectator.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await expect(spectator.getByRole("button", { name: "Create challenge" })).toBeVisible();
  await expect(spectator.getByRole("application", { name: "Seat A board" })).toBeHidden();
  const playerScoreBefore = await numericText(localScore(seatA));
  await seatA.keyboard.press("Space");
  await expectScoreAbove(localScore(seatA), playerScoreBefore);

  await spectator.close();
  await seatB.close();
});

test("an owned orphan recovery continues while its participant watches another live route", async ({
  context,
  page,
}) => {
  test.setTimeout(70_000);
  await installControllableMonotonicClock(context);
  const own = await openVersusPair(context, page);
  const unrelated = await openNamedVersusPair(context, "Charlie", "Dave");

  for (const participant of [own.seatA, own.seatB, unrelated.seatA, unrelated.seatB]) {
    await participant.getByRole("button", { name: "Ready up", exact: true }).click();
  }
  await advancePairMonotonic(own.seatA, own.seatB, 4_000, 500);
  await advancePairMonotonic(unrelated.seatA, unrelated.seatB, 4_000, 500);
  await expect(own.seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await expect(unrelated.seatA.locator(".center-overlay")).toBeHidden({
    timeout: 5_000,
  });

  const [ownedMatchId, unrelatedMatchId] = await Promise.all([
    waitForEffectiveMatchStarted(unrelated.seatA, "alice@example.test"),
    waitForEffectiveMatchStarted(unrelated.seatA, "charlie@example.test"),
  ]);

  await Promise.all([own.seatA.close(), own.seatB.close()]);
  const recreated = await context.newPage();
  await forceWebxdcIdentityOnRoute(recreated, "Alice");
  await recreated.goto(
    `/?reopened=watch#match/${encodeURIComponent(unrelatedMatchId)}`,
  );
  await expect(
    recreated.getByRole("application", { name: "Seat A board" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    recreated.getByRole("application", { name: "Seat B board" }),
  ).toBeVisible();
  await expect(recreated.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect.poll(() => recreated.evaluate(() => window.location.hash)).toBe("");

  const connectionLossEventIds = () => recreated.evaluate((ownedMatchId) => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly matchId?: string;
        readonly result?: { readonly reason?: string };
      };
    }>;
    return [...new Set(updates.flatMap((update) =>
      update.payload?.kind === "match-finished" &&
        update.payload.matchId === ownedMatchId &&
        update.payload.result?.reason === "connection-lost" &&
        update.payload.eventId !== undefined
        ? [update.payload.eventId]
        : []
    ))];
  }, ownedMatchId);
  await advanceMonotonic(recreated, RULES.network.reconnectGraceMs + 1_000);
  await recreated.waitForTimeout(1_000);
  expect(await connectionLossEventIds()).toEqual([]);
  await expect(
    recreated.getByRole("application", { name: "Seat A board" }),
  ).toBeVisible();
  await expect(recreated.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await leaveThroughMatchMenu(recreated);
  await expect(
    recreated.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible();
  const endInterruptedMatch = recreated.getByRole("button", {
    name: "End match with no result",
    exact: true,
  });
  await expect(endInterruptedMatch).toBeVisible();
  await endInterruptedMatch.click();
  const confirmation = recreated.getByRole("dialog", {
    name: "End match with no result?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", {
    name: "End match with no result",
    exact: true,
  }).click();
  await expect.poll(connectionLossEventIds, { timeout: 10_000 }).toEqual([
    expect.any(String),
  ]);

  const unrelatedScore = await numericText(localScore(unrelated.seatA));
  await unrelated.seatA.keyboard.press("Space");
  await expectScoreAbove(localScore(unrelated.seatA), unrelatedScore);

  await recreated.close();
  await unrelated.seatA.close();
  await unrelated.seatB.close();
});

test("an owned starting pairing consumes and outranks an unrelated live route", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await installControllableMonotonicClock(context);
  const own = await openVersusPair(context, page);
  const unrelated = await openNamedVersusPair(context, "Charlie", "Dave");
  await unrelated.seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await unrelated.seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await advancePairMonotonic(unrelated.seatA, unrelated.seatB, 4_000, 500);
  await expect(unrelated.seatA.locator(".center-overlay")).toBeHidden({
    timeout: 5_000,
  });

  const matchId = await waitForEffectiveMatchStarted(
    unrelated.seatA,
    "charlie@example.test",
  );

  await own.seatA.close();
  const recreated = await context.newPage();
  await forceWebxdcIdentityOnRoute(recreated, "Alice");
  await recreated.goto(`/?reopened=starting#match/${encodeURIComponent(matchId)}`);
  await expect(
    recreated.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    recreated.getByRole("application", { name: "Your board" }),
  ).toBeVisible();
  await expect(
    recreated.getByRole("application", { name: "Seat A board" }),
  ).toBeHidden();
  await expect(
    recreated.getByText("You are watching this challenge as a spectator.", {
      exact: true,
    }),
  ).toBeHidden();
  await expect.poll(() => recreated.evaluate(() => window.location.hash)).toBe("");

  await recreated.close();
  await own.seatB.close();
  await unrelated.seatA.close();
  await unrelated.seatB.close();
});

test("a live reload stays on navigable Home without resetting the committed match", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  const scoreBeforeReload = await numericText(localScore(seatA));
  await seatA.keyboard.press("Space");
  await expectScoreAbove(localScore(seatA), scoreBeforeReload);
  const progressedScore = await numericText(localScore(seatA));

  await seatB.reload();
  await expect(seatB.getByRole("heading", {
    name: "Split Stack",
    exact: true,
  })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatB.getByText("Unfinished match", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    seatB.getByText("This copy can watch but cannot resume playing.", { exact: true }),
  ).toBeVisible();
  for (const boardName of [
    "Your board",
    "Opponent board",
    "Seat A board",
    "Seat B board",
  ]) {
    await expect(
      seatB.getByRole("application", { name: boardName }),
    ).toBeHidden();
  }
  await expect(seatB.getByText(/bound to another game session/i)).toBeHidden();
  await expect(
    seatB.getByRole("button", { name: /^Lobby(?: ·|$)/ }),
  ).toBeEnabled();
  await expect(
    seatA.getByText(
      /Reconnecting\.{1,3}\s*Match ends in \d+s if your opponent does not return\./,
    ),
  ).toBeVisible({ timeout: 15_000 });
  expect(await numericText(localScore(seatA))).toBeGreaterThanOrEqual(progressedScore);
  await seatB.close();
});

test("a surviving controller releases a reloaded opponent after its reconnect grace", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await installControllableMonotonicClock(context);
  await enforceSingleRealtimeListener(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });

  const matchId = await waitForEffectiveMatchStarted(
    seatA,
    "alice@example.test",
  );

  await seatB.reload();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(seatB.getByText("Unfinished match", { exact: true })).toBeVisible();
  await expect(
    seatB.getByRole("button", { name: "Create challenge", exact: true }),
  ).toBeDisabled();

  const connectionLost = seatA.getByRole("heading", {
    name: "Connection lost",
    exact: true,
  });
  await advanceMonotonicUntilVisible(
    seatA,
    connectionLost,
    RULES.network.controllerReconnectGraceMs + 1_000,
    250,
  );
  await expect(connectionLost).toBeVisible({ timeout: 5_000 });

  const neutralRecovery = () => seatB.evaluate((ownedMatchId) => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly matchId?: string;
        readonly result?: {
          readonly outcome?: string;
          readonly reason?: string;
        };
      };
      readonly info?: string;
      readonly href?: string;
      readonly summary?: string;
      readonly notify?: Record<string, string>;
    }>;
    const terminalUpdates = updates.filter((update) =>
      update.payload?.kind === "match-finished" &&
      update.payload.matchId === ownedMatchId &&
      update.payload.result?.reason === "connection-lost"
    );
    const terminals = [...new Map(terminalUpdates.flatMap((update) =>
      update.payload?.eventId === undefined
        ? []
        : [[update.payload.eventId, {
            eventId: update.payload.eventId,
            outcome: update.payload.result?.outcome,
            reason: update.payload.result?.reason,
          }] as const]
    )).values()];
    return {
      terminals,
      summaries: [...new Set(terminalUpdates.flatMap((update) =>
        update.summary === undefined ? [] : [update.summary]
      ))],
      infos: terminalUpdates.flatMap((update) =>
        update.info === undefined ? [] : [update.info]
      ),
      hrefs: terminalUpdates.flatMap((update) =>
        update.href === undefined ? [] : [update.href]
      ),
      notifications: terminalUpdates.flatMap((update) =>
        update.notify === undefined ? [] : [update.notify]
      ),
    };
  }, matchId);
  await expect.poll(neutralRecovery, { timeout: 10_000 }).toEqual({
    terminals: [{
      eventId: expect.any(String),
      outcome: "desync",
      reason: "connection-lost",
    }],
    summaries: ["0 wait · 0 live"],
    infos: [],
    hrefs: [],
    notifications: [],
  });

  await seatA.getByRole("button", { name: "Home", exact: true }).click();
  for (const participant of [seatA, seatB]) {
    await expect(
      participant.getByRole("button", { name: "Create challenge", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
    await openLobby(participant);
    await expect(participant.locator(".lobby-summary")).toContainText("0 live");
    const recentResult = participant.locator(".lobby-result-row");
    await expect(recentResult).toHaveCount(1);
    await expect(recentResult).toContainText(/Connection lost · neutral result/i);
  }

  await seatB.close();
});

test("a recreated participant can explicitly watch its own live match read only", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  await seatB.reload();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(seatB.getByText("Unfinished match", { exact: true })).toBeVisible();
  await expect(
    seatB.getByText("This copy can watch but cannot resume playing.", { exact: true }),
  ).toBeVisible();
  await expect(
    seatB.getByText("The original match is still active.", { exact: true }),
  ).toBeVisible();
  await expect(
    seatB.getByRole("button", { name: "Create challenge", exact: true }),
  ).toBeDisabled();

  await seatB.getByRole("button", { name: "Watch match", exact: true }).click();
  await expect(
    seatB.getByRole("application", { name: "Seat A board" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    seatB.getByRole("application", { name: "Seat B board" }),
  ).toBeVisible();
  await expect(seatB.locator('.player-pane[data-side="left"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(seatB.locator('.player-pane[data-side="right"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    seatB.getByRole("button", { name: "Exit watch", exact: true }),
  ).toBeVisible();

  await seatB.getByRole("button", { name: "Exit watch", exact: true }).click();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible();
  await expect(seatA.getByText(/Reconnecting\.{1,3}/)).toBeVisible({
    timeout: 15_000,
  });

  await seatB.close();
  await seatA.close();
});

test("a recreated participant can concede once and unlock competitive play", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  await seatB.reload();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await seatB.getByRole("button", {
    name: "Concede and leave",
    exact: true,
  }).click();

  const confirmation = seatB.getByRole("dialog", {
    name: "Concede this match?",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(
    "Your opponent will win, and this cannot be undone.",
  );
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await confirmation.getByRole("button", {
    name: "Concede match",
    exact: true,
  }).click();

  const create = seatB.getByRole("button", {
    name: "Create challenge",
    exact: true,
  });
  await expect(create).toBeEnabled({ timeout: 15_000 });
  await expect(
    seatA.getByRole("heading", { name: "Victory", exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => seatB.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly info?: string;
      readonly payload?: {
        readonly eventId?: string;
        readonly kind?: string;
      };
    }>;
    return {
      concessionEventIds: [...new Set(updates.flatMap((update) =>
        update.payload?.kind === "match-conceded" &&
          update.payload.eventId !== undefined
          ? [update.payload.eventId]
          : []
      ))],
      concessionMessages: updates.flatMap((update) =>
        update.info === "Bob conceded · Alice wins" ? [update.info] : []
      ),
    };
  }), { timeout: 15_000 }).toEqual({
    concessionEventIds: [expect.any(String)],
    concessionMessages: ["Bob conceded · Alice wins"],
  });

  await openLobby(seatB);
  const aliceStanding = seatB.locator(
    '.standings-table tr[data-player-id="alice@example.test"]',
  );
  const bobStanding = seatB.locator(
    '.standings-table tr[data-player-id="bob@example.test"]',
  );
  await expect(aliceStanding.locator("td").nth(0)).toHaveText("1");
  await expect(aliceStanding.locator("td").nth(1)).toHaveText("0");
  await expect(bobStanding.locator("td").nth(0)).toHaveText("0");
  await expect(bobStanding.locator("td").nth(1)).toHaveText("1");

  await seatB.close();
  await seatA.close();
});

test("an externally finished match dismisses an obsolete recovery confirmation", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  await seatB.reload();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await seatB.getByRole("button", {
    name: "Concede and leave",
    exact: true,
  }).click();
  const obsoleteConfirmation = seatB.getByRole("dialog", {
    name: "Concede this match?",
  });
  await expect(obsoleteConfirmation).toBeVisible();

  await leaveThroughMatchMenu(seatA);

  await expect(obsoleteConfirmation).toBeHidden({ timeout: 15_000 });
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    seatB.getByRole("button", { name: "Create challenge", exact: true }),
  ).toBeEnabled();
  await expect(obsoleteConfirmation).toBeHidden();

  await seatB.close();
  await seatA.close();
});

test("a pending concession retries automatically then throttles each manual retry", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await installControllableMonotonicClock(context);
  await suppressOwnMatchConcededEchoes(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  await seatB.reload();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await seatB.getByRole("button", {
    name: "Concede and leave",
    exact: true,
  }).click();
  await seatB.getByRole("dialog", { name: "Concede this match?" })
    .getByRole("button", { name: "Concede match", exact: true })
    .click();

  const concessionDeliveryState = () => seatB.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly href?: string;
      readonly info?: string;
      readonly notify?: unknown;
      readonly payload?: {
        readonly eventId?: string;
        readonly kind?: string;
      };
      readonly summary?: string;
    }>;
    const concessions = updates.filter(
      (update) => update.payload?.kind === "match-conceded",
    );
    const feedbackKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith("split-stack/pending-chat-feedback/v2:") &&
      key.endsWith(":bob@example.test")
    );
    const journal = feedbackKey === undefined
      ? []
      : JSON.parse(window.localStorage.getItem(feedbackKey) ?? "[]") as Array<{
        readonly payload?: { readonly kind?: string };
        readonly resolved?: boolean;
      }>;
    return {
      eventIds: [...new Set(concessions.map((update) => update.payload?.eventId))],
      rawCount: concessions.filter((update) =>
        update.href === undefined &&
        update.info === undefined &&
        update.notify === undefined &&
        update.summary === undefined
      ).length,
      concessionInfos: concessions.flatMap((update) =>
        update.info === undefined ? [] : [update.info]
      ),
      journalLength: journal.length,
      concessionJournalResolved: journal
        .filter((entry) => entry.payload?.kind === "match-conceded")
        .map((entry) => entry.resolved ?? false),
    };
  });
  const create = seatB.getByRole("button", {
    name: "Create challenge",
    exact: true,
  });

  await expect.poll(concessionDeliveryState, { timeout: 10_000 }).toEqual({
    eventIds: [expect.any(String)],
    rawCount: 2,
    concessionInfos: [],
    journalLength: 1,
    concessionJournalResolved: [false],
  });
  await seatB.waitForTimeout(1_250);
  expect(await concessionDeliveryState()).toEqual({
    eventIds: [expect.any(String)],
    rawCount: 2,
    concessionInfos: [],
    journalLength: 1,
    concessionJournalResolved: [false],
  });
  await expect(create).toBeDisabled();

  await advanceMonotonic(seatB, 10_001);
  await expect(
    seatB.getByText("Still waiting for confirmation.", { exact: true }),
  ).toBeVisible({ timeout: 3_000 });
  const retry = seatB.getByRole("button", { name: "Retry now", exact: true });
  await retry.click();
  await expect.poll(
    async () => (await concessionDeliveryState()).rawCount,
    { timeout: 3_000 },
  ).toBe(3);
  await seatB.waitForTimeout(1_250);
  expect((await concessionDeliveryState()).rawCount).toBe(3);
  await expect(create).toBeDisabled();

  await advanceMonotonic(seatB, 10_001);
  await expect(
    seatB.getByText("Still waiting for confirmation.", { exact: true }),
  ).toBeVisible({ timeout: 3_000 });
  await seatB.evaluate(() => {
    (
      window as unknown as {
        __splitStackReleaseOwnMatchConcededEchoes: () => void;
      }
    ).__splitStackReleaseOwnMatchConcededEchoes();
  });
  await retry.click();

  await expect(create).toBeEnabled({ timeout: 15_000 });
  await expect.poll(concessionDeliveryState, { timeout: 15_000 }).toEqual({
    eventIds: [expect.any(String)],
    rawCount: 4,
    concessionInfos: ["Bob conceded · Alice wins"],
    journalLength: 0,
    concessionJournalResolved: [],
  });

  await openLobby(seatB);
  const aliceStanding = seatB.locator(
    '.standings-table tr[data-player-id="alice@example.test"]',
  );
  const bobStanding = seatB.locator(
    '.standings-table tr[data-player-id="bob@example.test"]',
  );
  await expect(aliceStanding.locator("td").nth(0)).toHaveText("1");
  await expect(aliceStanding.locator("td").nth(1)).toHaveText("0");
  await expect(bobStanding.locator("td").nth(0)).toHaveText("0");
  await expect(bobStanding.locator("td").nth(1)).toHaveText("1");

  await seatB.close();
  await seatA.close();
});

test("a recreated live player consumes a stale match link without entering the arena", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  await forceWebxdcIdentityOnRoute(seatB, "Bob");
  await seatB.goto("/?reopened=1#match/stale-unrelated-match");
  await expect(seatB.getByRole("main", { name: "Split Stack" })).toBeVisible();
  await seatB.waitForLoadState("networkidle");

  await expect.poll(async () => ({
    lobby: await seatB.getByRole("heading", {
      name: "Lobby",
      exact: true,
    }).isVisible(),
    ownSeatWatching: await seatB.getByText(
      /bound to another game session.*watching only/i,
    ).isVisible(),
  }), { timeout: 10_000 }).toEqual({
    lobby: true,
    ownSeatWatching: false,
  });
  await expect(
    seatB.getByText("This link is no longer active.", { exact: true }),
  ).toBeVisible();
  await expect(
    seatB.getByRole("application", { name: "Seat A board" }),
  ).toBeHidden();
  await expect(
    seatB.getByRole("application", { name: "Seat B board" }),
  ).toBeHidden();
  await expect.poll(() => seatB.evaluate(() => window.location.hash)).toBe("");

  await seatB.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    seatB.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible();
  await expect(seatB.getByText("Unfinished match", { exact: true })).toBeVisible();
  await expect(
    seatB.getByText("This copy can watch but cannot resume playing.", { exact: true }),
  ).toBeVisible();

  await seatB.close();
  await seatA.close();
});

test("an orphaned live match waits for explicit neutral release", async ({
  context,
  page,
}) => {
  test.setTimeout(55_000);
  await installControllableMonotonicClock(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");

  await Promise.all([seatA.close(), seatB.close()]);
  await failFirstRealtimeJoinOnFuturePages(context);

  const reopenedSeatA = await context.newPage();
  await reopenedSeatA.goto("/#name=Alice&addr=alice%40example.test");
  await expect(
    reopenedSeatA.getByRole("main", { name: "Split Stack" }),
  ).toBeVisible();
  await reopenedSeatA.waitForLoadState("networkidle");

  await expect(
    reopenedSeatA.getByText(/Neutral exit unlocks in \d+s/),
  ).toBeVisible({ timeout: 10_000 });

  await advanceMonotonic(
    reopenedSeatA,
    RULES.network.reconnectGraceMs + 1_000,
  );
  await reopenedSeatA.waitForTimeout(1_000);

  const connectionLossFinishes = () => reopenedSeatA.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly result?: {
          readonly outcome?: string;
          readonly reason?: string;
        };
      };
    }>;
    return [...new Map(updates.flatMap((update) =>
      update.payload?.kind === "match-finished" &&
        update.payload.result?.reason === "connection-lost" &&
        update.payload.eventId !== undefined
        ? [[update.payload.eventId, {
            eventId: update.payload.eventId,
            outcome: update.payload.result.outcome,
            reason: update.payload.result.reason,
          }] as const]
        : []
    )).values()];
  });
  expect(await connectionLossFinishes()).toEqual([]);

  const create = reopenedSeatA.getByRole("button", {
    name: "Create challenge",
    exact: true,
  });
  await expect(create).toBeVisible({ timeout: 10_000 });
  await expect(create).toBeDisabled();
  const endInterruptedMatch = reopenedSeatA.getByRole("button", {
    name: "End match with no result",
    exact: true,
  });
  await expect(endInterruptedMatch).toBeVisible();
  await expect(endInterruptedMatch).toBeEnabled();
  await endInterruptedMatch.click();
  const confirmation = reopenedSeatA.getByRole("dialog", {
    name: "End match with no result?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", {
    name: "End match with no result",
    exact: true,
  }).click();

  await expect.poll(connectionLossFinishes, { timeout: 10_000 }).toEqual([
    {
      eventId: expect.any(String),
      outcome: "desync",
      reason: "connection-lost",
    },
  ]);
  await expect(create).toBeEnabled();
  await openLobby(reopenedSeatA);
  await expect(reopenedSeatA.locator(".lobby-summary")).toContainText("0 live");
  const result = reopenedSeatA.locator(".lobby-result-row");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText(/connection lost/i);

  await expect.poll(() => reopenedSeatA.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly result?: { readonly reason?: string };
      };
      readonly info?: string;
      readonly href?: string;
      readonly summary?: string;
      readonly notify?: Record<string, string>;
    }>;
    const neutralUpdates = updates.filter((update) =>
      update.payload?.kind === "match-finished" &&
      update.payload.result?.reason === "connection-lost"
    );
    return {
      summaries: [...new Set(neutralUpdates.flatMap((update) =>
        update.summary === undefined ? [] : [update.summary]
      ))],
      infos: neutralUpdates.flatMap((update) =>
        update.info === undefined ? [] : [update.info]
      ),
      hrefs: neutralUpdates.flatMap((update) =>
        update.href === undefined ? [] : [update.href]
      ),
      notifications: neutralUpdates.flatMap((update) =>
        update.notify === undefined ? [] : [update.notify]
      ),
    };
  }), { timeout: 10_000 }).toEqual({
    summaries: ["0 wait · 0 live"],
    infos: [],
    hrefs: [],
    notifications: [],
  });

  await reopenedSeatA.close();
});

test("a deaf duplicate cannot end a match whose committed controllers are live", async ({
  context,
  page,
}) => {
  test.setTimeout(55_000);
  await installControllableMonotonicClock(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });

  const matchId = await waitForEffectiveMatchStarted(
    seatA,
    "alice@example.test",
  );

  const duplicate = await context.newPage();
  await forceIdentityWithSuppressedRealtimeInbound(duplicate, "Alice");
  await duplicate.goto("/?duplicate=deaf");
  await expect(
    duplicate.getByRole("heading", { name: "Split Stack", exact: true }),
  ).toBeVisible();
  await expect(
    duplicate.getByText("Unfinished match", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    duplicate.getByText("This copy can watch but cannot resume playing.", {
      exact: true,
    }),
  ).toBeVisible();

  await advanceMonotonic(duplicate, RULES.network.reconnectGraceMs + 1_000);
  await duplicate.waitForTimeout(1_000);
  const connectionLossEventIds = () => duplicate.evaluate((ownedMatchId) => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly matchId?: string;
        readonly result?: { readonly reason?: string };
      };
    }>;
    return [...new Set(updates.flatMap((update) =>
      update.payload?.kind === "match-finished" &&
        update.payload.matchId === ownedMatchId &&
        update.payload.result?.reason === "connection-lost" &&
        update.payload.eventId !== undefined
        ? [update.payload.eventId]
        : []
    ))];
  }, matchId);
  expect(await connectionLossEventIds()).toEqual([]);

  const seatAScore = await numericText(localScore(seatA));
  const seatBScore = await numericText(localScore(seatB));
  await seatA.keyboard.press("Space");
  await seatB.keyboard.press("Space");
  await expectScoreAbove(localScore(seatA), seatAScore);
  await expectScoreAbove(localScore(seatB), seatBScore);

  await duplicate.close();
  await seatB.close();
});

test("a hidden recreated participant gets a fresh recovery window on return", async ({
  context,
  page,
}) => {
  test.setTimeout(55_000);
  await installControllableMonotonicClock(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });
  await waitForEffectiveMatchStarted(seatA, "alice@example.test");
  await Promise.all([seatA.close(), seatB.close()]);

  const reopenedSeatA = await context.newPage();
  await reopenedSeatA.goto("/#name=Alice&addr=alice%40example.test");
  await expect(
    reopenedSeatA.getByRole("main", { name: "Split Stack" }),
  ).toBeVisible();
  await setVisibilityState(reopenedSeatA, "hidden");

  const connectionLossEventIds = () => reopenedSeatA.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: {
        readonly kind?: string;
        readonly eventId?: string;
        readonly result?: { readonly reason?: string };
      };
    }>;
    return [...new Set(updates.flatMap((update) =>
      update.payload?.kind === "match-finished" &&
        update.payload.result?.reason === "connection-lost" &&
        update.payload.eventId !== undefined
        ? [update.payload.eventId]
        : []
    ))];
  });

  await advanceMonotonic(
    reopenedSeatA,
    RULES.network.reconnectGraceMs + 10_000,
  );
  await reopenedSeatA.waitForTimeout(750);
  expect(await connectionLossEventIds()).toEqual([]);

  await setVisibilityState(reopenedSeatA, "visible");
  await advanceMonotonic(
    reopenedSeatA,
    RULES.network.reconnectGraceMs - 5_000,
  );
  await reopenedSeatA.waitForTimeout(750);
  expect(await connectionLossEventIds()).toEqual([]);

  await reopenedSeatA.close();
});

test("a spectating challenge creator keeps watching behind the pairing prompt", async ({
  context,
  page,
}) => {
  test.setTimeout(55_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });

  const spectator = await context.newPage();
  await openApp(spectator, "Charlie");
  await spectator.getByRole("button", { name: "Create challenge" }).click();
  await waitForWaitingChallenge(spectator);
  await openLobby(spectator);
  await spectator.getByRole("button", {
    name: "Watch Alice vs Bob",
    exact: true,
  }).click();
  await expect(spectator.getByRole("application", { name: "Seat A board" })).toBeVisible({
    timeout: 15_000,
  });

  const joiner = await context.newPage();
  await openApp(joiner, "Dave");
  await openLobby(joiner);
  await joiner.getByRole("button", { name: "Join Charlie", exact: true }).click();

  const interruption = spectator.getByRole("dialog", { name: "Opponent found" });
  await expect(interruption).toBeVisible({ timeout: 15_000 });
  await expect(spectator.getByRole("application", { name: "Seat A board" })).toBeVisible();
  await expect(spectator.getByRole("application", { name: "Seat B board" })).toBeVisible();
  const watchedScoreBefore = await numericText(localScore(spectator));
  await seatA.keyboard.press("Space");
  await expectScoreAbove(localScore(spectator), watchedScoreBefore);

  await expect(joiner.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
  await leaveThroughMatchMenu(joiner);
  await expect(interruption).toBeHidden({ timeout: 10_000 });
  await expect(spectator.getByRole("application", { name: "Seat A board" })).toBeVisible();
  await expect(spectator.getByRole("application", { name: "Seat B board" })).toBeVisible();

  await spectator.close();
  const scoreBefore = await numericText(localScore(seatA));
  await seatA.keyboard.press("Space");
  await expectScoreAbove(localScore(seatA), scoreBefore);
  await seatB.close();
  await joiner.close();
});

test("leaving an active match records a forfeit before releasing the seat", async ({
  context,
  page,
}) => {
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });

  await seatB.getByRole("button", { name: "Match menu" }).click();
  await expect(seatB.getByText(/keeps running while this menu is open/i)).toBeVisible();
  await seatB.getByRole("button", { name: "Leave match" }).click();

  await expect(seatA.getByRole("heading", { name: "Victory" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    seatA.getByRole("button", { name: "Request rematch", exact: true }),
  ).toBeVisible();
  await expect(seatB.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: RULES.network.missingPeerMs + 5_000,
  });

  await seatB.close();
});

test("Seat B durably releases a match when Seat A's channel disappears", async ({
  context,
  page,
}) => {
  test.setTimeout(50_000);
  await installControllableMonotonicClock(context);
  await enforceSingleRealtimeListener(context);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await advancePairMonotonic(seatA, seatB, 4_000, 500);
  await expect(seatB.locator(".center-overlay")).toBeHidden({ timeout: 5_000 });

  await setRealtimeSendBlocked(seatA, true);
  const connectionLost = seatB.getByRole("heading", { name: "Connection lost" });
  await advancePairMonotonic(
    seatA,
    seatB,
    RULES.network.missingPeerMs,
    250,
  );
  await advancePairMonotonic(
    seatA,
    seatB,
    RULES.network.reconnectGraceMs - RULES.network.missingPeerMs + 1_000,
    500,
  );
  await expect(connectionLost).toBeVisible({ timeout: 5_000 });
  await expect(seatB.getByText("Standings unchanged.", { exact: true })).toBeVisible();

  await seatB.getByRole("button", { name: "Home", exact: true }).click();
  await seatB.waitForTimeout(1_500);
  await openLobby(seatB);
  await expect(seatB.locator(".lobby-summary")).toContainText("0 live", {
    timeout: 10_000,
  });
  await expect(seatB.getByText(/Connection lost · neutral result/i)).toBeVisible();
  await seatA.close();
  await seatB.close();
});

test("a rematch starts only after the opponent explicitly accepts", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const { seatA, seatB } = await openVersusPair(context, page);
  await seatA.getByRole("button", { name: "Ready up", exact: true }).click();
  await seatB.getByRole("button", { name: "Ready up", exact: true }).click();
  await expect(seatA.locator(".center-overlay")).toBeHidden({ timeout: 10_000 });

  await seatA.evaluate(() => {
    for (let index = 0; index < 240; index += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
    }
  });
  await expect(seatA.getByRole("heading", { name: "Defeat" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatB.getByRole("heading", { name: "Victory" })).toBeVisible({
    timeout: 15_000,
  });

  await seatA.getByRole("button", { name: "Request rematch", exact: true }).click();
  await expect(
    seatA.getByRole("button", { name: "Rematch requested", exact: true }),
  ).toBeDisabled();
  await seatB.getByRole("button", { name: "Home", exact: true }).click();
  await openLobby(seatB);
  const accept = seatB.getByRole("button", { name: "Accept rematch", exact: true });
  await expect(accept).toBeVisible({ timeout: 10_000 });
  await accept.click();

  await expect(
    seatA.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    seatB.getByRole("button", { name: "Ready up", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await seatB.close();
});

test("Practice pauses for an opponent-found prompt and resumes when pairing is cancelled", async ({
  context,
  page,
}) => {
  test.setTimeout(40_000);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  const score = localScore(page);

  const seatB = await context.newPage();
  await openApp(seatB, "Bob");
  await openLobby(seatB);
  await seatB.getByRole("button", { name: "Join Alice", exact: true }).click();

  const interruption = page.getByRole("dialog", { name: "Opponent found" });
  await expect(interruption).toBeVisible({ timeout: 15_000 });
  await expect(interruption.getByText(/Bob joined your challenge/i)).toBeVisible();
  const pausedScore = await numericText(score);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
  });
  await page.waitForTimeout(150);
  expect(await numericText(score)).toBe(pausedScore);

  await interruption.getByRole("button", { name: "Cancel pairing" }).click();
  await expect(interruption).toBeHidden({ timeout: 10_000 });
  await page.keyboard.press("Space");
  await expectScoreAbove(score, pausedScore);
  await expect(seatB.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: 10_000,
  });
  const durableInterval = await page.evaluate(() =>
    Math.max(0, window.webxdc?.sendUpdateInterval ?? 0)
  );
  await page.waitForTimeout(durableInterval + 500);
  expect(await page.evaluate(() => {
    const updates = JSON.parse(
      window.localStorage.getItem("__xdcUpdatesKey__") ?? "[]",
    ) as Array<{
      readonly payload?: { readonly kind?: string };
      readonly info?: string;
    }>;
    return updates.flatMap((update) =>
      update.payload?.kind === "pairing-left" && update.info !== undefined
        ? [update.info]
        : []
    );
  })).toEqual([]);
  await seatB.close();
});

test("Practice can hand off directly from the opponent-found prompt to ready-up", async ({
  context,
  page,
}) => {
  test.setTimeout(35_000);
  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();

  const seatB = await context.newPage();
  await openApp(seatB, "Bob");
  await openLobby(seatB);
  await seatB.getByRole("button", { name: "Join Alice", exact: true }).click();

  const interruption = page.getByRole("dialog", { name: "Opponent found" });
  await expect(interruption).toBeVisible({ timeout: 15_000 });
  await interruption.getByRole("button", { name: "Go to match" }).click();
  await expect(interruption).toBeHidden();
  await expect(page.getByRole("button", { name: "Ready up", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(seatB.getByRole("button", { name: "Ready up", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await leaveThroughMatchMenu(page);
  await seatB.close();
});

test("leaving a pre-match pairing closes it without replacing the shared realtime subscription", async ({
  context,
  page,
}) => {
  test.setTimeout(35_000);
  await enforceSingleRealtimeListener(context);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openApp(page, "Alice");
  await page.getByRole("button", { name: "Create challenge" }).click();
  await waitForWaitingChallenge(page);

  const seatB = await context.newPage();
  await openApp(seatB, "Bob");
  await openLobby(seatB);
  const joinButton = seatB.getByRole("button", { name: "Join Alice", exact: true });
  await expect(joinButton).toBeEnabled();
  await joinButton.click();

  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible({
    timeout: 15_000,
  });
  const joinsBeforeLeave = await page.evaluate(
    () =>
      (
        window as unknown as {
          __splitStackRealtimeLifecycle: { joins: number };
        }
      ).__splitStackRealtimeLifecycle.joins,
  );
  await leaveThroughMatchMenu(page);
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await expect(seatB.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: 15_000,
  });

  await page.waitForTimeout(RULES.network.reconnectingMs + 500);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: { joins: number };
          }
      ).__splitStackRealtimeLifecycle.joins,
    ),
  ).toBe(joinsBeforeLeave);
  expect(pageErrors).toEqual([]);

  await seatB.close();
});

test("a newer pre-match runtime takes control while the older runtime stays on Home", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  await enforceSingleRealtimeListener(context);
  const { seatA, seatB: olderSeatB } = await openVersusPair(context, page);
  const olderSeatBErrors: string[] = [];
  olderSeatB.on("pageerror", (error) => olderSeatBErrors.push(error.message));
  const newerSeatB = await context.newPage();
  await newerSeatB.goto("/#name=Bob&addr=bob%40example.test");
  await expect(newerSeatB.getByRole("main", { name: "Split Stack" })).toBeVisible();

  await expect(
    newerSeatB.getByRole("application", { name: "Your board" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(olderSeatB.getByRole("heading", {
    name: "Split Stack",
    exact: true,
  })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    olderSeatB.getByText("Pairing active in another session", { exact: true }),
  ).toBeVisible();
  await expect(
    olderSeatB.getByText("This copy cannot control the pairing.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    olderSeatB.getByRole("button", { name: "Watch match", exact: true }),
  ).toBeHidden();
  await expect(
    olderSeatB.getByRole("button", { name: "Concede and leave", exact: true }),
  ).toBeHidden();
  await expect(olderSeatB.getByText(/bound to another game session/i)).toBeHidden();
  for (const boardName of [
    "Your board",
    "Opponent board",
    "Seat A board",
    "Seat B board",
  ]) {
    await expect(
      olderSeatB.getByRole("application", { name: boardName }),
    ).toBeHidden();
  }
  await expect(
    olderSeatB.getByRole("button", { name: "Create challenge", exact: true }),
  ).toBeDisabled();
  await expect(
    olderSeatB.getByRole("button", { name: /^Lobby(?: ·|$)/ }),
  ).toBeEnabled();
  expect(
    await olderSeatB.evaluate(
      () =>
        (
          window as unknown as {
            __splitStackRealtimeLifecycle: { joins: number };
          }
        ).__splitStackRealtimeLifecycle.joins,
    ),
  ).toBe(1);

  await leaveThroughMatchMenu(newerSeatB);
  await expect(seatA.getByRole("heading", { name: "Split Stack" })).toBeVisible({
    timeout: 15_000,
  });
  await waitForWaitingChallenge(seatA);
  expect(olderSeatBErrors).toEqual([]);

  await olderSeatB.close();
  await newerSeatB.close();
});

test("the v2 clean reset ignores legacy competitive and rematch state", async ({ page }) => {
  await seedLegacyCompletedMatch(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("split-stack/practice-high-score/v1", "999999");
  });
  await openApp(page, "Alice");

  await expect(page.getByRole("button", { name: "Create challenge" })).toBeVisible();
  await expect(page.locator(".home-practice-record").first()).toHaveText("Your best: 0");
  await expect(page.getByRole("heading", { name: "Victory" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Request rematch" })).toBeHidden();

  await openLobby(page);
  await expect(page.locator(".lobby-result-row")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Recent results", exact: true }),
  ).toBeHidden();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Split Stack" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create challenge" })).toBeVisible();
});

test("legacy graphics preferences migrate without restoring Reduced Effects UI", async ({ page }) => {
  await openApp(page);
  for (const [legacy, expected] of [
    [true, "very-low"],
    [false, "auto"],
    [undefined, "auto"],
  ] as const) {
    await page.evaluate(([legacyValue]) => {
      localStorage.setItem(
        "split-stack/preferences/v1",
        JSON.stringify(legacyValue === undefined ? {} : { reducedEffects: legacyValue }),
      );
    }, [legacy]);
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel("Graphics")).toHaveValue(expected);
    await expect(page.getByLabel("Reduced effects and 30 FPS")).toHaveCount(0);
  }
});

test("Graphics persists fixed tiers and Very Low removes heavy CSS while preserving functional cues", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Reduced effects and 30 FPS")).toHaveCount(0);

  await page.getByLabel("Graphics").selectOption("very-low");
  await expect(page.locator(".split-stack-app")).toHaveAttribute("data-graphics-tier", "very-low");
  await page.waitForTimeout(500);
  await expect(page.locator(".split-stack-app")).toHaveAttribute("data-graphics-tier", "very-low");
  await expect(page.getByText(/^Auto currently uses/)).toBeHidden();

  const styles = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".split-stack-app")!;
    const pane = document.createElement("div");
    pane.className = "player-pane";
    pane.dataset.scrambled = "true";
    pane.innerHTML = '<div class="board-hit-target"></div><div class="blackout-cover"><span class="blackout-icon"></span></div><div class="piece-preview-cell is-marked"></div><div class="incoming-garbage" data-state="ready"></div><div class="power-meter is-activating"></div>';
    root.append(pane);
    const target = pane.querySelector(".board-hit-target")!;
    const blackout = pane.querySelector(".blackout-cover")!;
    const marked = pane.querySelector(".piece-preview-cell")!;
    const incoming = pane.querySelector(".incoming-garbage")!;
    const power = pane.querySelector(".power-meter")!;
    const result = {
      ants: getComputedStyle(target, "::before").animationName,
      blackout: getComputedStyle(blackout).animationName,
      scan: getComputedStyle(blackout, "::before").animationName,
      marked: getComputedStyle(marked, "::after").animationName,
      incoming: getComputedStyle(incoming).animationName,
      power: getComputedStyle(power).animationName,
    };
    root.dataset.reducedMotion = "true";
    result.ants = `${result.ants}/${getComputedStyle(target, "::before").animationName}`;
    result.marked = `${result.marked}/${getComputedStyle(marked, "::after").animationName}`;
    delete root.dataset.reducedMotion;
    root.dataset.reducedFlashes = "true";
    result.marked = `${result.marked}/${getComputedStyle(marked, "::after").animationName}`;
    pane.remove();
    return result;
  });

  expect(styles).toMatchObject({
    ants: /none\/none$/,
    blackout: "none",
    scan: "none",
    marked: /^preview-marked-source-pulse\/none\/none$/,
    incoming: "incoming-garbage-ready",
    power: "power-meter-activate",
  });

  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Graphics")).toHaveValue("very-low");
});

test("load and Practice make no external HTTP requests", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== APP_ORIGIN) {
      externalRequests.push(request.url());
    }
  });

  await openApp(page, "Offline Tester");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
  await page.keyboard.press("Space");
  await expectScoreAbove(localScore(page), 0);

  expect(externalRequests).toEqual([]);
});

test("menu actions stay silent until gameplay requests its playlist", async ({ page }) => {
  const moduleRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".mod")) {
      moduleRequests.push(request.url());
    }
  });

  await openApp(page, "Silent Lobby Tester");
  expect(moduleRequests).toEqual([]);

  await page.getByRole("button", { name: "How to Play" }).click();
  await expect(page.getByRole("heading", { name: "How to Play" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  expect(moduleRequests).toEqual([]);

  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect.poll(() => moduleRequests.length).toBe(2);
});

test("Practice pauses for a real WebGL context loss and survives restoration", async ({ page }) => {
  await openApp(page, "Context Tester");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();

  const canLoseContext = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.game-canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (extension === null || extension === undefined) return false;
    (window as unknown as Record<string, unknown>).__splitStackWebglLoss = extension;
    extension.loseContext();
    return true;
  });
  test.skip(!canLoseContext, "WEBGL_lose_context is unavailable in this browser");

  await expect(page.getByText(/display interrupted.*WebGL recovers/i)).toBeVisible();

  const restored = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.game-canvas");
    const extension = (window as unknown as Record<string, unknown>).__splitStackWebglLoss as
      | { restoreContext(): void }
      | undefined;
    if (canvas === null || extension === undefined) return false;
    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 3_000);
      canvas.addEventListener(
        "webglcontextrestored",
        () => {
          window.clearTimeout(timeout);
          resolve(true);
        },
        { once: true },
      );
      extension.restoreContext();
    });
  });

  expect(restored).toBe(true);
  await expect(page.getByRole("application", { name: "Your board" })).toBeVisible();
  await page.getByRole("button", { name: "Match menu" }).click();
  await expect(page.getByText(/Practice is paused/i)).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator(".center-overlay")).toBeHidden();
});
