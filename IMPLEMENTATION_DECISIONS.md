# Split Stack implementation decisions

The approved specification identifies itself as the source of truth and asks
implementers to surface ambiguity. This file records the narrow interpretations
needed to make the simulation deterministic. The additions below are part of
rules version 2 and must change together with the peer rules hash.

## Graphics presentation policy

- Graphics is a local presentation policy, outside the rules hash and all
  authoritative simulation, network, audio, recovery-countdown, and cue-order
  decisions. Normal, Low, and Very Low explicitly select full, limited, and
  reduced render profiles; only Auto changes tier at runtime.
- Auto observes visible uncapped animation-frame timestamps before the separate
  competitive/spectator 30 FPS presentation cadence. It calibrates 24 deltas in
  the 4–50 ms range using their median, then clamps the baseline to
  16.667–20 ms (60–50 Hz). The clamp accepts stable 50 Hz, avoids
  high-refresh over-sensitivity, and prevents sustained 24 ms startup cadence
  from becoming its own Normal baseline; that cadence exceeds the later 1.20
  slowdown ratio. Auto downgrades on a two-second mean ratio of at least 1.20
  (or a 250 ms frame) with a two-second downgrade interval, and upgrades after
  a ten-second cooldown plus eight healthy seconds at ratio at most 1.08.
  Suspension retains the selected tier but clears samples and starts recovery
  cooldown on resume.
- Reduced motion and reduced flashes are independent monotonic accessibility
  overrides. They staticize the corresponding CSS/DOM and timeline cues,
  including marked-cell legibility, rather than selecting Very Low. Very Low
  removes decorative Scramble and Blackout motion but retains cheap functional
  and semantic cues such as marked previews, garbage warning, power activation,
  Glitch state, barrier sequence, and progress/status readability.
- Marked cells are presentation-only local light sources rather than animated
  outlines. Each non-Ghost source carries a deterministic 2.8-second pulse: a
  accent lift and a full rim brighten the source from an ordinary-cell trough
  while every occupied,
  non-Ghost cell in its eight-neighbor field receives a source-facing rim and
  clipped inward surface wash on the same envelope. Every marked cell uses its
  power accent as the base color and removes the piece pattern while retaining
  the shared surface shading and bevel. Its larger ivory glyph sits directly
  on that surface with a strong dark understroke for small-screen contrast;
  there is no socket or badge. The glyph remains fully opaque and does not
  pulse or glow. Every
  visible source and its
  field share one global envelope; when several sources affect one target, it
  receives one deterministic contribution per source-facing direction so each
  relevant rim section responds without mixing duplicate overlays. Ghost
  markers keep only a faint static glyph and
  neither cast nor receive neighbor light. Lower graphics tiers
  reduce or remove the surface wash before essential source, rim, and glyph
  cues, while reduced motion or flashes freeze a representative static state.
  Spawn and lock emphasis may strengthen only the source lift and rim, never
  the neighboring field or glyph. NEXT and HOLD previews use the same marked-
  cell treatment and 2.8-second curve, while How to Play retains bare power-
  colored glyphs.
- Board cells and DOM previews share one vivid palette and one pattern identity
  per visual kind. Their prototype-derived surface uses a rounded dimensional
  silhouette, a restrained upper sheen and lower bevel, and a larger navy
  pattern that remains readable without hue. WebGL bakes the surface, bevel,
  and pattern into one cached texture per palette and kind on the existing
  instanced cell pass; richer art therefore adds no per-cell draw pass. Garbage
  stays neutral and gridded, Ghosts stay textureless wireframes, Monomino uses
  the ordinary rounded-square silhouette with its own circle pattern, Acid
  keeps its distinct silhouette, and active cells receive only a subtle lift.
  Full, limited, and reduced profiles preserve the same silhouette and semantic
  pattern while lowering geometry segments and material response. This visual
  treatment is presentation-only and does not change the rules hash.
