# CLAUDE.md

**audiomesh** (repo and package still named audiochat; storage keys stay `audiochat:*` so
saved data survives): a browser-only acoustic network over speaker and microphone. Messages
(the screen and nav item are called "Messages" in the UI; the code keeps `chat`: `src/chat/`, screen id `chat`) are one kind of network traffic, next to announcements, link tests and repeats.
Uses JS8-style weak-signal modulation (8-GFSK, Costas sync, LDPC). Sibling of
`../hellschreiber2026`, and it inherits that project's stack and constraints.
Full over-the-air spec (modulation, FEC, band plan, timing, wire frame format,
repeater, ALE channel selection) — not the chat app built on top — is in
[`network-protocol.md`](./network-protocol.md).

## Commands

```bash
npm run dev         # vite on :5173
npm run build       # tsc --noEmit && vite build
npm run test        # vitest run (node environment, no jsdom)
npm run typecheck
```

No linter or formatter; `tsc` (strict, noUnused*) is the style gate.

**Rule: after any change the user will see by refreshing the browser (source, HTML, CSS,
`public/`, `vite.config.ts`), always run `npm run build` (it also typechecks) before saying
it is done.** The site is often served from `dist/` (`web.sh`, `vite preview`), which only
changes on a build; a change left unbuilt looks like a change that did not work.

## Hard constraints (same as hellschreiber2026)

1. No backend. `dist/` must work from any static file host.
2. No runtime network requests. The CSP meta tag injected by `vite.config.ts`
   enforces this; if a change trips it, the change is wrong. One exception, asked for by
   the user: the Sync clock check (`src/sync/server-clock.ts`) HEADs the page's own URL
   for its `Date` header, on a button press, at startup and every 10 minutes (on by default; the Sync checkbox or setting `serverClockOff` turns the automatic ones off).
   Same origin only; no third-party time service. A second exception, also asked for and **off by default**: "Publish Network Stats" (see its section) connects to one fixed MQTT broker, `wss://broker.emqx.io:8084`, the only other host in the CSP `connect-src`.
3. No audio leaves the machine. Mic input is processed locally and discarded.
4. Stack: TypeScript, Vite, Web Audio + `AudioWorklet` for DSP, Vitest. No UI
   framework, no DSP dependencies.

DSP conventions carry over: no allocation in `process()`, thin worklets over
DOM-free core classes, caller-owned buffers, never assume 48 kHz, timing by sample
counting in the worklet, echo cancellation / noise suppression / AGC off on the
mic stream, explicit units in names (`baseFreqHz`, `slotSec`).

## Architecture

```
audio <-> Modulator/Demodulator <-> FrameCodec <-> chat frames <-> ChatSession <-> UI
```

- `src/protocol/protocol.ts` defines the `Protocol` interface. **Multi-protocol is
  the design; six protocols are registered (below).** Adding one = a folder under
  `src/protocol/`, an id in `ProtocolId` (`spec.ts`), an entry in `registry.ts`.
  The registry is a `Record<ProtocolId, Protocol>`, so a missing entry is a compile
  error.
- `ProtocolSpec` is plain readonly data because it crosses into worklets via
  `processorOptions` (structured clone). Derived values are free functions in
  `protocol/spec.ts`, never methods. All numbers live in the spec.
- `src/band/band-plan.ts` is **fixed channel numbering**: a pure function of
  (band, spec). A band carries *up to* a fixed `channelCount` spread evenly
  across it; a protocol too wide for all of them still gets as many as fit
  (`effectiveChannelCount`), spread the same way - a band disappears for a
  protocol (`bandFits`/`bandsFor`) only once not even one channel fits, not
  merely because it can't fit all of them. Channel n (plan-wide, 1-based,
  ascending in frequency across `BANDS`) starts at
  `bandLowHz + (n - firstNumber) * channelSpacingHz(spec, band)`. No sample rate or runtime state, so every client agrees. Channel numbers
  from different protocols do not line up; a number only means something together
  with a protocol id.
