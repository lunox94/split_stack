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

Keep both players in the two embedded instances on the same simulator page.
Opening an instance in an additional browser tab starts another Split Stack
runtime for that participant. A pre-match runtime can reclaim its seat, but an
already-started match keeps its original controller identity. The additional
runtime stays on navigable Home recovery UI instead of taking the seat or
automatically watching its own match; Lobby, Practice, and explicit watching
of other matches remain available.

The simulator also forwards a diagnostic copy of every realtime frame to its
frontend. A long, snapshot-heavy match can therefore stress the simulator page
more than a Delta Chat client, even with the Messages panel closed. This is a
useful overload test, but confirm performance-sensitive changes in a current
Delta Chat client before treating simulator throughput as a production limit.

To isolate that dashboard overhead, start `webxdc-dev` without `--open`, do not
load (or first navigate away from) its dashboard, and open exactly one copy of
each direct participant origin instead: `http://localhost:7001` and
`http://localhost:7002` for the default port. This keeps realtime relay active
without the dashboard's message telemetry. It is a useful diagnostic A/B test,
not a replacement for the headed, same-page embedded-instance check above.

### Snapshot-rate transport experiment

`VITE_SPLIT_STACK_SNAPSHOT_HZ` builds a diagnostic transport profile without
changing deterministic gameplay rules or the rules hash. Supported values are:

| Value | Regular snapshots | Simulation interval |
| --- | --- | --- |
| unset or `10` | 10 per second (default) | 6 ticks |
| `5` | 5 per second | 12 ticks |
| `2` | 2 per second | 30 ticks |
| `0` | disabled (no-periodic-snapshots experiment) | none |

Initial, recovery, and terminal snapshots are still sent in every profile.
The `0` profile is therefore useful for isolating periodic snapshot load, but
it is not a normal play mode: the opponent board does not receive continuous
visual updates between those forced states.

Movement and rotation are applied locally and do not emit one realtime frame
per input action; regular network publication stays on the fixed snapshot
cadence above. Debouncing rapid controls would therefore not reduce packet
volume and would make play less responsive. A unit test pins this boundary, and
the snapshot-rate profiles provide the controlled way to test transport load.

Build and preserve one archive per profile; every build overwrites
`dist-xdc/split-stack.xdc`:

```sh
VITE_SPLIT_STACK_SNAPSHOT_HZ=10 npm run build
cp dist-xdc/split-stack.xdc /tmp/split-stack-snapshot-10hz.xdc

VITE_SPLIT_STACK_SNAPSHOT_HZ=5 npm run build
cp dist-xdc/split-stack.xdc /tmp/split-stack-snapshot-5hz.xdc

VITE_SPLIT_STACK_SNAPSHOT_HZ=2 npm run build
cp dist-xdc/split-stack.xdc /tmp/split-stack-snapshot-2hz.xdc

VITE_SPLIT_STACK_SNAPSHOT_HZ=0 npm run build
cp dist-xdc/split-stack.xdc /tmp/split-stack-snapshot-no-periodic-snapshots.xdc
```

For a controlled device A/B, install the exact same archived `.xdc` on both
devices, create a fresh challenge, play for a fixed duration, then copy the
network diagnostics from both players. Repeat under the same Wi-Fi, client
versions, devices, and approximate input pattern with the next archive. Start
with 10 Hz as the control, then compare 5 Hz, 2 Hz, and no-periodic-snapshots by
time-to-first-incident and incident count. Do not mix archives or profiles
within a match: this experimental setting is intentionally outside the rules
hash, so a mismatch is not rejected by the compatibility handshake and would
invalidate the comparison.

### Reading network telemetry

Diagnostics take a compact counter snapshot only when an incident changes
state; they do not persist a record for every realtime frame. A large
`pump.maxGapMs` points to the local JavaScript loop being suspended or starved.
Compare `receive.rawFrames`, `decodedFrames`, and `authenticatedFrames`: raw
traffic that does not decode suggests invalid or incompatible data, while
decoded traffic that is not authenticated did not belong to the bound peer
session. During a silence, `sinceAuthenticated.sentSnapshots` and
`sentKeepalives` show how much traffic this client attempted to produce.
`snapshots.gapEvents`, `missing`, and `maxGap` summarize discontinuities among
accepted snapshot sequence numbers, and `critical.maxPending` is the peak
reliable-event backlog.

These summaries contain only fixed-size counts, byte totals, timings, and
sequence-gap statistics. They contain no frame payloads or participant
identities, and the hot path updates counters in memory without writing each
frame to local storage.

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

An authenticated peer frame counts as proof of life. Three seconds of silence
shows a nonblocking warning while play continues; five seconds freezes the
match. Channel replacement starts after eight seconds (staggered between the
two seats) and retries with capped exponential backoff for up to one minute. A
restored path must carry bidirectional traffic for 500 ms before recovery can
complete. Both players then restore their last common checkpoint (at most three
seconds of rollback) and resume after a synchronized 750 ms lead when no
orientation is needed, or two seconds after rollback or a visibility pause. If
recovery cannot complete, the match ends neutrally as a connection loss: it
remains visible in Recent Matches but does not affect head-to-head tallies.
Settings also provides copy/clear controls for a bounded, local-only diagnostic
log whose compact telemetry is captured only at incident transitions.

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