- Preferences remain at `split-stack/preferences/v1`. Valid `graphics` wins;
  legacy `reducedEffects: true` migrates to Very Low and false/absent values to
  Auto. The obsolete control and saved output are removed.

## Simulation ordering

- Recognized input actions apply in their observed ordinal against the current
  simulation tick. The fixed 60 Hz step then advances gravity/grounding plus
  status and mode timers. A lock is one atomic transaction using specification
  section 17.
- Input DAS/ARR values remain monotonic UI-input timings. They emit logical
  actions into the tick loop; they are not rounded into gameplay timers.
- Level-nine gravity begins with four ticks, then alternates 4/5 per successful
  gravity step. The phase pauses with the simulation.
- The spawn selection in resolution step 13 includes the spawn-collision
  top-out check. This is the operational form of the top-out check mentioned in
  step 12.
- A delayed line clear captures its level at lock time; crossing a timed level
  boundary during anticipation does not multiply that clear's score. The event
  ordinal participates in the authoritative state hash and checkpoints.
- O rotation preserves the occupied 2×2 footprint and uses no kick offset, but
  cycles the four indexed mino identities around the center so a marked power
  can be placed in any quadrant. The input is a successful directional action,
  while its unchanged footprint deliberately does not reset grounded lock
  delay; O can never qualify for a T-Spin. A hard drop is the final successful
  action and, per the literal T-Spin rule, disqualifies a prior rotation.

## Effects and queues

- A normal lock that completes rows enters a nine-tick (150 ms) resolution
  phase before the rows disappear. Gravity, status timers, and replacement-mode
  timers pause during resolution. Hold, one rotation, and the latest horizontal
  direction may be buffered for the next spawn; other inputs wait.
- Metered powers use a seven-point threshold and retain overflow charge. Their
  gameplay impact is staged for twelve ticks (200 ms) so presentation and
  simulation share a deterministic impact boundary.
- A Nuke fixes its target row to the highest occupied row, then evaluates every
  center column whose clipped 5×5 window includes a cell on that row. It
  maximizes occupied removals and breaks ties center-most, then left-most. The
  selected target cell itself may be empty.
- Acid remains horizontally controllable until its first stack/floor contact.
  The soft-drop or gravity step that first becomes grounded locks immediately,
  before another horizontal input. Occupied cells then dissolve top-to-bottom
  at one cell per tick (at most 333 ms for all 20 visible rows). Collapse uses
  a 15-tick drop followed by the standard nine-tick clear, totaling 400 ms
  after its power-impact boundary.
- Simultaneous special cells resolve bottom-to-top and left-to-right. The
  ordered affected-cell events are part of the deterministic effect stream.

- Pending Monomino Rush and Acid Rain activations form a two-item FIFO. Further
  activations are ignored while that queue is full. An active mode remains
  uninterrupted; already queued forced pieces precede a newly pending mode.
- Acid drops spawn at `(4, 0)`, use current-level gravity, resolve immediately
  on stack/floor contact without lock delay, and award no drop score.
- Collapse clears of more than four lines score deterministic groups of four
  plus the remaining one-to-three lines. They increment the lines statistic,
  but preserve combo/B2B and create no attack, charge, achievement, or special
  trigger.
- Normal line clears made by a Cross or Glitch use the normal scoring/attack/
  meter rules. At placement resolution only, exactly four completed rows emit a
  Small Hollow Cross and five or more emit a Large Hollow Cross, regardless of
  the controlled piece source; collapse and other power-only clears emit none.
  Both Cross descriptors are nonrotating and Holdable. Small uses cells
  `(1,0), (0,1), (2,1), (1,2)` at `(3,0)` and persists distinct
  `small-cross` cells. Large retains the existing eight-cell geometry at
  `(2,0)` and persists the configured ordered cell kinds `I,T,J,S,Z,L,O,cross`,
  including its pale-lemon final `cross` cell. The one-item Cross
  forced-queue cap counts only queued Cross descriptors across both variants;
  active and held Crosses do not count, and overflow remains two warned garbage
  rows. Cross variant is authoritative descriptor/checkpoint/hash state and is
  carried by Hollow Cross effects and receive/enqueue operations.
