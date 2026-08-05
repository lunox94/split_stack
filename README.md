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
Gestures work across the gameplay canvas (apart from explicit UI controls), so
phone players do not have to keep every swipe inside the local board.
Scramble effects remap logical movement controls consistently for their full
duration. Accessibility options include a colorblind palette, surface patterns,
reduced motion, reduced flashes, a 30 FPS reduced-effects mode, optional screen
shake and vibration, and independent music and effects controls.

Each match deterministically selects one of four bundled 4-channel ProTracker
modules and rotates the choice on rematches. A small local replay engine streams
short PCM chunks into Web Audio, so the tracker music stays offline without
retaining an entire decoded song in memory. Music pauses with the game and has
independent mute and volume controls.

## Development

Requirements:

- Node.js 22 (the CI version; Vite 8 also supports its documented Node 20.19+
  range)
- npm

Install exact dependencies and start the lightweight Vite development mock:

```sh
npm ci
npm run dev
```

The host-supplied `webxdc.js` is referenced by `index.html`; it is mocked only
in development and deliberately excluded from the release archive. The Vite
mock is useful for practice mode and quick UI checks, but its `Add Peer` flow
uses browser tabs and storage events and is not reliable for testing realtime
channel timing, tab visibility, or reconnect behavior.

For two-player and other realtime testing, use the Webxdc project's recommended
[`webxdc-dev`](https://github.com/webxdc/webxdc-dev) simulator. It gives each
participant an isolated app instance and exposes the exchanged messages for
inspection. Build the installable archive and launch it with:

```sh
npm run build
npx -y @webxdc/webxdc-dev@0.21.0 run dist-xdc/split-stack.xdc
```

Start both instances in the simulator UI, create a challenge in one, join it
from the other, and ready both players. Use the simulator's Reset control to
clear participant state and messages between independent test runs.

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

The Webxdc manifest links to the canonical public source repository at
`https://github.com/lunox94/split_stack`. Build and verify a release with:

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

All game scripts, shaders, visual assets, sound effects, tracker modules, and
replay code are bundled inside the `.xdc`. Live state uses Webxdc's ephemeral
realtime channel; lobby, seat, and result records use bounded durable Webxdc
updates. Display names are rendered as text, network messages are bounded and
validated, and the app does not expose participant addresses.

An authenticated peer frame counts as proof of life. A silent peer freezes the
match after three seconds, starts channel replacement after five seconds, and
retries every five seconds for up to one minute. A successful recovery rolls
both players back to their last common checkpoint (at most three seconds) and
uses a synchronized three-second countdown before resuming. If recovery cannot
complete, the match ends neutrally as a connection loss: it remains visible in
Recent Matches but does not affect head-to-head tallies. Settings also provides
copy/clear controls for a bounded, local-only diagnostic log.

The game uses a casual trust model: deterministic seeds and hashes detect
accidental divergence, but rules version two does not claim strong protection
from a deliberately modified client.

## License and distribution

Original Split Stack code is MIT licensed; see `LICENSE`. Third-party notices
are in `THIRD_PARTY_NOTICES.md` and are included in the release archive. The
bundled music modules are separate assets outside the MIT grant and currently
have unresolved game-bundling permission; their byte-level provenance and the
BSD-licensed tracker replay core are documented in that notice. The UI, icon,
procedural sound effects, visual effects, and copy are original to this project.

A proper intellectual-property review is required before broad commercial
distribution. This repository is an implementation artifact, not legal advice
or clearance.
