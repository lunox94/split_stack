# player experience

- Own delegated presentation code under `src/render`, `src/ui`, `src/input`, `src/audio`, CSS/assets, and presentation-only `src/app` paths.
- Keep Three.js and DOM presentation downstream of authoritative simulation state; never change game timing or outcomes from animation, audio, frame rate, or local preferences.
- Preserve keyboard and touch parity, scramble-transform semantics, responsive portrait/landscape layout, explicit control hit areas, and spectator/practice recovery routes.
- Maintain colorblind palettes, surface patterns, long-label resilience, reduced motion, reduced flashes, the 30 FPS reduced-effects mode, and independent music/effects settings.
- Keep all fonts, shaders, images, sound effects, and tracker modules bundled for offline `.xdc` execution.
- Preserve chunked tracker playback, pause/resume behavior, WebGL context recovery, and safe fallbacks when audio or rendering is unavailable.
- Add focused unit/render/UI tests and Playwright coverage; tag `@device-matrix` only when portrait/device assertions are intentional.
- Run focused checks first and `npm run check` after integration; request performance review for render, allocation, or audio-streaming changes.