- Every resolution emits at most one garbage packet after cancellation,
  including all surviving Garbage Core contributions. Its hole is seeded from
  the lock's combined attack event so every row in the packet shares one hole.
- A lock examines at most four ready garbage rows total. Barrier-blocked rows
  count toward that attempt boundary because they were rows that would have
  risen; later queued rows wait for the next lock.

## Power refresh domain rules

- Competitive meter draws use the seven-card Scramble, Nuke, Collapse,
  Monomino Rush, Acid Rain, Oversize, and Ghost Jam bag. Practice uses an
  independent deterministic four-card Nuke, Collapse, Monomino Rush, and Acid
  Rain bag, so opponent-targeting powers are neither self-applied nor spent as
  no-ops.
- Standard base descriptors are divided into deterministic six-piece cadence
  windows containing exactly one marked cell. Mark types come from a separate
  five-card Column Bomb, Garbage Core, Glitch Core, Blackout, and Barrier bag.
  Forced descriptors cannot place marked cells even if malformed descriptor
  data reaches board merging.
- Embedded Blackout resets a 900-tick owner status. Embedded Barrier resets a
  1,200-tick, four-row status before ready garbage is evaluated for that lock.
  Ghost Jam resets a 900-tick target status; while present, the target
  simulation publishes no ghost row, which suppresses that projection for the
  owner, opponent, and spectators alike.
- Oversize attacks consume a separate deterministic six-shape I/J/L/S/T/Z
  bag on the recipient. Its cursor advances for every received attack,
  including overflow, and is checkpointed and hashed. One Oversize descriptor
  may wait in the forced FIFO; another pending attack becomes two ordinary
  warned garbage rows.
- Oversize shapes use their curated literal geometries and source-aware piece
  lookup. I is a five-cell line; mirrored J/L use a three-cell foot and
  three-high outer stem; mirrored S/Z use two offset three-cell runs; T uses a
  five-cell bar and two-cell center stem. They use normal movement, gravity,
  lock, drop, and Hold rules, plus deterministic nearby wall kicks. Oversize T
  is excluded from T-Spin recognition.
- A normal five-row clear removes and counts all five rows but deliberately
  classifies its rewards as a Tetris: score, attack, charge, back-to-back,
  Tetris statistics, Hollow Cross creation, and presentation all reuse the
  existing four-line values until the Pentris rewards tracked in GitHub issue
  #1 are designed and implemented.

## Webxdc constraints

- Webxdc durable `update.serial` is a replica-local replay cursor, not a
  portable global order. Competing claims therefore use the convergent
  application tuple `(logicalClock, actorId, eventId)`. Once occupied, a seat
  cannot be overridden until its holder emits a release with a new vacancy ID.
- Realtime identities are application assertions because the host listener
  supplies only bytes. Validation binds a claimed player/session to the current
  lobby handshake, consistent with the specification's casual trust model.
- Each occupied seat also publishes a bounded durable runtime-session claim.
  The newest convergent claim must echo through the durable listener before it
  controls the seat; an older duplicate remains a read-only spectator. A
  WebGL, liveness, role, or runtime-session transition can retire the current
  realtime channel before joining its replacement because Webxdc rejects
  overlapping joins. A visibility restore first probes the existing channel;
  it rejoins only after an explicit send failure or sustained silence.
  Failed replacement callbacks are contained and recorded, and the normal
  recovery cadence retries them while the session remains detached.
- Critical ACKs name `(senderId, sessionId)` explicitly; bare sequence numbers
  are never treated as globally unique. `START_COMMIT` additionally carries a
  bounded receiver-stamped semantic receipt. Cumulative cursors cannot retire
  that event, and duplicate deliveries repeat the original receipt, so a lost
  ACK cannot turn a timely accepted start into a later apparent rejection.
  Support is negotiated additively in `READY`; a legacy peer keeps its original
  ACK/cursor commit point instead of hanging on a receipt it cannot produce.