- **Six protocols are registered:** `gfsk8-normal` (below), `gfsk8-medium` (12.5 baud,
  6.32 s frames in 10 s slots, 100 Hz channels, +-1.5 s; reliable to -14 dB) and
  `gfsk8-fast`, the same codec, Costas sync and modulator at 25 baud: 0.04 s symbols,
  3.16 s frames in 5 s UTC slots, 200 Hz channels, clock allowance +-0.9 s (it must also
  cover speaker and mic latency). Its first over-the-air try did not decode (signal
  audible); suspects at the time: room echo against 0.04 s symbols, latency + clock
  beyond the old +-0.5 s allowance. Since widened to +-0.9 s, the user has since used
  Fast over the air regularly in the ultrasonic band at a few metres and it decodes
  reliably; the allowance widening is the leading candidate for the fix but this was
  not isolated against the room-echo theory. The chat status line now reports the best
  sync score and dt per slot when nothing decodes (noise scores ~0.23, a real frame
  0.3+). Three times the throughput, about 6 dB less sensitive (measured, 48 kHz,
  unknown timing: reliable to -11 dB in 2500 Hz, 11/12 at -12 and -13, 4/12 at -14,
  never a wrong payload; ~150 ms to decode a window). The
  low band (100..300 Hz) only just holds one 200 Hz channel (edge to edge, no guard
  margin at all), so `bandsFor(spec)` keeps the band but with 1 channel instead of 3;
  its other two channel numbers are skipped. The user picks the protocol in Settings;
  it applies after a page reload, and both stations must match.
  The demodulator keeps 32 baseband samples per symbol and scales its filter, frequency
  grid and suppression window with the baud rate, so its cost per window is the same
  going faster than Normal. Two protocols go the other way, slower and more sensitive:
  `gfsk8-long` (Long, half Normal's baud: 3.125, 25.28 s frames in 30 s slots, 25 Hz
  channels, same +-2 s clock allowance as Normal) and `gfsk8-deep` (Deep, a quarter of
  Normal's baud: 1.5625, 50.56 s frames in 60 s slots, 12.5 Hz channels, +-3 s clock
  allowance, the widest of any protocol here). Both are narrow enough to fit every band
  at its full channel count, unlike Medium and Fast (2 and 1 low-band channels rather
  than 3). Measured (48 kHz, unknown timing, nominal
  frequency, never a wrong payload): Long reliable to -21 dB in 2500 Hz (19/24 at -22, 3/12
  at -23, 0/24 at -24), Deep reliable to -23 dB (23/24 at -24, 8/12 at -25, 4/24 at -26,
  0/24 at -28) - both track the ~3 dB-per-halved-baud prediction closely. Going below
  Normal's baud, the "cost per window is the same" claim above stops holding: the
  anti-alias filter needs more taps as the transition band narrows with baud, and the
  frequency search (`FREQ_SEARCH_HZ`, a fixed +-5 Hz floor, not scaled down like the step
  is) needs more hypotheses, since sound-card ppm drift doesn't shrink along with the
  tone spacing. Measured per-window decode time in Node: ~2 s for Long, ~3 s for Deep
  (Normal's own per-channel figure is the ~0.3 s below). Accepted for now; revisit
  `FREQ_SEARCH_HZ`'s scaling if the cost becomes a real problem (e.g. for an always-on
  control channel). Not yet tried over the air.
  A sixth, `gfsk8-turbo` (Turbo, 8x Normal's baud: 50, 1.58 s frames in a 2.5 s slot,
  400 Hz channels), goes faster than Fast - genuinely too wide for the low band (its
  entire 200 Hz width is half this protocol's own bandwidth; no channel-count trick
  helps), but the ultrasonic band still holds 8 of its usual 10 channels at ~442 Hz
  spacing, and the audible band keeps all 4 (its lowest channel starts right at the
  300 Hz floor, squarely audible). A testing
  tool for nearby devices, not a mode meant for daily use, both because of that and
  because its clock allowance (+-0.45 s) is the tightest here, likely tighter than the
  +-0.5 s Fast itself originally shipped with before real-world problems widened it to
  +-0.9 s - expect Turbo to need both stations' clocks closely synced. Measured (48 kHz,
  unknown timing, nominal frequency, never a wrong payload): reliable to -9 dB in
  2500 Hz (15/24 at -10, 2/24 at -11, 0/24 at -12) - a smaller sensitivity loss than
  extrapolating from Medium/Fast predicted (~-7 to -8 dB expected). Cost is the cheapest
  of any protocol here to decode (~0.2 s/window in Node, faster than Normal's own
  ~0.3 s), since the demodulator's cost-scaling favours going faster, not slower (see
  above). Tried over the air: works well in the ultrasonic band between two devices
  in the same room, with a repeater also active. Real-world numbers seen: SNR down to
  -9 dB on individual frames (right at the measured reliable floor, still decoding
  correctly) and clock offset a steady +0.22..+0.25 s, comfortably inside the +-0.45 s
  allowance (about half of it spent) - the tight clock allowance has not been a
  problem for two nearby, similarly-clocked devices. The Network screen's channel
  table also confirms `effectiveChannelCount` end to end: exactly channels 8-15 show
  up for this protocol in the ultrasonic band, not the usual band's 8-17.
- `src/protocol/gfsk8/` is the first protocol. The spec and **modulator** are real
  (Gaussian 8-FSK, BT 2.0, continuous phase, rendered on the fly per block so the
  worklet never stalls; `tests/gfsk8-modulator.test.ts` decodes the tones back out at
  44.1/48/96 kHz and checks leakage). The **codec** is real too (77 payload bits +
  CRC-14 -> LDPC(174,91) -> Gray-mapped 8-FSK symbols + Costas sync; soft decode by
  belief propagation). Ideal-timing loopback through the modulator decodes down to
  about -18 dB SNR in 2500 Hz (falls off -19..-20, never a wrong payload). The
  **demodulator** is real too (`gfsk8/demodulator.ts`): mix the channel to baseband,
  decimate to 200 Hz, sliding 8-tone DFT over +-2 s of start time and +-5 Hz of
  frequency, score the Costas sync, hand the best 8 candidates to the codec. The full
  receiver decodes down to -18 dB reliably (-19: 10/12, -20: 1/12), with unknown timing
  and frequency, never a wrong payload, and reports SNR within 0.3 dB in that range.
- RX path: mic -> `slot-rx` worklet (`SlotRecorder`, only copies samples) -> one window
  of 16.64 s per 15 s slot -> `decoder.worker.ts` (Web Worker, ~0.5 s per window) ->
  frames. Analysis never runs on the audio or UI thread. Slots are UTC-aligned
  (`protocol/slot-clock.ts`); `AudioEngine` re-anchors audio clock to wall clock every
  slot. The anchor's wall time is `Date.now()` minus the output timestamp's age, never
  `performance.timeOrigin + performanceTime` (performance.now() stops while a phone sleeps, so that sum
  lags real time by every suspend: seconds on Android). The receive grid is moved later by
  input + output latency (`rxLatencySec`: `baseLatency + outputLatency` + the mic track's `latency`
  setting where the browser reports it), since the anchor maps a sample to when it leaves the speaker.
  Waterfall slot lines follow the slot offset, and rows are timed minus `spectrumLagMs` (mic latency +
  half the 8192-point FFT). Check: with "Decode while sending" on, our own frames' dt should be ~0. TX is aimed at the next slot boundary, so both stations need correct UTC time
  (+-2 s).
- `src/chat/` is the chat layer, all pure (no audio, no DOM, time = UTC slot index).
  `charset6.ts`: 6-bit upper-case text code. `frames.ts`: the four 77-bit frame kinds
  (first / next / ack / hello; bit layout in its header): 10-bit station ids, 4-bit
  message ids, up to 16 frames = 142 chars per message (7 chars in the first frame,
  9 in later ones; only the first names the destination). `session.ts`: `ChatSession`
  splits, reassembles, acks and retransmits. Stop and wait: a station that transmits
  is deaf, so it sends nothing new while an ack is due. Directed messages are acked
  (bitmap of frames heard, doubles as a nack, sent at once after the highest-index
  frame or after 3 quiet slots); broadcasts are never acked. Sender resends only what
  the bitmap lacks, up to 4 rounds, then `failed`. A complete ack goes out twice, `ackRepeatGapSlots` (2,
  plus the pacing gap) apart, unless the sender is heard with another message first; the sender's ack
  timeout is 5 + 2 = 7 slots, and after a delivery it holds its own frames through the repeat's slot. `resendAck(src, msgId, frames)` queues a full-bitmap ack by hand (ⓘ "Resend ACK" on a received directed
  message; the chat line keeps `ack: {src, msgId, frames}`, older lines find it in the frame log); a late ack still turns a `failed` message `delivered`. `ui/chat-panel.ts` pumps it: one
  frame per slot, aimed at the next boundary.
