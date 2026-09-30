# Network protocol specification

This document specifies **audiomesh's acoustic network layer only**: modulation,
framing, FEC, band plan, timing, the over-the-air frame formats, repeating, and
ALE-style channel selection. It does **not** cover the chat application built on
top (message splitting into multiple frames, the 6-bit text charset, retry/ARQ
policy, nicknames as a UI concept, notifications, persistence, or the UI itself)
— see `src/chat/` and `CLAUDE.md` for that layer. The boundary is the decoded
77-bit frame payload: everything up to and including that payload, plus how a
station decides which channel to use and whether to repeat a frame, is "network."
What a `first`/`next` frame's text bytes mean as a chat message is "app."

Source of truth is the code; line/file references below point at it. Numbers
here are derived from `src/protocol/spec.ts`, `src/protocol/gfsk8/spec.ts` and
`src/band/band-plan.ts` — never hand-copy a number from this document into code,
import the deriving function instead.

## 1. Layering

```
audio  <->  Modulator / Demodulator  <->  FrameCodec  <->  77-bit frame payload
                (src/protocol/gfsk8/          (src/protocol/gfsk8/    (this document
                 modulator.ts,                 codec.ts)               stops here)
                 demodulator.ts)
```

- `src/protocol/protocol.ts` defines the `Protocol` interface (`FrameCodec`,
  `Modulator`, `Demodulator`) that every protocol implements.
- `src/protocol/spec.ts` defines `ProtocolSpec`, a plain readonly data object
  (it crosses into `AudioWorklet`s via `processorOptions`, so it must stay
  structured-cloneable) plus free functions that derive everything else. Numbers
  live only in the spec; derived values are never re-declared elsewhere.
- `src/protocol/registry.ts` is a `Record<ProtocolId, Protocol>` mapping the
  three registered protocol ids to their implementation, so a missing entry is a
  compile error. Multi-protocol is the design.
- `src/band/band-plan.ts` sits beside the protocol and only needs the spec: it
  assigns fixed channel numbers, independent of sample rate or runtime state, so
  every client numbers the spectrum identically.

Only one protocol family is implemented: `gfsk8` (8-GFSK). It is JS8/FT8-style
but **not wire-compatible with JS8Call**: this project's own choice of Costas
sync pattern (free to change; nothing external interoperates with it), no JS8
frame layout, no Huffman text code — but the LDPC(174,91) generator matrix
itself is not original, it's copied/generated from `ft8_lib`/WSJT-X (§12).

## 2. Modulation (physical layer)

8-GFSK: 8 orthogonal, non-coherent, continuous-phase FSK tones, Gaussian-filtered
(`src/protocol/gfsk8/modulator.ts`).

- **Tone spacing = baud rate** (the JS8/FT8 convention: orthogonal non-coherent
  FSK needs tone spacing equal to the symbol rate). `bitsPerSymbol = log2(8) = 3`.
- **Pulse shaping**: Gaussian, bandwidth-time product `BT = 2.0`, pulse spans 3
  symbols (±1.5 symbols half-span). Copies centred one symbol apart sum to
  exactly 1, so a run of identical symbols gives a perfectly flat tone. This is
  the FT8 choice: about as narrow as it gets while keeping tones separable.
- **Continuous phase**: the transmitted signal's instantaneous frequency is the
  sum of overlapping Gaussian pulses; phase is the running integral of that
  frequency. There is never a hard tone switch or phase discontinuity at a
  symbol boundary, so there is no click/splatter from switching.
- **Amplitude ramp**: 1/8 of a symbol raised-cosine fade in/out at the start and
  end of a frame only (frequency trajectory is held flat at the edges).
- **Rendering**: samples are synthesized on the fly, block by block, from a
  small running state (symbol index + phase) — never the whole ~600k-sample
  frame up front — so the modulator can never stall the audio thread. Output is
  peak-normalized to 1; actual level is set by a downstream gain node.
- **Occupied bandwidth** = `toneCount × toneSpacingHz` = 8 × baud.

## 3. Frame structure and forward error correction

One physical frame = 79 GFSK symbols (`src/protocol/gfsk8/codec.ts`):

```
symbols:  [ sync(7) ][ data(29) ][ sync(7) ][ data(29) ][ sync(7) ]
indices:    0..6       7..35       36..42     43..71      72..78
```