- Realtime `MATCH_CONFIG` is the live acknowledged authority. A compact durable
  mirror carries the round, seed, rules hash, and config hash for recovery and
  late observers.
- A critical gap is requested immediately. Buffers, ACK lists, and gap ranges
  are bounded by the central network limit so a remote peer cannot amplify an
  unbounded control frame.
- Every authenticated peer frame proves inbound liveness. Additive optional
  sequence/echo fields on `KEEPALIVE` prove outbound delivery when both peers
  support them; loss of those echoes can therefore pause a receive-only link
  even while inbound traffic continues. Three seconds of silence shows a
  nonblocking warning while play continues, five seconds freezes the
  simulation, and eight seconds requests a replacement channel. The second seat
  waits another 500 ms to reduce simultaneous replacement, and retries back off
  through 3, 6, 12, then 15 seconds while the committed controller's recovery
  window remains open.
- Channel replacement invalidates both sides of the recovery proof. Old-channel
  liveness, visibility restoration, and a cached `resumeAvailable` flag cannot
  declare the new generation restored; it must first authenticate a frame and
  complete fresh outbound proof on that generation.
- Network pause stops each authoritative local simulation immediately. Resume
  restores both owners to their newest common rolling checkpoint, bounded to
  three seconds of rollback independently of the longer missing-peer timeout,
  reconciles ledgers, and requires 500 ms of sustained bidirectional traffic.
  A reliable `START` is only a prepared proposal: Seat B remains paused until
  Seat A receives its acknowledgement and emits a reliable `START_COMMIT` with
  a fresh full lead. Seat A also remains stopped until that commit is
  acknowledged with Seat B's explicit accepted, expired, or rejected decision;
  an expired commit causes Seat A to prepare a new proposal and lead. A
  zero-rollback connection
  recovery uses a synchronized lead of at least 750 ms; rollback and visibility
  recovery use at least two seconds so players can reorient. Measured RTT plus
  variation can expand either lead, capped by the initial three-second lead.
  Recovery countdowns stay compact and silent. A checkpoint or hash mismatch
  ends neutrally as a desynchronization rather than guessing which owner state
  to rewrite.
- An exact committed controller may produce the neutral `connection-lost`
  result after twenty seconds only while its app is visible and its realtime
  recovery loop remains active. Hiding invalidates elapsed observation and
  returning begins a fresh window; internal transport detach/attach attempts
  preserve that visible incident's deadline. A verified recovery clears it.
  A receive-only replacement has separate authority: after sixty seconds without
  controller traffic it may offer an explicit neutral cleanup, but it never ends
  the match automatically. Neutral results remain in recent history but are
  excluded from win/loss tallies; an explicit Leave remains a forfeit.
- A replacement runtime cannot resume its committed simulation, but the seated
  participant may durably concede from that copy. Concession is a canonical
  self-loss, updates standings, and emits one concise result message; a neutral
  connection-loss cleanup updates only summary/history metadata. Pending result
  feedback is journaled until its canonical echo materializes. Failed appends
  retry automatically, while successful writes without an echo use one bounded
  payload-only confirmation probe; later manual probes reuse the same event ID
  so missing receipts cannot create chat duplicates or an unbounded resend log.
- Networking is pumped on a dedicated wall-clock interval rather than from the
  render loop. Privacy-safe diagnostics retain at most three incidents and 100
  events in local storage and may be copied or cleared by the player. Frame and
  byte telemetry uses fixed-cardinality arithmetic on the hot path; compact
  summaries are allocated and persisted only on existing incident transitions.
  They distinguish channel and session receive totals, successful bytes by
  message class, failed sends, bounded RTT and authenticated inter-arrival
  timing, critical retransmits, and gap requests. Incident context carries only
  the match ID and local seat for cross-device correlation. Clock deadlines and
  remote-tick failures capture fixed-size reason counters and tick bounds,
  while pause and detach events carry bounded trigger enums; raw frames,
  payloads, event IDs, and player identities remain excluded.