- `src/protocol/gfsk8/ldpc-tables.ts` is GENERATED from ft8_lib (MIT), whose tables
  come from WSJT-X (GPLv3). Attribution and the source commit are in its header;
  shipped under MIT like ft8_lib, attribution in README.md. Not JS8Call-compatible on
  purpose: no JS8 frame layout, Huffman text or CRC-12/(174,87) code.
- The codec refuses the all-zero payload (a valid codeword that BP converges to on
  noise) and returns `null`, never wrong data, when a frame cannot be decoded.
- TX path: `AudioEngine.sendFrame` -> `gfsk-tx` worklet (`src/dsp/worklets/`) ->
  `Gfsk8Modulator`. The Test signals panel drives it with `buildTestFrame` (real Costas
  sync positions, random tones, no data, no FEC) until the codec exists.

## Decisions taken by default (not yet confirmed with the user)

Revisit these if the user objects:

- **JS8-inspired, not wire-compatible with JS8Call.** Compatibility needs JS8's
  exact LDPC matrices, Costas tables and Huffman table.
- **Normal speed only:** 50 Hz wide channels in three bands, numbered continuously:
  low 100..300 Hz (3 channels, 1..3), audible 300..10000 Hz (4 channels, 4..7, ~3.2 kHz
  spacing), ultrasonic 17500..21000 Hz (10 channels, 8..17, 383 Hz spacing, ~333 Hz gaps;
  needs a 48 kHz or higher context). Most channels are ultrasonic: the user tried it over the
  air, it works well and is inaudible. The user picks one band at a time; the waterfall
  shows that band. 12.64 s frames in 15 s UTC-aligned slots. The UI warns if the device
  rate cannot carry the selected band (Bluetooth headsets can force 16 kHz).
- **Timing from the system clock (UTC slots),** decoder searches a bounded time
  offset (~±2 s). No listen-before-talk, no ACK/retry: a collision loses the frame.
- **Reference tones:** at the low edge, centre and high edge of each band (audible: 300 / 5150 /
  10000 Hz). Highest channels will be the weakest: speakers and mics roll off toward
  10 kHz, so test them between real devices.
- **Chat layer:** random 10-bit station ids plus an optional nickname (called "name" in the UI;
  code and storage keep `nickname`) announced with a hello frame (not callsigns); while it is unset a
  banner (`name-banner`, top of `main`) links to the Settings field; broadcast and directed messages; 6-bit text code (no
  lower case); acks for directed messages only.
- **Decode every channel of the band each slot** (setting "Listen on every channel", default on;
  off = only the selected one). Measured ~0.3 s per channel-window in Node, so ~3 s of worker
  time per 15 s slot for the 10 ultrasonic channels; 0 false frames in 200 noise windows.
  Keep per-`Demodulator` state small.

## ALE-style channel selection (no control channel)

Every station hears the whole band, so there is no rendezvous channel: a frame may go on any
channel and everyone decodes it. What ALE adds is *which* channel to use.
- `src/protocol/multi-decode.ts`: `decodeChannels` (worker) and `distinctFrames` (a strong
  signal leaks into neighbours; keep the strongest copy).
- `src/ale/lqa.ts`: `LqaTable`, per (station, channel) smoothed SNR, two kinds: *heard* (near
  end) and *reported* (the far end says it hears us; this is what matters for transmitting).
  A station that has reported anything is judged only by its reports; heard values are a
  docked fallback. `chooseChannel` = best worst-case over the destinations, random among
  channels within 3 dB of the best (avoids everyone piling on one). Congestion (the user saw clogging
  with 3 stations; fixed channels one per station worked best): `ale/channel-load.ts` counts distinct
  other transmitters per channel over the last 8 slots from the frame log (a repeat counts as its repeater);
  each docks a channel `LOAD_PENALTY_DB` (4), but only channels scoring `VIABLE_DB` (-15) may win on
  quietness; among ties the least busy wins; `prefer` keeps the channel last used for that destination
  (`ChatPanel.lastChannelFor`). No link data: `quietestChannel`, the selected one on a tie. Auto beacon off
  + a channel selected (`ChatPanel.setAutoSound(false)`): every frame, sounds included, goes on the selected
  channel, overriding auto channel and the sound rotation. Clicking the selected channel again (strip or
  waterfall, `toggleChannel` in `main.ts`) clears the selection. Retransmit rounds: a directed message's frames carry `msgId` and `round` (`TxOut`); with auto channel on and no pin, round 2+ goes on another channel than the rounds before (`ale/retry-channel.ts` `pickRetryChannel`: not yet used by that message, best viable ranked, else nearest the band middle), one channel per round (`ChatPanel.retryRounds`). A pinned channel overrides it. Not yet tried over the air. Retransmit rounds: a directed message's frames carry `msgId` and `round` (`TxOut`); with auto channel on and no pin, round 2+ goes on another channel than the rounds before (`ale/retry-channel.ts` `pickRetryChannel`: not yet used by that message, best viable ranked, else nearest the band middle), one channel per round (`ChatPanel.retryRounds`). A pinned channel overrides it. Not yet tried over the air.
- Reports travel in `ack` frames (channel 5 bits + SNR 6 bits, about the acked sender) and in
  `ctrl` subtype 1 "sound" frames (2 x station/channel/SNR, rotating over (station, channel)
  pairs, least recently reported first: reporting only the latest channel hid the good ones). A station
  not heard on any channel for 10 min (`reportSilenceSlots`, set in `main.ts` from the slot length; the
  graph fades it at the same age) is left out of sounds entirely; each pair must also be younger than
  `maxAgeSlots` (120 slots).