- **Costas sync**: three 7-symbol blocks at fixed positions (symbol index 0, 36,
  72), pattern `[3, 1, 4, 0, 6, 5, 2]` (this project's own choice, not FT8's —
  free to change since nothing external interoperates with it). 21 sync symbols
  total, used only for timing/frequency acquisition, never carry data.
- **Data**: the remaining 58 symbols × 3 bits/symbol = **174 bits** — exactly
  the LDPC codeword length.
- **FEC chain**: `77 payload bits → + CRC-14 → 91 information bits → LDPC(174,91)
  → 174-bit codeword → 58 symbols (3 bits each) → Gray-mapped to tones`.
  - **CRC-14** (`src/protocol/gfsk8/crc14.ts`): polynomial `0x2757`
    (`x^14+x^13+x^10+x^9+x^8+x^6+x^4+x^2+x+1`), initial value 0, MSB first. The
    payload is zero-extended to 82 bits before the CRC is taken (the source
    comment says "exactly as the reference does" without naming it, but this is
    the same FT8/WSJT-X CRC-14 convention as the LDPC tables), so the 14 CRC
    bits land after the 77 payload bits to make the 91-bit LDPC information
    word.
  - **LDPC(174,91)** (`src/protocol/gfsk8/ldpc.ts`, tables in
    `ldpc-tables.ts`): systematic code, 91 information bits followed by 83
    parity bits. Decoding is sum-product belief propagation on the parity-check
    graph, soft-input (LLR convention: positive = "probably 1"), up to 30
    iterations, buffers preallocated so `decode()` allocates nothing.
  - **Gray mapping**: 3 codeword bits → tone index via
    `GRAY_TO_TONE = [0,1,3,2,5,6,4,7]` (bits MSB-first index into this table).
    Neighbouring tones differ in exactly one bit, so the most likely receive
    error — energy landing in the adjacent tone — costs one bit, not up to
    three.
- **Refusal, not corruption**: the codec never returns a wrong payload. If BP
  fails to converge to a codeword with zero failed parity checks, if the CRC
  doesn't match, or if the decoded bits are all zero (a valid codeword BP
  converges to on pure noise — never a real frame), `decode()` returns `null`.
  Empirically: never a wrong payload observed down to -19/-20 dB SNR in
  loopback and full-receiver tests.

## 4. Protocol variants

Six registered protocols, same codec/Costas/modulator family, different baud
rates (`src/protocol/gfsk8/spec.ts`). The user picks one in Settings; it applies
after a page reload, and **both stations must use the same protocol**. Four
speed up from Normal (Medium, Fast, Turbo); two slow down from it (Long, Deep) —
bandwidth is just `8 × baud`, so choosing a mode is really choosing one number,
baud, and everything else (frame duration, slot length, sensitivity) follows.

| | Normal (A) | Medium (B) | Fast (C) | Long (L) | Deep (D) | Turbo (T) |
|---|---|---|---|---|---|---|
| `id` | `gfsk8-normal` | `gfsk8-medium` | `gfsk8-fast` | `gfsk8-long` | `gfsk8-deep` | `gfsk8-turbo` |
| Baud / tone spacing | 6.25 Hz | 12.5 Hz | 25 Hz | 3.125 Hz | 1.5625 Hz | 50 Hz |
| Symbol duration | 0.16 s | 0.08 s | 0.04 s | 0.32 s | 0.64 s | 0.02 s |
| Frame on air (79 symbols) | 12.64 s | 6.32 s | 3.16 s | 25.28 s | 50.56 s | 1.58 s |
| Slot length | 15 s | 10 s | 5 s | 30 s | 60 s | 2.5 s |
| Clock allowance (`maxTimeOffsetSec`) | ±2 s | ±1.5 s | ±0.9 s | ±2 s | ±3 s | ±0.45 s |
| Receive window (frame + 2×allowance) | 16.64 s | 9.32 s | 4.96 s | 29.28 s | 56.56 s | 2.48 s |
| Deep-decode extra each side | 3 s | 3 s | 1.35 s | 3 s | 3 s | 0.55 s |
| Occupied bandwidth (8 tones) | 50 Hz | 100 Hz | 200 Hz | 25 Hz | 12.5 Hz | 400 Hz |
| Channel spacing (ultrasonic band) | ~383 Hz | ~377 Hz | ~366 Hz | ~386 Hz | ~387 Hz | ~442 Hz |
| Bands it fits (of 3·4·10 low·audible·ultrasonic) | all, full count | low 2/3, rest full | low 1/3, rest full | all, full count | all, full count | **no low; ultrasonic 8/10** |
| Throughput vs Normal | 1× | 1.5× | 3× | 0.5× | 0.25× | 6× |
| Sensitivity vs Normal | baseline (-18 dB reliable) | ~3 dB better than Fast | ~6 dB worse (measured: reliable to -11 dB in 2500 Hz; 11/12 at -12/-13 dB, 4/12 at -14 dB; never a wrong payload) | ~3 dB better (measured: reliable to -21 dB; 19/24 at -22, 3/12 at -23, 0/24 at -24; never a wrong payload) | ~5-6 dB better (measured: reliable to -23 dB; 23/24 at -24, 8/12 at -25, 4/24 at -26, 0/24 at -28; never a wrong payload) | ~9 dB worse (measured: reliable to -9 dB; 15/24 at -10, 2/24 at -11, 0/24 at -12; never a wrong payload) |