- If the wall-clock pump catches up across several regular snapshot intervals,
  it publishes only the newest state. Forced terminal snapshots are never
  coalesced. This prevents a brief main-thread stall from creating a burst of
  obsolete full-state frames that prolongs the same stall.
- Peers optionally report their latest accepted snapshot cursor in
  `KEEPALIVE`. Sustained sender/receiver lag steps the regular cadence down from
  10 to 5 to 2 to 1 Hz where the selected diagnostic profile permits it; 30
  seconds of healthy feedback restores one step. Three seconds without
  outbound proof temporarily suspends periodic state publication while forced
  state remains available. If a peer advertises a newer sent
  sequence while the receiver's state is stale, a rate-limited targeted
  `STATE_REQUEST` elicits one forced snapshot, including in the zero-periodic
  profile.
- Diagnostic builds can select 10, 5, 2, or 0 regular snapshots per second.
  This transport-only A/B profile sits outside the deterministic rules hash;
  forced initial, recovery, and terminal state still travels in every profile.
- Incoming realtime ticks are bounded to three seconds of catch-up work. A
  rolling checkpoint window accepts earlier terminal events without replaying
  from match start; events outside either bound finish neutrally as a desync.
- Initial clock samples, config acknowledgements, and critical frames retry on
  bounded timers. Each clock synchronization targets five samples, with probes
  paced 75 ms apart instead of burst-sent. Each missing-sample retry is another
  paced probe with a fresh sample ID, while delayed replies to earlier probes
  remain eligible for the current lifecycle. Missing clock samples back off
  from 500 ms to a two-second cap; an initial five-second deadline returns both
  players to readiness instead of leaving one player in a terminal state, while
  resume deadlines restart the recovery handshake. A new visibility pause
  advances the pause epoch and invalidates any in-flight resume before hidden
  peers can enter countdown. Terminal connection loss clears every remaining
  probe.
- A recently committed peer-clock offset may shorten resume validation to three
  fresh agreeing samples. Drift outside the RTT-aware tolerance discards all
  shortcut samples and requires five entirely fresh samples. A resume lifecycle
  that has current-generation bidirectional proof or valid sample progress gets
  one same-channel retry; the original controller deadline is never refreshed.
  Optional and repeatable recovery traffic shares a four-frame/250 ms transport
  window backed by a bounded priority queue. ACK/gap responses precede presence
  traffic and repeated presence coalesces. Critical and clock/commit retry state
  is updated only after real transport admission, never when work was deferred.
  Forced state may borrow the window so a pause-to-countdown transition cannot
  discard the authoritative snapshot.
- Two connection-related pauses within 30 seconds enter a flapping-link mode:
  recovery requires 2.5 seconds of sustained bidirectional proof and periodic
  snapshots remain at 1 Hz until the existing 30-second healthy step-up gate.
  Visibility-only pauses do not activate this mode.
  Results require identical peer hashes, with a 20-second consensus deadline
  and a canonical neutral result on failure.
- Critical retransmission starts with a conservative one-second timeout, then
  uses unambiguous acknowledgements to maintain smoothed RTT and variation.
  Retransmitted samples follow Karn's rule, each pending entry backs off
  exponentially to an eight-second cap, and timer- plus gap-triggered work
  shares a rotating maximum of 16 resends per pump so a backlog cannot
  monopolize networking.
- Reliable gap recovery coalesces duplicate requests for the same missing
  prefix and rate-limits overlapping ranges before any re-entrant send. A
  single lost critical frame therefore causes one targeted prefix resend per
  retry window instead of a recursive request/resend burst.
- `ShapedRealtimeBus` is the deterministic test seam for network resilience.
  Directional routes combine fixed latency, scripted or seeded jitter and loss,
  scripted duplication, and token-bucket bandwidth/queue limits. Its manual
  clock and explicit pump make asymmetric and one-way scenarios reproducible.