- Sound contents (`LqaTable.reportsToSend`): one report per station first, the station reported longest ago first, so a sound round covers every station before any second channel (the graph needs who hears whom before per-channel detail). A station's channel = the one reported longest ago among those within `REPORT_BAND_DB` (6) of its best; spare room in the sound goes to further channels, oldest first. Event sound (Auto beacon on, `ChatSession.setEventSounds`, called from `ChatPanel.setAutoSound`): a station heard direct for the first time, or after `reportSilenceSlots` of silence (`LqaTable.isNewStation`), queues a sound 1 + stationId % 3 slots later (different neighbours, different slots). Auto beacon is therefore keep-alive (timer) plus reply-to-new-stations. Not yet tried over the air.
- Probe: the Test button sends its sound with the `probe` flag (frame bit 57); auto sounds do not. Every station hearing a probe direct answers at once with a plain sound (no flag, so no chain) to the prober: no cooldown, no jitter, collisions ignored; the beacon gap does not apply to it. The answer's channel is chosen like any directed frame (best link to the prober with auto channel, else the selected channel; not the sound rotation), and its reports put the prober first (`reportsToSend(count, slot, first)`). Not yet tried over the air.
- `ChatSession.nextTxTo(slot)` returns `{payload, dst}`. A sound is queued with `sound()`, sent
  only when no message is in flight (never deafens us while waiting for an ack). Hellos and sounds (beacons) also wait for one quiet slot after any
  frame of ours (`beaconGapSlots`, default 2): held, not dropped; message frames, acks and repeats are not held. Panel picks
  the channel: sound = rotation `(stationId + n) % channels`; else best link; else the selected
  channel (the "home" fallback) or the middle of the band. Settings: auto announce interval (`announceIntervalMin`, default 5), auto channel (default on),
  auto sound (default on) every `autoSoundIntervalMin` minutes (select `auto-sound-interval` next to Auto beacon: 1, 2, 3, 5, 10, 15; default 5, was a fixed 1 min that crowded the band; "Test" restarts the wait), "Test" (button id `sound-button`, was "Test now"; "Auto beacon" = auto sound, renamed from "Auto test"), and a link quality table view.