`payloadBits` (77), `toneCount` (8), `symbolCount` (79) and the Costas pattern
are identical across all six; only the baud rate (and therefore slot length,
clock allowance and channel width) changes. `deepExtraSec(spec)` =
`max(0, min(3, slotSec/2 − 0.25 − maxTimeOffsetSec))` — the search of one slot
must never reach into the next one's.

**A band's channel count bends before it breaks** (`effectiveChannelCount`,
§5): a protocol too wide for all of a band's channels still gets as many as
actually fit, evenly spread the same way — the band only disappears entirely
(`bandFits`/`bandsFor`) once not even one channel fits. This is why Medium (2)
and Fast (1) get a shrunken low band instead of none at all, and why Turbo
fits the ultrasonic band with 8 of its usual 10 channels (~442 Hz spacing)
even though its 400 Hz bandwidth is 8× the low band's own total width — that
one really is impossible regardless of channel count, since a single Turbo
channel alone needs twice the entire low band.

**Turbo is still a testing tool, not a daily-use mode**, despite fitting the
ultrasonic band: its *audible*-band channels remain genuinely audible (the
lowest starts right at the 300 Hz floor, squarely in the middle of human
hearing), and it's the only protocol whose clock allowance (±0.45 s) is
*tighter* than the ±0.5 s Fast originally shipped with before real-world
decode problems led to widening Fast to ±0.9 s (§4's over-the-air notes) —
Turbo should be expected to need both stations' clocks closely synced (e.g.
via the Sync feature) to decode at all, more so than any protocol below it.
Intended use: verifying the physical layer at high speed between two nearby,
easily-synced devices, not a mode for actual deployment.

Long and Deep keep Normal's frame-to-slot ratio (~84% frame, ~16% guard) by
scaling the clock allowance up roughly in step with the slot rather than
holding it fixed: Long reuses Normal's own ±2 s (baud halved, allowance
unchanged), Deep goes to ±3 s (`deepExtraSec`'s own absolute cap, reused here as
a baseline allowance rather than an add-on) — the most forgiving of clock
disagreement of any protocol here, which matters more than throughput for a
weak or badly-timed link. Both measured sensitivities track the ~3 dB-per-
halved-baud prediction closely (Normal → Long: -18 → -21, exactly 3 dB; Normal →
Deep, two halvings: -18 → -23/-24, close to the predicted 6 dB).

The receiver's demodulator cost per decode window is baud-independent **only
going faster than Normal** (Medium, Fast): it keeps 32 baseband samples per
symbol and scales its low-pass filter, frequency search grid and candidate-
suppression window with the baud rate (see §7). Going slower (Long, Deep)
that stops holding, for two compounding reasons: the anti-alias filter's tap
count is inversely proportional to baud (transition band narrows in absolute
Hz as baud drops), and the frequency-search hypothesis count grows too, because
`FREQ_SEARCH_HZ` (±5 Hz, covering sound-card ppm clock drift) is a fixed
absolute floor that does *not* shrink with tone spacing, while the search step
does — so a narrower grid needs more steps to cover the same fixed ±5 Hz.
Measured per-window decode time in Node (48 kHz): ~2 s for Long, ~3 s for Deep,
against Normal's own ~0.3 s per channel-window (§8). Accepted as-is for now;
`FREQ_SEARCH_HZ`'s scaling is the lever to pull if this cost becomes a real
problem later (e.g. an always-on control channel decoding continuously).