- An explicit forfeit carries a canonical self-loss result. The receiver queues
  that exact hash-validated result before acknowledging; Leave pumps retries for
  the three-second presence window and queues the same durable fallback once if
  no acknowledgement arrives.
- Each replica displays recent history in its durable replay order, using
  `matchId` only as the stable tie-breaker. Durable serials are not used for
  distributed seat arbitration.
- A result enters history only after a coordinator announcement that matches
  the materialized challenge roster, rules/config hashes, seed, round, and both
  seats. Results that arrive first wait in a bounded queue. The materializer
  retains the latest 20 for presentation while bounded aggregate state keeps
  all accepted matches available for tallies and reload restoration.

## Presentation event routing

- Input-resolution effects are consumed immediately, while effects produced by
  automatic competitive ticks cross a read-only session callback. Snapshot
  transitions supply level, countdown, and upcoming-power warning cues. Remote
  attacks and Blackout cues pan right; authoritative local effects pan left.
- The presentation timeline consumes deterministic simulation cues but never
  changes authoritative state. Reduced-motion/reduced-effects variants keep the
  same gameplay timing while removing shake, large travel, or repeated flashes.
- Competitive and spectator state projection is capped at 30 FPS while their
  input and 50 ms networking pump remain independent. Remote board models are
  rebuilt only for a new snapshot sequence, unchanged HUD values do not rewrite
  the DOM, and instanced WebGL buffers upload only live prefixes. These bounds
  keep two embedded players responsive without changing the 60 Hz simulation.
- Input-time status and tick queries do not materialize full render snapshots.
  Rejected movement does not create a rollback checkpoint or audio node, touch
  repeat timers are released whenever input is disabled, and a severe visible
  frame stall drives adaptive quality down instead of looking like suspension.
- Music uses four bundled 4-channel ProTracker modules. A match chooses one
  deterministically and rematches rotate the choice. The replay core renders
  short stereo PCM chunks into scheduled Web Audio buffer sources rather than
  retaining a full decoded song, which bounds memory use on phones.
- Music, SFX, and Callouts use independent buses followed by a transparent
  master safety ceiling. SFX never duck music. Callouts have independent mute
  and volume controls; the reserved voice-callout duck lowers music only to
  68% of its normal gain. Metered-power activation identities and local combo
  milestones are Callouts, while marked triggers and physical board events
  remain SFX.
- The tracker scheduler runs independently of rendering at a 100 ms cadence
  and keeps approximately 850 ms queued. A one-track music program preserves
  current match selection while leaving a bounded seam for future playlists.
  This is presentation-only and remains outside the rules hash.
- Normal line-clear impact effects carry a one-based combo count and `piece`
  origin. Collapse clear impacts carry `power-collapse` and the unchanged
  combo count. Audio combines the normal row-count SFX with Callouts only for
  piece-created clears: Combo 2, Combo 3, and Combo 4 use bundled recorded
  voices, while Combo 5+ remains procedural. Recorded callouts preload after
  audio unlock, retain their procedural fallback, and alone use the reserved
  music duck.
  Collapse participation would be a future gameplay-rules change rather than
  an audio-policy change.
- Synthesized SFX are bounded to 24 active tones. Movement and soft-drop cues
  coalesce within 30 ms and yield before unique clears, powers, warnings, and
  results. Callouts allow one active item plus three pending items; overflow
  removes the oldest pending combo first and otherwise the oldest pending
  callout. Pause, suspension, teardown, and disposal discard stale Callouts.
- Pausing, backgrounding, muting, track replacement, and Web Audio suspension
  stop queued module buffers and resume from the audible sample position. The
  modules keep their authored tempo and arrangement; gameplay intensity does
  not rewrite tracker data.
- The module files remain byte-exact and their source IDs and hashes are pinned.
  They are separate from the MIT license, and the unresolved game-bundling
  permission is stated explicitly in `THIRD_PARTY_NOTICES.md`.
