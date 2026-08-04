# Split Stack 1.0.0 release notes

Build date: 2026-08-04

## Artifact

- File: `dist-xdc/split-stack.xdc`
- Archive size: **291,951 bytes (285.1 KiB)**
- SHA-256: `ca067986ae966902ccba02586bbded3525eb4f84666d60ff5d86590aff2a2abb`
- Uncompressed payload: **834,904 bytes (815.3 KiB)**
- Payload files: **7**
- Icon: **256×256 PNG**

The release archive was produced by the pinned Vite/Webxdc toolchain and
validated by `npm run verify:xdc`. Verification checked ZIP structure and CRCs,
safe/canonical entry paths, Store/Deflate compression, all required root files,
relative runtime asset closure, icon format and dimensions, and exclusion of
source maps, packaged `webxdc.js`, and static external network targets.

## Included

- Two-player realtime survival matches, spectator presentation, ready/countdown,
  one-minute resilient reconnect/rollback handling, neutral connection-loss
  results, local diagnostics, result consensus, history, and rematch flow.
- Rules-v2 deterministic engine with 150 ms clear anticipation, buffered spawn
  inputs, seven-line power charge, 5×5 Nuke, contact-locking Acid Rain, staged
  Collapse, ordered special cells, and solo practice.
- Responsive Three.js power/garbage/status animation, glowing special-cell
  icons, full-canvas gestures, original adaptive procedural chiptune music,
  separate music/effects controls, and accessibility/reduced-effects settings.
- MIT license and third-party notices at the archive root.

## Distribution note

The Webxdc manifest links to the canonical public source repository at
`https://github.com/lunox94/split_stack`. Current Delta Chat desktop, Android,
and iOS smoke tests remain part of the release-operator checklist when those
devices are available.