Notes from over-the-air testing: Fast's first try did not decode though the
signal was audible; suspects at the time were room echo against 0.04 s symbols
and/or clock/latency error exceeding the old ±0.5 s allowance. Since widened to
±0.9 s, Fast has since been used regularly over the air in the ultrasonic band
at a few metres and decodes reliably — the allowance widening is the leading
candidate for the fix, though this wasn't isolated against the room-echo
theory, so it's not certain the echo risk is gone at other distances/rooms.
Medium, Long and Deep have not yet been tried over the air. Normal has also
been tried over the air and works, especially in the ultrasonic band. Turbo
has too, between two devices in the same room in the ultrasonic band (with a
repeater also active): real frames decoded down to -9 dB SNR, right at its
measured reliable floor, and clock offset held steady around +0.22..+0.25 s —
comfortably inside its ±0.45 s allowance, so the tight clock budget (§4) has
not been a practical problem for two nearby, similarly-clocked devices. This
also field-confirms `effectiveChannelCount` (§5): the Network screen's channel
table showed exactly channels 8–15 for Turbo in the ultrasonic band, not the
band's usual 8–17.

## 5. Band plan and channel numbering

Pure function of `(band, spec)` — no sample rate, no runtime state — so every
client agrees without negotiation (`src/band/band-plan.ts`). Channel numbers
are 1-based, plan-wide (ascending in frequency across all bands), fixed per
protocol. **Channel numbers from different protocols do not correspond** — a
number only means something together with a protocol id, since a wider
protocol needs wider spacing — and even *which numbers exist* is protocol-
dependent: `channelCount` below is each band's maximum, offered in full only to
protocols narrow enough for all of it (§4 has the per-protocol actual counts).

| Band | Range | Channels (max) | Numbers (max) | Notes |
|---|---|---|---|---|
| low | 100–300 Hz | 3 | 1–3 | sparsest; small speakers barely reproduce it; only Normal/Long/Deep get all 3 — Medium 2, Fast 1, Turbo none (too wide even for one) |
| audible | 300–10000 Hz | 4 | 4–7 | audible to everyone; highest channels weakest (speaker/mic rolloff toward 10 kHz); every protocol gets all 4 |
| ultrasonic | 17500–21000 Hz | 10 | 8–17 | main band: inaudible, works well over the air; needs ≥~47 kHz audio context (48 kHz+); out of reach at 44.1 kHz; every protocol but Turbo (8 of 10) gets all 10 |

- A station listens to and transmits on **one band at a time**, chosen by the
  user; the waterfall shows that band.
- **Effective channel count**: `effectiveChannelCount(spec, band)` is the most
  channels of the band's own maximum that still spread out at least
  `bandwidthHz(spec)` apart — `min(channelCount, the largest count that fits)`,
  found by counting down from `channelCount` (fewer channels only ever fit more
  easily than more, since each gets a bigger share of a fixed width). 0 when not
  even one channel fits.
- **Channel spacing**: `channelSpacingHz = floor((bandHighHz − bandLowHz −
  bandwidthHz) / (effectiveChannelCount − 1))` — using the *effective* count,
  not necessarily the band's full one. `channelSpacingHz` throws a `RangeError`
  only when the effective count is 0 (not even one channel fits); when it's 1,
  spacing is 0 (nothing to space against) and that single channel may fill the
  band edge to edge with zero guard margin (Fast's low-band channel does
  exactly this; Medium's two low-band channels are packed edge to edge against
  each other too). Channels are otherwise spread evenly with gaps between them
  (not packed edge to edge) — deliberate, to tolerate the poor filtering and
  strong nearby signals of a speaker/mic path; the tight low-band cases are a
  physical consequence of the band being narrower than usual, not a departure
  from that design.