- Slot grid offset: `AudioEngine.setSlotOffsetMs` moves receive windows and TX start against UTC (setting `slotOffsetMs`, clamped to 0.4 slot: 6 s in Normal). Sync section on the Network screen (was Clock; static HTML `sync-block`, moved by `LinkView.render` in below the Signal history (redraws pause while `clock-manual` has focus); the history chart has a labelled grid line every 5 min; All frames has a Since column; server check row (`sync-server-check`, `sync-server-auto` = setting `serverClockOff` inverted; the automatic check runs at startup and every 10 min unless off; after each check `updateClockBanner` (main.ts) shows `#clock-banner` when local - server minus our slot offset exceeds max(0.3 x the mode's clock allowance, uncertainty + 50 ms), with "Use server time" and a close button (closed = until reload; it hides itself once the clock is fine); the wording points at "no decodes but activity in the waterfall", `sync-server-use`), `ServerClock` (bounds local - server from each Date reply, then probes timed at the server's second tick; about half the round trip, measured ±8..33 ms against the local PHP server; drift = least squares over the last 30 checks), station clock table `sync-stations` (`stationClocks`: median offset + drift per station over 30 min, vs ours and vs server); state line, manual offset input `clock-manual` + Set, Back to UTC, hints list `clock-hints`). `chat/clock-hint.ts` (`clockHints`, pure) advises without any time server (no-network rule): all timed stations late/early alike = our clock is off (offer sync to their median); one off while the others are on time = its clock; one station only = ambiguous; near the edge of the search = warn; real sync (score >= 0.3) seen but not decoded at the window edge in 2+ recent slots (`ChatPanel.undecodedSyncs`) = suggest Deep decode, or a manual offset past the edge when it is on. `stationDelays(records, sinceMs)` skips repeated frames (repeater's timing). Deep decode (setting `deepDecode`, Network toggle `deep-decode`): `deepExtraSec(spec)` = min(3 s, slot/2 - 0.25 - maxTimeOffset) more each side (3 s Normal and Medium, 1.35 s Fast); the rx worklet rebuilds its `SlotRecorder(rate, spec, extraSec)` on an `extra` message and sends `leadSec` with each window; `Demodulator.decode(window, base, leadSec)` searches +-leadSec. The own-TX skip still uses the normal window. Tested: frames 4.9 s off decode at -10 dB with it. Decode time not measured; the window is 36% longer (16.64 -> 22.64 s in Normal), so expect about that much more. Each station row on the Network screen shows the median frame start against UTC slots (`stationDelays`, last 20 frames; `dtSec` in the frame log is against UTC, not our shifted grid) and a "Sync to this station" button that adopts it; "Back to UTC" resets. Sync ignores audio latency by design: it copies the peer's timing as we hear it. Not yet tried over the air.
- Network screen (nav item and screen id `network`; view class still `LinkView`), top to bottom: the activity lines (`activity-last` / `activity-next`, filled from `updateStatus` in `main.ts`: `ChatPanel.lastAction` = newest frame received from another station or sent (set on `onFrameDone`), `ChatPanel.nextAction()` = transmitting / waiting for the slot / ack due / repeats / announcement / waiting for an ack / message frames left / probe / listening, from `ChatSession.outlook()`, a read-only summary), the "Network options" block (`net-options`, collapsible; Test and Announce stay on its header), then a two-column row (`network-top`, stacks below 900 px): the network graph and the Channels block (`channel-block`: channel strip, waterfall, level sliders) (arrows in the direction a signal reaches; heard both ways = two arrows side by side, one per direction and each in its own level; heard one way = one arrow down the middle; bright white dashes (`graph-flow`, 4 on 8 off, 2.5 wide, 1.6 s cycle, off with reduced motion) drift along each arrow toward its head, phase kept across the 4 s rebuilds via a negative `animationDelay`; arrowheads a fixed 7 units, `markerUnits: userSpaceOnUse`, round-joined, the line ending inside the head so no butt end shows at the tip); below: stations (count, last packet; each row: left = big name or #id, status + time since, last seen; right = label/value details: signal with green/yellow/red level >= -12 dB, >= -18 dB, below; send-on channel; timing + Sync; relayed), history, Signal by channel (one table, a column per channel: "For everyone" worst-case row with the top three numbered, then they hear us / we hear them per station; cells in the shared green/yellow/red levels), All frames (`ui/frame-table.ts`: filters, selection, remove selected / remove all shown, "Copy selected" = tab-separated text to the clipboard, "Export all" = CSV of the whole log regardless of filters; both carry the full raw hex and the time in UTC and local, oldest first, from `chat/frame-export.ts`). Graph (legend only as the SVG's `<desc>`, no visible text; hover a station or a link for a tooltip (`graph-tip`, multi-line; links get a 14-unit-wide invisible `graph-hit` twin; the hovered item and a station's links light up via `graph-hot`; redraws pause while the pointer is on the graph)): a fixed honeycomb background (`hexGrid`; the drawn pattern is `hexBackground`, the same lattice carried `HEX_OVERFLOW` (260) units past the square on every side, the svg `overflow: visible` and `#map-block-body` clipping it, so it reaches the card's border whatever its size; pointy-top cells, dim like unlit LCD segments); each station lights one cell, coloured by time since last heard (`ageColor`: green for 10 s, then orange at 2 min, red at 5, grey at 10 min, the age taken in 10 s steps so the colour drops a notch every 10 s; the time inside the cell shows the same 10 s steps; drawn at `NODE_FILL_OPACITY` 0.7), with its emoji and under it the time since it was last heard inside ("30s", "4m", "2h"; updates with each 4 s redraw; cells are `NR` 30 units) and its nickname or #id above it (ours below); we are the white cell (only our emoji, our Settings nickname or #id under it; `hexGrid(W, NR, 16)` lifts our cell so that label fits) at the bottom centre (with no stations heard the map shows only us), others above. `layoutGraph` (pure spring layout: a stronger signal between two stations = a shorter link, strongest SNR of the pair either way via `snrLevel`; symmetrical fan start, nodes keep off links they are not part of) gives ideal spots, then `snapToHexGrid` centres the others on the vertical axis and gives each the nearest free cell (strongest link to us first, one empty cell between stations). Arrows run over the grid, under the nodes. With fewer than three other stations the map is cropped from the top (viewBox keeps the width, so cells and stations keep their size; only the height shrinks) and its card (`map-compact` on `#map-block`) no longer stretches to the Channels card. No drift; a node that changes cell glides there. A new frame in the frame log makes its station's cell glow with an expanding hexagon ring (ours = "me"; a repeat also lights the repeater); reduced motion keeps the glow only. Repeaters are hexagons with a second border inside. Graph edges come from our own heard/reported values plus `LqaTable.overheard` (a `sound` frame's reports about stations other than us; persisted in `LqaState.overheard`).
- The header no longer names the protocol; users pick a mode by name (Turbo, Fast, Medium, Normal, Long, Deep: `spec.label`): the Protocol selector reads "Normal · 8-GFSK 6.25 baud · 15 s slots" and the Help table shows the name with the letter in brackets. The one-letter code (A normal, B medium, C fast, L long, D deep, T turbo; `spec.letter`) is kept as normalised reference data, no longer the UI name. The sidebar station panel (`#audio-state.radio`, filled by `updateStatus` in `main.ts`) has two keys, `key-audio` and `key-tx`, that click the `audio-on` / `allow-tx` switches (so both places agree); their round lamps show the state (`data-audio` on/off; `data-tx` off / armed / preparing / onair; the Audio lamp flashes on each decode from another station, `lamp-flash`), then the state line, a countdown and the slot cadence bar; collapsed it keeps the lamps and the bar. The "Network options" column starts with the Audio toggle (`audio-on`, was the sidebar Start button) and Allow transmit (`allow-tx`, setting `allowTx`): the master switch, enforced in `AudioEngine` (`setTransmitAllowed`: `sendFrame` throws, `playTone` does nothing, turning it off cuts the frame and tone on air) and mirrored in `ChatPanel.canTransmit`, so messages, acks, hellos, sounds, repeats and the test tone all stop; queued frames wait. Band and Protocol selectors sit in the same column with the toggles (Test, Auto channel, Auto beacon, Repeater, Deep decode); the Channels block keeps the channel strip, waterfall and levels. "Reset to defaults" (`net-options-reset`, bottom of the block, needs a second click within 4 s) sets those toggles and selects back to `DEFAULT_SETTINGS` by firing each control's own change handler (protocol last, it reloads); Audio, the selected channel, timing and names are left alone. Announce (`.announce-button`) sits next to Test on the Network options header and in the Messages composer (it used to be in the sidebar). The sidebar collapses to a narrow rail (`sidebar-toggle`, setting `sidebarCollapsed`; on a phone it hides the status tile). Under the station tile, `.sidebar-tools`: **Rotate 180°** (`rotate-button`, also a switch in Settings `rotate-180`; setting `rotate180`, default off) turns the whole page upside down with CSS (`html.rotated body`, and `dialog[open]` itself since the top layer ignores the body's transform), for phones whose speaker and mic sit at the bottom edge and must point at the other stations while the system rotation will not flip; **Full screen** (`fullscreen-button`, Fullscreen API on `documentElement`, hidden where `document.fullscreenEnabled` is false, e.g. iPhone Safari). On a phone they are icon-only on the second bar line. Not yet tried on a real phone. Logo (sidebar `h1.logo`, and `public/favicon.svg`): the Costas sync pattern 3 1 4 0 6 5 2 as a 7-symbol x 8-tone dash matrix (inline SVG, `lm-on`/`lm-off`), then the lowercase wordmark; while the status tile is `status-sending`, the lit tones step white in symbol order (CSS only, off with reduced motion); collapsed, only the mark shows. When a packet is heard (`chat.onActivity`, same place as the Audio lamp flash) `blinkLogo` lights 4 random dark cells for ~0.7 s (`lm-rx`, off with reduced motion). If `syncPattern` changes, redraw both. Waterfall channel boxes: red = the channel our frame is on (`ChatPanel.sendingChannel`, while `engine.sending`), yellow = input overloaded there (also the strip cell, `channel-over`), blue = selected. Not yet tried over the air / between two browsers. Unmeasured: false-accept rate at 10
  channels beyond the 200 noise windows, and CPU on phones.

## Repeater mode (v1: one hop, flood)

- Wire: the last 3 payload bits of every frame are `via` (0 = direct, 1..7 = repeated by a
  repeater with tag `repeaterTag(id) = id % 7 + 1`); bit 73 of hello and sound = "sender is a
  repeater". `withVia`, `viaOf`, `frameKey` (payload without the tag) in `chat/frames.ts`. Old
  frames read as direct. The full repeater id does not fit (`next` has exactly 3 spare bits); a
  tag resolves to a station only when exactly one known repeater has it.
- `chat/repeater.ts` (`Repeater`, pure): repeats first/next/ack/hello heard direct from others,
  never sounds, its own frames, repeats (no loops) or frames addressed to itself; the same frame
  once per 5 slots; the repeat goes out 2 or 4 slots after it was heard (never 3), else dropped.
- `ChatSession`: `setRepeater(on)` (setting `repeater`, "Repeater" toggle on the Network screen;
  turning it on queues a sound). `nextTxTo` order: acks due, repeats, then own frames. While a
  repeater is present (flag or resolved tag within `repeaterMemorySlots`, or we are one) own
  frames are paced `paceGapSlots` (2) apart, acks wait 2 more slots and both ack timers grow by
  4. A repeated frame feeds LQA as the repeater's signal, never the sender's; a frame heard
  again within 5 slots (direct + repeated) is handled once. The sender counts its own frames
  heard back (`OutMessage.echoedFrames/echoedBy`); `InMessage.via` says which repeater.
- UI: stations heard only through a repeater are stations too (`ChatSession.relayedStations`, `RepeaterInfo.relayed`, kept 30 min like repeaters): status, last seen and a "Through" row on the Network screen and in Users; they stay out of channel ranking (no link quality of their own). Repeater badge and "frames through it" on station rows, double-bordered hexagon nodes and grey dotted
  "reached us through" lines in the graph (`LinkModel.repeaters/relays`), repeated frames
  marked in All frames. Repeater knowledge is not stored on its own: on load `ChatSession.replayHeard` replays the saved frame log (`audiochat:debug`, rx rows, oldest first) to relearn repeaters, relay paths, frames via and stations heard only through a repeater.
- Tests: `tests/repeater.test.ts` simulates real timing (decode in s+1, answer in s+2): A and C
  out of range of each other deliver a multi-frame directed message and its ack through R in
  round 1; without pacing it fails. Not yet tried over the air.

## Sprites (small pictures as network traffic)

A sprite is a 1x1..16x16 picture of fixed-palette colours (PICO-8, 16 colours; 1..4 bits per
pixel, 2..16 colours), sent as a head frame + up to 15 body frames: `ctrl` subtypes 2 and 3 in
`chat/frames.ts` (`spriteHead`, `spriteBody`; wire format in `network-protocol.md` §9). The design
goal is **partial reception**: raw pixels (no RLE), every body frame repeats `side` and `bpp`,
whole pixels per frame, in the 16x16 Bayer order (`pixelOrder`), so a lost frame leaves scattered
pixels and the first frames already show the whole picture coarsely.
- `chat/sprite.ts` (pure): `encodeSprite`, `SpriteAssembly` (frames in any order, `known` mask,
  `conflicts` = same `seq` with other data = reused message id), `fillHoles` (display only),
  `spriteColours(view, 'checker' | 'fill')`, `quantize`, storage strings (`pixelsToString`: one hex
  digit per pixel, `.` = never arrived). The Sprite type says `bpp`; the wire field is `depth` = bpp-1.
  `chat/sprite-gallery.ts`: default sprites as text rows (from the design page) + `parseRows`/`toRows`.
- `ChatSession.sendSprite(dst, sprite)`: same stop-and-wait, msgIds, ack bitmap, retransmit rounds,
  "Resend ACK" and repeater as text (`OutMessage.content`, `spriteData`). Receive: `spriteProgress`
  event per new frame (a snapshot `InMessage` with `sprite`, `framesGot`, `framesMask`, `partial`),
  `incoming` when complete, and once with `partial: true` when it times out incomplete (60 slots).
  `InMessage.uid` is per received message (a reused id gets a new one): the UI keys the chat line on it.
  `dst` is null when the head was not heard. A head naming someone else makes the session ignore that
  message's bodies too (`spritesForOthers`). Frames past the last, or of a shape over 16 frames, are dropped.
- UI: Sprite button in the composer opens the editor dialog (`ui/sprite-editor.ts`: size, colours,
  paint/erase, live frame count and airtime, "as sent" preview, rows-as-text, gallery); Send uses the
  composer's recipient. Chat lines draw a canvas (`ui/sprite-view.ts`) with "n of m frames" and fill in as
  frames arrive; a failed sent sprite reopens in the editor when its status is tapped. Settings > Sprites:
  `spritePixelSize` (2..40 px, default 10; sprites wider than the bubble shrink to fit) and `spriteHoles`
  (`fill` default = nearest received pixel, or `checker`). A sprite line stores `sprite` in `audiochat:chat`;
  restored lines are final. All frames lists `spriteHead`/`spriteBody`. Not yet tried over the air.

## History (Network screen, was "All frames")

Section `frames` (title "History") holds two parts. **Sequence** (`ui/history-view.ts`, model in `chat/sequence.ts`, pure, tests in `tests/sequence.test.ts`): the newest 80 frames of the frame log as a sequence diagram, newest at the bottom, view stuck to the newest unless the user scrolled up (`sync()` redraws on a log change, called every tick while the screen shows; `refresh()` on each 4 s render). Every station is a vertical line with a hexagon in its colour (same colour as its line in the signal history, `colorIndex`; us white), nickname and `#001`; the shared air ("audiomesh", public) is the centre line, stations split left and right of it (ours first). A frame = line from its sender to the air (solid), and for a directed one on from the air to the destination (dashed; later frames of a message find the destination from the first, `destOf`). A beacon also draws a dashed line to each station it reports. Colours: announcements and beacons teal (audiomesh), messages and sprites white, acks green. Our own frames heard back are left out. Styling: hairline rules (1 px), a hexagon in the sender's colour starts every line, an arrowhead ends it on the air and a hollow hexagon in the receiver's colour ends it on a station; an emoji per kind in the label (📣 announce, 📡 beacon, 🔎 probe, 💬 message, 🖼️ sprite, ✅ ack, `SeqEvent.icon`); a sprite frame draws the picture as far as it had arrived (`SeqEvent.sprite`, an assembly per `src:msgId`, `drawSprite` from `sprite-view.ts`, so a sprite fills in frame by frame down the diagram). A new frame draws its line from the sender, pops the hexagons, fades the words in, and flashes the sender's header hexagon (`seq-ping`); all off with reduced motion. A WhatsApp-style pill ("Today 14:32", "Yesterday 09:10", a date) before the first event, after 15 min of quiet (`BUBBLE_GAP_MS`) and at a day change; new rows slide in (`seq-new`, off with reduced motion). Columns have a minimum width (`COLUMN_MIN_PX`), past it the diagram scrolls sideways. **All frames** (`ui/frame-table.ts`) is the table below it, unchanged. Checked in headless Chrome with a seeded frame log; not yet with live traffic.

## Capture (decoder debugging)

Two levels. Settings > Network capture (`capture-feature`, setting `networkCapture`, default off) shows the **Capture** section on the Network screen (`capture-block`, hidden otherwise; turning it off stops and clears). There the **Start capture / Stop capture** button (`capture-toggle`) runs it, with the "Keep" select (`capture-mode`), Download all and Clear (`ui/capture-view.ts`; logic in `dsp/window-capture.ts`, WAV in `dsp/wav.ts`). Capturing itself is never stored: off at every start, stops by itself after 30 min, memory only (24 MB cap, oldest dropped). While on, `AudioEngine.setCaptureWindows` copies each window before it is handed to the worker and puts `window`/`leadSec`/`sampleRate` in the `DecodeResult`; `main.ts` wraps `engine.onDecoded` to offer it to `WindowCapture`. Keeps "sync >= 0.3 but nothing decoded" (default) or every window; never our own TX. "Sync" must also be level across the three Costas blocks: `SyncReport.blockImbalanceDb` (loudest block over the middle one; `SyncReport.blocks` = each block's own score) must be <= 3 dB. A window wider than the slot (Normal and slower, or Deep decode) always catches the tail of the previous slot's frame and the head of the next one; one loud Costas block scores 0.3-0.5 overall (the score is weighted by energy) and used to fill the capture list with windows that held no failed frame. Measured: frames and noise 0.0-1.3 dB (real captures 0.1-0.4), neighbour tails and heads 4.6-13.3 dB. With the filter off ("every window") such windows are flagged `partial` in the list. The Note field (`capture-note`, beside the button) is stamped on every window kept from then on (`CapturedWindow.note`, shown in the list, written to the `.json` as `note`; changing it does not touch windows already kept), for things like the transmit volume and distance of a level sweep. Download gives a `.wav` + `.json` pair per window (any protocol). `tests/replay-captures.test.ts` replays `./captures` (or `CAPTURES=dir`) through the current demodulator and prints frames, sync and time; skipped when empty. Analysis scripts and the research notes on real captures: `captures/` (local, git-ignored).

## Retransmission combining (decoder)

A retransmitted frame is bit-identical (frames are built per index, no round counter; a repeater's copy differs in the `via` bits and does not combine), so two failed receptions can be added before the LDPC. `src/protocol/combine.ts`: `CandidatePool` (lives in the decoder worker, per protocol and rate; forgets after 40 slots, 96 entries, at most 48 decode attempts per candidate) and `decodeChannelsCombining` (replaces `decodeChannels` in the worker). `Demodulator.lastUndecoded` = up to 3 candidates per channel and window that failed but had sync >= 0.27 (noise tops out near 0.23-0.25); `FrameCodec.decodeCombined(copies)` scales each copy's tone energies to the same mean, adds them and decodes (adding energies beat adding soft bits by ~0.5 dB). The pool pairs blindly: only receptions of earlier slots, with about the same start time against the slot grid (within max(0.75 symbol, 0.15 s): one sender's start wandered 0.11 s between three transmissions heard over the air), tried as pairs then triples, and the parity checks + CRC-14 are the judge, as for any candidate. A combined frame reports the best copy's SNR and `DecodedFrame.copies`; the chat line in the console says "(n copies combined)". `DecodeRequest.slotStartUtcMs` orders windows. Measured (Fast, 48 kHz, real sync search, AWGN): alone reliable to -11/-12 dB; two copies decode 10/12 at -15 dB (alone 0/12), three copies 9/12 at -16 dB; 0 frames from 12 windows of noise and different weak frames. `tests/combine.test.ts`; `tests/replay-captures.test.ts` shares one pool across captures (oldest first). What real captures showed (measurements, corrections, open questions, ideas) lives in `captures/CONCLUSIONES.txt`, a local folder that git ignores. The copies must arrive within the sender's resend timing (7 slots) and, for a pair to be tried, with the same timing (dt).

## Publish Network Stats (opt-in, MQTT)

Setting `publishStats` (Settings > Network stats, default off). On: `StatsClient` (`src/stats/stats-client.ts`) loads mqtt.js with a dynamic import (its own chunk, never fetched while off), connects to the fixed broker (`STATS_BROKER_URL` in `stats-record.ts`; the same host is in the CSP in `vite.config.ts` and in the HTTP header `router.php` sends (the stricter of the two wins, so a server that sends its own CSP must list it too): change all together, the broker is not user-configurable), subscribes to `audiomesh/v1/#` and publishes one JSON `StatsRecord` per frame we send or hear (`FrameLog.onAdd` -> `statsRecord`) to `audiomesh/v1/<band>/<protocol id>/<station id>`, QoS 0, best effort. **Metadata only** (pure code, `tests/stats-record.test.ts`): station ids, channel, SNR, dt, frame type, src/dst/msgId/via, and `detail` only for hello (nickname), sound (link reports) and ack (bitmap); never audio, message text or sprite pixels. Records from the broker are untrusted (`parseStatsRecord`). The **Stats** nav item (hidden unless on, `nav-stats`, screen `stats`; `src/stats/stats-view.ts`) shows the connection state, a circle map (arrow = frame heard, sender to hearer, coloured by SNR, last 10 min; `statsGraph`, pure) and a table of the newest 100 records, redrawn at most once a second. Turning it off disconnects and clears. Checked in headless Chrome (connects, CSP allows it); not yet with two real stations.

## Help screen

Fifth nav item (`data-screen="help"`, `screen-help`, static HTML in `index.html`, styles `.help-body` / `.help-table`): setup (name in Settings, Audio + Allow transmit, band and mode must match), a mode table (D/L/A/B/C/T: slot, time for a 142-character message = 16 slots, reliable floor from the measurements above, use case; C recommended for nearby devices), how to talk (listen first, Everyone, then directed once a station announced), what each screen shows, Network options, troubleshooting (same band + mode, Sync section, phones). The numbers are copied by hand: update the table if a protocol changes. On a phone the nav takes the first line of the bar (five items fit at 360 px), the logo and Audio/TX lamps the second; the table hides its Slot column below 700 px.

Nav dots (`updateDots` in `main.ts`, once a second): Network = age of the newest station heard (`LqaTable.newestHeardSlot`, or a station heard through a repeater): green up to 3 min, yellow up to 5, red up to 6, grey after (no network). The Sync section header has its own dot (`data-dot="sync"`, always visible, between the arrow and the title; set in `updateClockBanner`, independent of the warning bar being closed): red = clock off against the server, yellow = a slot offset (`slotOffsetMs` != 0) is being applied, green = no offset and no deviation, grey = no server check yet. Its tooltip says which.

## Persistence (localStorage, `src/storage/store.ts`)

Four independent keys, each cleared by its own button in Settings > Stored data: `audiochat:chat`
(chat lines; notices are session-only: never saved or restored (older builds saved them, those rows are skipped on load), and expire 5 min after they appeared on screen; stored already worded so restoring needs no session; sent messages still in
flight at reload show as "interrupted"), `audiochat:stations` (id -> nickname) and `audiochat:link`
(`LqaTable.serialize/restore`: smoothed SNR per station/channel plus raw decodes). Clearing chat keeps
stations and link stats. Saves are deferred (`DeferredSaver`) and flushed on page hide. Link evidence
older than `maxAgeSlots` (30 min) is kept but ignored and not shown. `audiochat:debug` holds the frame log (`chat/frame-log.ts`: per frame time, direction, channel, SNR, dt, payload hex; last 1000; decoded on display; old text-only rows are ignored).
Settings stay under `audiochat:settings`.

## Notifications (`src/ui/notifier.ts`, `public/sw.js`)

System notifications for a completed incoming message and for a station announcement (hello),
only while the page is hidden or unfocused. Opt-in: Settings checkbox `notifications`
(in `audiochat:settings`), permission requested from that click. `ChatPanel.notifier` is set in
`main.ts`; `showIncoming` and the `station` event call `notify`. They go through the service worker
(`registration.showNotification`) because Android Chrome rejects `new Notification()`; desktop falls
back to it. `sw.js` also makes the app work offline: the build (`precache` plugin in `vite.config.ts`) writes every emitted file into its `PRECACHE` list and a version from it (content-hashed names, so any change = new cache, old ones deleted on activate); `fetch` answers same-origin GETs cache-first, navigations fall back to `index.html`, everything else (HEAD for the Sync clock check, dev server) goes to the network untouched. It is registered on every start (`Notifier.init`), so the first visit needs a connection; a new build shows up on the reload after the new worker installed. No runtime requests added (CSP `worker-src 'self'` covers it). Checked in headless Chrome: page loads with the server down. It also focuses or opens the app on notification click. iOS Safari needs the page added to the home
screen (iOS 16.4+) and there is no web manifest yet. Nothing is pushed from a server, so a closed or
suspended tab notifies nothing. Not yet tried on a real phone.

## Testing in a real browser without a radio

Headless Chrome can stand in for a second station: launch it with
`--headless=new --remote-debugging-port=9222 --use-fake-device-for-media-stream
--use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=x.wav
--ignore-certificate-errors`, where the WAV (mono, 16-bit, 48 kHz) holds real frames
made with the modulator, one per 15 s slot, ~2 s into the slot. Turn Audio on (Network options) about
3 s before a slot boundary so the first window is whole. The file loops, so make its
length a multiple of 15 s. Note the fake device glitches at stream start, which shows
up as one low-SNR frame; that is the source, not the decoder.

## Open questions

Chat layer: the defaults above (ids + nicknames, 6-bit code) are unconfirmed. Transport: over-the-air
speaker+mic vs cable, which decides how much margin the design needs.

## Gotchas inherited from hellschreiber2026

- `getUserMedia` needs a secure context (`localhost` works, LAN `http://` does not).
  Over Tailscale, use `tailscale serve` for https (`vite.config.ts` allows `.ts.net`
  hosts for the dev server); a plain `http://100.x.y.z` address will not get a mic.
- `AudioContext` starts suspended; keep an explicit Audio toggle (Network options; it used to be a Start button in the sidebar).
- Load worklets with `?worker&url`; serve them with the right MIME type.

## Messages screen and station icons

Messages = conversation list on the left (`#users-view`, `ui/users-view.ts`: Public on top for messages addressed to nobody, then every known station, newest activity first) and the open conversation on the right. `ChatPanel.selectRecipient(id)` (BROADCAST = Public) opens a thread: chat lines carry `data-thread` (`threadOf`: `public` or the other station's id, derived from the stored `To: everyone` info line so old lines work) and the rest are hidden; notices show everywhere. The hidden `dst-select` still holds the recipient. The Users screen and its nav dot are gone.
Hello frames carry an icon: 8-bit index into `src/chat/emoji-table.ts` (frozen order = wire format) + present flag (bits 63..71). Default = `defaultIconIndex(stationId)`. `ChatPanel.iconOf(id)`; `label(id)` and Network names are prefixed with it. Setting `iconIndex` (-1 automatic), picker in Settings. Not yet tried over the air.
