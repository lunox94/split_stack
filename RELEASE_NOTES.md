# Split Stack 1.0.0 release notes

Build date: 2026-08-02

## Artifact

- File: `dist-xdc/split-stack.xdc`
- Archive size: **270,747 bytes (264.4 KiB)**
- SHA-256: `fe5de4092601ec979f72db4dc1fab01d70ec50015deb6e3d8109a8f5b8ebf66e`
- Uncompressed payload: **758,289 bytes (740.5 KiB)**
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

The Webxdc manifest links to the canonical public source repository at
`https://github.com/lunox94/split_stack`. Current Delta Chat desktop, Android,
and iOS smoke tests remain part of the release-operator checklist when those
devices are available.