- **Channel n's base frequency** (tone 0): `bandLowHz + (n − firstNumber) ×
  channelSpacingHz`. The channel occupies `baseHz .. baseHz + bandwidthHz`.
  `channelAt` rejects a channel number once its index into the band exceeds
  `effectiveChannelCount` for that protocol, even though `bandForChannel`
  (spec-independent, purely structural) still says the number nominally
  belongs to that band.
- **`bandsFor(spec)`**: filters `BANDS` to the ones with at least one effective
  channel — a band is only dropped *entirely* once not even one channel fits
  (Turbo + low band: 400 Hz alone exceeds the band's whole 200 Hz width). A band
  that fits *some but not all* of its channels (Medium/Fast/Turbo in the low or
  ultrasonic bands) keeps the band with fewer channels instead; the numbers for
  channels that don't exist for that protocol are simply skipped (never reused
  for another band).
- **Reference/calibration tones**: low edge, centre, high edge of each band
  (audible band: 300 / 5150 / 10000 Hz).
- A lower device sample rate (e.g. a Bluetooth headset forcing 16 kHz) cuts off
  the upper bands entirely; the UI warns if the selected band can't be carried.

## 6. Slot timing and synchronization

`src/protocol/slot-clock.ts`: slots are pure UTC arithmetic, no negotiation.

- `slotIndex = floor(wallMs / (slotSec × 1000))` — slots start at multiples of
  `slotSec` since the Unix epoch (Unix time ignores leap seconds; every station
  does too), so any two stations with correct UTC clocks agree on slot
  boundaries without talking to each other.
- A transmission is aimed at the **next** slot boundary
  (`nextSlotStartMs(now, spec, minLeadMs)`), so both stations need roughly
  correct UTC time — within the protocol's clock allowance (§4).
- The receiver doesn't assume perfect alignment: it records a window starting
  `windowLeadSec = maxTimeOffsetSec` before the nominal slot boundary and
  lasting `windowDurationSec = frameDurationSec + 2 × maxTimeOffsetSec`, so a
  frame that starts up to `maxTimeOffsetSec` early or late is still whole
  inside the window. The demodulator then searches ±that much for the actual
  frame start (§7).
- **Deep decode** (opt-in, `deepExtraSec(spec)` further each side, §4): widens
  the recorded window and the search range for a station whose clock is off by
  more than the normal allowance. Tested: recovered a frame 4.9 s off at -10 dB.
- **Clock anchoring** (`src/audio/engine.ts`): the audio clock is re-anchored to
  the wall clock every slot. The anchor's wall time is always
  `Date.now() − (age of the output timestamp)`, never
  `performance.timeOrigin + performanceTime` — `performance.now()` stops while a
  phone sleeps, so that sum would lag real time by every suspend (seconds on
  Android).
- **Receive-grid latency compensation**: the receive window is moved later by
  `rxLatencySec = outputLatencySec (ctx.baseLatency + ctx.outputLatency) +
  inputLatencySec` (the mic track's own reported latency, where the browser
  exposes it), because the anchor maps a sample index to the moment it *leaves
  the speaker* — the mic hears it later by that much.
- A manual slot-grid offset (`slotOffsetMs`, clamped to 0.4 × slot length) lets
  a station nudge its receive windows and TX start against UTC without changing
  its system clock — a network-layer knob, distinct from the chat-layer "Sync"
  UI that helps a user find a good value for it.

## 7. Demodulation (receiver pipeline)

`src/protocol/gfsk8/demodulator.ts`. One channel per call; the full band is
"scanned" by calling this once per channel on the same captured window (§8).
Runs in a Web Worker, never the audio thread — it allocates and can take tens
to hundreds of milliseconds.

1. **Baseband conversion**: mix the channel (centred on the channel's tone
   range) down to 0 Hz, low-pass filter (odd-length Blackman-windowed sinc,
   unity DC gain, centre-tapped so there's no group delay to correct for) and
   decimate to **32 samples per symbol** (200 Hz at the reference 6.25 baud;
   the filter's transition/cutoff and the decimation ratio scale with
   `baud / 6.25` so cost per window is baud-independent). The filter passes the
   channel (±~30 Hz around centre at the reference rate) and rejects the
   neighbour channel, which decimation would otherwise alias on top of it.
2. **Sliding tone DFT**: for every candidate start position (one decimated
   sample = 1/32 symbol resolution) and a small set of frequency-offset
   hypotheses, measure the energy in each of the 8 tones over one symbol
   window. Frequency search: ±5 Hz around nominal, 1 Hz steps at the reference
   baud (11 hypotheses), scaled with baud so the worst-case sound-card clock
   mismatch loss stays under ~0.3 dB at any speed.
3. **Costas sync scoring**: for each (start, frequency) hypothesis, score =
   fraction of the 21 sync symbols' total tone energy that lands in the tones
   the sync pattern predicts. Pure noise scores ~0.23 (theoretical floor over a
   time/frequency search is a bit above 1/8); a real frame scores 0.3 or
   higher. `Demodulator.lastSync` exposes the best (score, timeOffsetSec) seen
   even when nothing decodes, for diagnostics.
4. **Candidate selection**: take the best 8 (start, frequency) candidates by
   sync score; after picking one, suppress every hypothesis within a quarter
   symbol of its start (same frame, different frequency guess) so the next-best
   distinct candidate can surface.
5. **Codec decode**: read all 79 symbols' tone energies at each candidate and
   hand them to `FrameCodec.decode()` (§3). The CRC/LDPC/all-zero checks are the
   final judge — a wrong sync candidate is simply refused, never accepted as
   corrupt data. Duplicate payloads across candidates are collapsed.
6. **SNR estimate**: once a payload is known, its symbols are known, so signal
   energy = energy in the correct tone per symbol, noise = mean energy in the
   other 7 tones. Reported in a 2500 Hz reference bandwidth (the standard
   weak-signal convention), accurate within 0.3 dB from -19 to -14 dB
   (measured against added white noise), saturating near +5 dB for strong
   signals (the modulator's own spectral skirts put a little energy in the
   other tones). Also drops correctly when the audio itself is damaged
   (dropouts, clipping).

Measured full-receiver sensitivity (Normal, unknown timing and frequency):
reliable to -18 dB SNR (-19: 10/12 trials, -20: 1/12), never a wrong payload,
SNR reported within 0.3 dB in that range. Ideal-timing loopback through just
the modulator/codec reaches about -19..-20 dB. See §4 for Fast's measured
numbers.

## 8. Multi-channel decode and deduplication

`src/protocol/multi-decode.ts`. The receiver hears the whole band at once —
there is no rendezvous/control channel — so "scanning" a band means calling
`Demodulator.decode()` once per channel against the same captured audio window,
which costs CPU, not time. Setting "Listen on every channel" (default on)
controls whether every channel of the selected band is decoded each slot, or
only the one selected for transmit; measured ~0.3 s per channel-window in
Node — ~3 s of worker time per 15 s slot for the 10 ultrasonic channels in
Normal, with 0 false frames observed across 200 noise windows.

A strong signal leaks into neighbouring channels, so the same frame can decode
on more than one channel. `distinctFrames()` keeps only the strongest-SNR copy
of each distinct payload across all channels of the window, sorted strongest
first.

## 9. Wire frame format (the network's PDU)

Everything above produces or consumes one **77-bit payload** per frame — the
seam this document stops at (`src/chat/frames.ts` defines what fills those
bits; encoding/decoding is `encodeFrame`/`decodeFrame`, kept below the "app"
line only in the sense that message splitting and text semantics build on top
of it). All bits are MSB-first.

Every frame starts with a 2-bit **kind** and the 10-bit **id** of the sending
station (`src`, range 1..1023; 0 is reserved to mean "everyone"/broadcast as a
destination, and is never a valid `src`, which also guarantees a chat frame is
never the all-zero payload the codec refuses to accept as real):

```
first  kind 0 | src 10 | msgId 4 | last 4 | dst 10 | 7 chars x 6 bit     (5 bits spare)
next   kind 1 | src 10 | msgId 4 | seq 4  |          9 chars x 6 bit     (3 bits spare)
ack    kind 2 | src 10 | dst 10  | msgId 4 | received 16 (bitmap, bit i = frame i heard)
              | heardChannel 5 | heardSnr 6   (how the acked station was last heard)
