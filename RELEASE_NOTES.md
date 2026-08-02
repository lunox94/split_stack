# Split Stack 1.0.0 release notes

Build date: 2026-08-02

## Artifact

- File: `dist-xdc/split-stack.xdc`
- Archive size: **265,451 bytes (259.2 KiB)**
- Uncompressed payload: **736,132 bytes (718.9 KiB)**
- Payload files: **7**
- Icon: **256×256 PNG**

The release archive was produced by the pinned Vite/Webxdc toolchain and
validated by `npm run verify:xdc`. Verification checked ZIP structure and CRCs,
safe/canonical entry paths, Store/Deflate compression, all required root files,
relative runtime asset closure, icon format and dimensions, and exclusion of
source maps, packaged `webxdc.js`, and static external network targets.

## Included

- Two-player realtime survival matches, spectator presentation, ready/countdown,
  reconnect handling, result consensus, history, and rematch flow.
- Deterministic falling-block engine, combat, powers, special cells, and solo
  practice.
- Responsive Three.js presentation, keyboard/touch controls, procedural sound,
  and accessibility/reduced-effects settings.
- MIT license and third-party notices at the archive root.

## Distribution note

Replace `REPLACE_WITH_FINAL_SOURCE_REPOSITORY` in `public/manifest.toml` with
the canonical public source URL before distributing this artifact as a public
release, then rebuild and rerun the verifier. Current Delta Chat desktop,
Android, and iOS smoke tests remain part of the release-operator checklist when
those devices are available.
