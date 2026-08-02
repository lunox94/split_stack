# Split Stack

Split Stack is an offline, competitive falling-block survival game for two
players in a Webxdc chat. Each player sees their own board on the left, plays
simultaneously, and sends attacks and automatic powers through the realtime
channel. A solo practice mode remains available without a realtime peer.

The app has no server, accounts, analytics, ads, or external runtime assets.

## Play

In a Webxdc-capable messenger, one participant creates a challenge and a
second participant joins. Both players ready up, then a synchronized countdown
starts the match. Later participants are read-only spectators. The lobby also
offers practice, opt-in help, settings, recent results, and head-to-head totals.

Desktop controls:

| Action | Key |
| --- | --- |
| Move | Left / Right |
| Soft drop | Down |
| Hard drop | Space |
| Rotate clockwise / counter-clockwise | Up or X / Z |
| Hold | C or Shift |
| Pause (practice only) | P or Escape |

Touch users can choose gestures or labeled on-screen buttons in Settings.
Scramble effects remap logical movement controls consistently for their full
duration. Accessibility options include a colorblind palette, surface patterns,
reduced motion, reduced flashes, a 30 FPS reduced-effects mode, optional screen
shake and vibration, and independent effects audio controls.

## Development

Requirements:

- Node.js 22 (the CI version; Vite 8 also supports its documented Node 20.19+
  range)
- npm

Install exact dependencies and start the Webxdc development mock:

```sh
npm ci
npm run dev
```

The host-supplied `webxdc.js` is referenced by `index.html`; it is mocked only
in development and deliberately excluded from the release archive.

Useful quality commands:

```sh
npm run typecheck
npm test
npm run test:coverage
npm run test:browser
npm run check
```

The deterministic engine is under `src/domain`, centralized balance values are
under `src/config`, realtime/durable protocol code is under `src/network`, and
the Three.js presentation is under `src/render`. `IMPLEMENTATION_DECISIONS.md`
records resolutions for platform constraints and specification ambiguities.

## Build a Webxdc release

Before public distribution, replace `REPLACE_WITH_FINAL_SOURCE_REPOSITORY` in
`public/manifest.toml` with the canonical source repository URL. Then run:

```sh
npm run build
npm run verify:xdc
```

The production application is emitted to `dist/` and the installable archive
to `dist-xdc/split-stack.xdc`. The verifier parses the ZIP without invoking an
external unzip utility and checks CRCs, safe paths, Store/Deflate compression,
required root files, the icon dimensions, relative asset closure, excluded
source maps and `webxdc.js`, and forbidden external runtime URLs. It also
reports archive and uncompressed sizes for release notes.

For a release candidate, load the `.xdc` in a current Delta Chat desktop,
Android, and iOS client where devices are available. Exercise two active
players plus a spectator, reconnect recovery, rematch, practice, portrait and
landscape layouts, reduced effects, and WebGL context recovery.

## Offline and privacy model

All game scripts, shaders, visual assets, and procedural audio code are bundled
inside the `.xdc`. Live state uses Webxdc's ephemeral realtime channel; lobby,
seat, and result records use bounded durable Webxdc updates. Display names are
rendered as text, network messages are bounded and validated, and the app does
not expose participant addresses.

The game uses a casual trust model: deterministic seeds and hashes detect
accidental divergence, but version one does not claim strong protection from a
deliberately modified client.

## License and distribution

Original Split Stack code is MIT licensed; see `LICENSE`. Third-party notices
are in `THIRD_PARTY_NOTICES.md` and are included in the release archive. The UI,
icon, procedural sounds, effects, and copy are original to this project.

A proper intellectual-property review is required before broad commercial
distribution. This repository is an implementation artifact, not legal advice
or clearance.
