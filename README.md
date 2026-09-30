# audiomesh

*[Leer en español](./README.es.md)*

**[▶ Open the live app](https://lu1aat.github.io/audiomesh/)** — runs in
your browser, nothing to install.

A small acoustic network that runs entirely in the browser, using the speaker and
microphone as the radio. Stations exchange messages, announcements, link
tests and repeats over sound: audible, low-frequency or ultrasonic (17.5–21 kHz,
inaudible to most people).

It borrows the weak-signal techniques of amateur-radio digital modes such as FT8
and JS8: 8-GFSK modulation, Costas sync arrays, LDPC(174,91) forward error
correction and UTC-aligned time slots. The default mode decodes frames down to
about −18 dB SNR in 2500 Hz.

No backend, no account, no upload. Audio is processed in the tab and never leaves
the device; a Content Security Policy blocks every network request except one
optional same-origin clock check.

## Features

- **Six modes**, from fast to deep: T (turbo, 2.5 s slots), C (fast, 5 s),
  B (medium, 10 s), A (normal, 15 s), L (long, 30 s) and D (deep, 60 s). Slower
  modes are more sensitive, down to about −23 dB for mode D; mode T only reaches
  about −9 dB and is meant for testing between nearby devices. All stations must
  use the same mode.
- **Three bands** with fixed channel numbering: low (100–300 Hz), audible
  (300–10000 Hz) and ultrasonic (17.5–21 kHz, needs a 48 kHz sound card).
- **Messages**: broadcast and directed messages up to 142 characters, acknowledged and
  retransmitted for directed messages; nicknames announced over the air.
- **Every channel decoded at once**, with ALE-style automatic channel choice
  based on measured link quality in both directions, and congestion avoidance.
- **Repeater mode**: any station can relay frames one hop for stations that cannot
  hear each other.
- **Network view**: station map, signal by channel, waterfall, frame log and clock
  sync tools (slots are UTC-aligned, so clocks must agree within about ±2 s).

The full over-the-air specification (modulation, FEC, band plan, timing, frame
formats, repeater and channel selection) is in
[`network-protocol.md`](./network-protocol.md).

## Usage

Open the app on two devices within earshot of each other, pick the same mode and
band on both, turn **Audio** on and **Allow transmit**, then send a message.
Make sure both clocks are right (the Sync section on the Network screen helps).

The microphone needs a secure context: `https://`, or `localhost`.

## Development

Requires Node.js 20+.

```bash
npm install
npm run dev         # vite dev server on :5173
npm run test        # vitest
npm run build       # typecheck and build into dist/
```

`dist/` is a static site and works from any static file host. `./web.sh` builds it
and serves it over https on the local network with PHP's built-in server and a
self-signed certificate, for testing between phones and computers.

Stack: TypeScript, Vite, Web Audio with `AudioWorklet`s and a Web Worker for
decoding. No UI framework and no runtime dependencies.

## License

[MIT](./LICENSE).

The LDPC(174,91) parity tables in `src/protocol/gfsk8/ldpc-tables.ts` are generated
from [ft8_lib](https://github.com/kgoba/ft8_lib) (MIT, © 2018 Karlis Goba). The
code was designed by the WSJT-X authors (Joe Taylor K1JT, Steve Franke K9AN and
Bill Somerville G4WJS) for [WSJT-X](https://wsjt.sourceforge.io/). audiomesh is
inspired by JS8Call but is not wire-compatible with it.