ctrl   kind 3 | src 10 | subtype 3 | subtype body
         subtype 0 = hello: 8 chars x 6 bit nickname
         subtype 1 = sound: 2 x (station 10 | channel 5 | snr 6), station 0 = unused slot
```

Fixed tail bits, present (as spare/zero) in every kind so old frames still
parse:

- **bit 73** — `hello` and `sound` only: set when the sender is itself a
  repeater.
- **bits 74–76** — **`via`**: `0` = sent by `src` directly; `1..7` = repeated,
  tagged with the repeater's tag (see §10). Since `next` frames end exactly at
  bit 73, 3 bits is all the room there is anywhere.

Other wire-format notes:

- **SNR fields** are whole dB, offset by 30 and clamped to a 6-bit code
  (`code 0..63 ↔ -30..+33 dB`). **Channel fields** are 5 bits (`MAX_CHANNEL =
  31`); channel 0 means "unknown".
- `heardChannel`/`heardSnr` on an `ack`, and the two `(station, channel, snr)`
  reports on a `sound`, are how a station tells another which channel and SNR
  it was last heard at — the wire-level input to link-quality tracking (§11).
- The codec (`src/protocol/gfsk8/codec.ts`) requires exactly `PAYLOAD_BITS = 77`
  bits; `frames.ts` throws if a value doesn't fit its field width.

What sits above this line — splitting a chat message across `first`/`next`
frames up to `MAX_FRAMES = 16` (142 chars: 7 in the first frame, 9 in each
later one), the stop-and-wait retry/ack policy, the 6-bit text charset, message
ids and reassembly — is the **chat application layer** (`src/chat/session.ts`,
`charset6.ts`) and is out of scope here.

## 10. Repeater mode (one-hop flood)

`src/chat/repeater.ts`, pure logic — no audio, no wall clock; time is a UTC
slot index. One hop only: a repeat is never itself repeated.

- **Tag**: `repeaterTag(stationId) = stationId % 7 + 1` (range 1..7, `via`'s 3
  bits). Because the full repeater id doesn't fit in `via`, a tag only resolves
  back to a specific station when exactly one known repeater currently holds
  it.
- **What gets repeated**: `first`, `next`, `ack` and `hello` frames heard
  **direct** (`via == 0`) from another station. Never: `sound` frames (a sound
  measures one specific link — a repeated copy would misattribute it), the
  repeater's own frames, already-repeated frames (loop prevention — `via != 0`
  is never re-offered), or frames addressed to the repeater itself.
- **Deduplication**: the same frame (identified by its payload with the `via`
  tag stripped, `frameKey()`) heard again within `DEDUP_SLOTS = 5` slots is not
  queued twice.
- **Timing**: a frame heard in slot `s` is decoded during `s+1` (worker
  latency), so the earliest a repeat can go out is `s+2`. This depends on a
  chat-layer cooperation: while a repeater is known to be present,
  `ChatSession` (app layer, `paceGapSlots = 2`) spaces a station's own frames
  3 slots apart (`s, s+3, s+6, ...`) instead of every slot, so a repeat can be
  scheduled at `s+2` or `s+4` **only** — never `s+3`, which would collide with
  the sender's own next frame (during which the repeater, itself transmitting,
  is deaf).
  Anything the repeater hasn't sent by `s+4` is dropped (`MAX_AGE = 4`). Queue
  is capped at 16 pending repeats, oldest dropped first if exceeded.
- **Destination tracking**: to decide the destination of a `next` frame's
  repeat (only relevant for channel selection, since a repeat itself is
  broadcast at the wire level via the `via` tag, not addressed), the repeater
  remembers each `(src, msgId) → dst` from the `first` frame for
  `MSG_MEMORY_SLOTS = 120` slots.
- **Loop safety**: because `via != 0` frames are never re-offered and `via` is
  a flat repeater tag (not a hop-count or path list), this design supports
  exactly one hop. A frame that has already been repeated once will not be
  repeated again by any repeater that hears it.

## 11. ALE-style channel selection (no control channel)

There's no rendezvous channel — every station decodes the whole band (§8), so a
frame may go out on any channel. What's needed instead is *which* channel to
pick. This is link-quality analysis (LQA), `src/ale/lqa.ts` and
`src/ale/channel-load.ts`, pure logic keyed by UTC slot index.

**Two kinds of evidence**, both smoothed exponentially in dB
(`smoothing = 0.5` weight on a new sample, evidence older than
`maxAgeSlots = 120` slots — 30 min at Normal's 15 s slot — is ignored though
kept in storage):

- **heard** — *we* decoded `station` on `channel` at this SNR (near end).
- **reported** — `station` told *us* (via an `ack`'s `heardChannel`/`heardSnr`,
  or a `sound` frame's report list) that it hears *us* on `channel` at this SNR
  (far end).

The far end is what matters for choosing a transmit channel — speakers, mics
and rooms differ, so A hearing B well doesn't imply B hears A well. A station
that has reported *anything* is judged only by its reports; a station that has
reported nothing at all falls back to its heard value minus
`RECIPROCITY_PENALTY_DB = 3` (assuming rough reciprocity, docked for the
uncertainty).

**Channel scoring & selection** (`chooseChannel`):

1. `rankChannels(to, channels, slot)`: for each candidate channel, the
   worst-case `txScore` over every destination in `to` (a station with no
   evidence on that channel scores `UNKNOWN_SNR_DB = -10`); channels nothing is
   known about on any destination are dropped entirely.
2. Take the best-scoring channel's score as `best`.
3. **Congestion avoidance** (`src/ale/channel-load.ts`): `channelLoad()` counts
   distinct other transmitters heard per channel over the last
   `LOAD_WINDOW_SLOTS = 8` slots (from the frame log; a repeated frame counts
   as its repeater, not the original sender). Each distinct transmitter docks a
   channel `LOAD_PENALTY_DB = 4` — but a channel may only win *because* it's
   quieter if it still scores at least `VIABLE_DB = -15` on link quality alone
   (the decoder's reliable floor is around -18 dB); if nothing scores that
   well, only raw link quality counts.
4. Channels within `TIE_DB = 3` dB of the best (post-load) are considered tied;
   among ties, the least busy wins; among *those* ties, the channel already in
   use for this destination (`prefer`) is kept (stations settle rather than
   hop), else one is picked at random (spreads load instead of everyone piling
   onto the single best channel).
5. With **no link evidence at all**, `quietestChannel()` falls back to pure
   congestion: least busy, ties broken toward a "home" channel, then by
   channel number.

**Reports travel over the air** two ways: in every `ack` (one report, about the
station being acked) and in `sound`/`ctrl` frames (two reports per frame,
rotating: `reportsToSend()` returns the `(station, channel)` pairs reported
*longest ago* first, so repeated sounds eventually cover every known station on
every channel it's been heard on — reporting only the latest channel would hide
the others). A station not heard on *any* channel for
`reportSilenceSlots = 40` slots (10 min at 15 s) is left out of sounds
entirely — its link is presumed dead, and reporting it would keep it alive in
other stations' view of the network.

**Third-party links**: `LqaTable.overheard()` records what a `sound` frame says
about a pair of *other* stations (neither of them us), giving a listener
partial visibility into links it isn't part of, without needing its own
evidence.

## 12. Provenance and licensing note

`src/protocol/gfsk8/ldpc-tables.ts` (the LDPC(174,91) generator matrix) is
**generated from `ft8_lib`** (MIT-licensed), whose tables in turn come from
**WSJT-X** (GPLv3). Attribution and the source commit are recorded in that
file's header. The licensing implications of shipping GPLv3-derived table data
have not been resolved and should be revisited before any public release.

## 13. What's deliberately out of scope here

These live above the frame-payload boundary and belong to the chat application,
not the network:

- Message splitting/reassembly across multiple `first`/`next` frames, and the
  6-bit uppercase-only text charset (`src/chat/charset6.ts`).
- `ChatSession`'s stop-and-wait ARQ policy: ack timing/timeouts, retry rounds,
  `failed`/`delivered` message states (`src/chat/session.ts`).
- Nicknames as a concept (the wire-level `hello` frame carries 8 chars; what a
  station *does* with a nickname is app/UI).
- Notifications, persistence format for chat lines, the frame-log UI, the
  network graph, and clock-sync UI/UX (though the *requirement* that both
  stations' clocks agree within the protocol's clock allowance, §6, is a
  network-layer fact).
