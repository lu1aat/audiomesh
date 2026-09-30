/**
 * Audio in and out.
 *
 *   mic -> analyser                       spectrum display
 *       -> slot-rx worklet -> windows -> decoder worker -> frames
 *   gfsk-tx worklet -> gain -> speakers   transmit, aimed at a slot boundary
 *   oscillator -> gain -> speakers        test tone
 *
 * The rate is always read from the live context: sound cards report 44100, 48000
 * and occasionally 96000, and hardcoding one puts every channel at the wrong
 * frequency.
 *
 * Slots are tied to the wall clock. The audio clock and the wall clock are related
 * by one anchor (getOutputTimestamp), which is how a slot boundary in UTC becomes a
 * sample index for the worklets. The anchor maps a sample to when it leaves the
 * speaker; a microphone sample with the same index was heard earlier, by the
 * input + output latency, so the receive grid is moved by that much (`rxLatencySec`).
 */

import DecoderWorker from '../dsp/decoder.worker.ts?worker';
import type { DecodeRequest, DecodeResponse } from '../dsp/decoder.worker';
import rxWorkletUrl from '../dsp/worklets/slot-rx.worklet.ts?worker&url';
import txWorkletUrl from '../dsp/worklets/gfsk-tx.worklet.ts?worker&url';
import type { ChannelDecode } from '../protocol/multi-decode';
import { nextSlotStartMs, slotStartMs } from '../protocol/slot-clock';
import { deepExtraSec, frameDurationSec, windowDurationSec, windowLeadSec, type ProtocolSpec } from '../protocol/spec';
import { TxSchedule } from './tx-schedule';

/** 8192 points is ~5.9 Hz per bin at 48 kHz: fine enough to resolve 50 Hz channels. */
const FFT_SIZE = 8192;

/**
 * Fade time constant for the test tone. setTargetAtTime reaches ~99% in 5 time
 * constants, so this is a ~25 ms ramp: slow enough to avoid a broadband click on
 * start/stop, fast enough to feel immediate. Same reasoning as the raised-cosine
 * gating a real transmission needs.
 */
const TONE_RAMP_TC_SEC = 0.005;

/** Same idea for the frame level: never step a gain while a carrier is playing. */
const LEVEL_TC_SEC = 0.02;

/** A transmission aimed at a boundary closer than this is moved to the next one. */
const MIN_TX_LEAD_MS = 300;

export interface DecodeResult {
  /** Wall-clock start of the slot these frames were heard in. */
  readonly slotStartUtcMs: number;
  /** One entry per listened channel; empty when none was listened to, so nothing was analysed. */
  readonly channels: readonly ChannelDecode[];
  /** Time the worker spent on all channels of the slot. */
  readonly decodeMs: number;
  /** Largest absolute sample of the window (1 = full scale) and how many samples sat at full scale (clipping). */
  readonly peak?: number;
  readonly clipped?: number;
  /** This station was transmitting during the window: its own loud signal is in the microphone. */
  readonly ownTx?: boolean;
  /** Only while capture is on (setCaptureWindows): the window's audio, its lead and the sample rate. */
  readonly window?: Float32Array;
  readonly leadSec?: number;
  readonly sampleRate?: number;
  readonly error?: string;
  /** Set when the slot was not analysed because this station was transmitting in it. */
  readonly skipped?: 'sending';
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private tone: { osc: OscillatorNode; gain: GainNode } | null = null;
  private tx: { node: AudioWorkletNode; gain: GainNode } | null = null;
  private rx: AudioWorkletNode | null = null;
  private micError: string | null = null;
  private decoder: Worker | null = null;
  private frameBusy = false;
  private starting: Promise<void> | null = null;
  private listenBaseHzs: readonly number[] = [];
  private decodeWhileSending = false;
  private deepDecode = false;
  private captureWindows = false;
  private txAllowed = true;
  private inputLatencyCache: number | null = null;
  private inputLatencyAtMs = -Infinity;
  private readonly txSchedule = new TxSchedule();
  private slotOriginWallMs = 0;
  /** Our slot grid is the UTC grid moved by this much, to match another station's clock. */
  private slotOffsetMs = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { slotStartUtcMs: number; ownTx: boolean; window?: Float32Array; leadSec?: number; sampleRate?: number }>();
  private spectrum = new Float32Array(FFT_SIZE / 2);

  /** Called when a frame sent with sendFrame has finished playing. */
  onFrameDone: () => void = () => {};
  /** Called once per slot, after that slot's audio has been analysed. */
  onDecoded: (result: DecodeResult) => void = () => {};

  constructor(private readonly spec: ProtocolSpec) {}

  get sending(): boolean {
    return this.frameBusy;
  }

  /** False when the microphone could not be opened: the station can still send. */
  get hasMic(): boolean {
    return this.stream !== null;
  }

  /** Why the microphone could not be opened; null when it is open. */
  get micErrorText(): string | null {
    return this.micError;
  }

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Must be called from a user gesture: browsers keep AudioContext suspended until then. */
  start(): Promise<void> {
    // A second call while the first waits on the mic permission prompt must not open a second stream.
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    // No microphone is not fatal: the station still transmits. `micError` says why there is none.
    this.micError = null;
    try {
      // Outside a secure context (https or localhost) the browser removes
      // navigator.mediaDevices altogether, so the failure would otherwise be a
      // baffling "cannot read properties of undefined".
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('microphone access needs a secure context: open the page via https:// or http://localhost');
      }
      // Chrome's echo cancellation, noise suppression and AGC are built for speech
      // and all three mangle steady FSK tones: the symptom is a signal that fades
      // out mid-frame. Keep them off.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.stream = null;
      this.micError = err instanceof Error ? err.message : String(err);
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.4;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -30;
    const source = this.stream ? ctx.createMediaStreamSource(this.stream) : null;
    source?.connect(analyser);

    await ctx.audioWorklet.addModule(txWorkletUrl);
    await ctx.audioWorklet.addModule(rxWorkletUrl);

    const txGain = ctx.createGain();
    txGain.gain.value = 0;
    const txNode = new AudioWorkletNode(ctx, 'gfsk-tx', {
      numberOfInputs: 0,
      outputChannelCount: [1],
      processorOptions: { spec: this.spec },
    });
    txNode.port.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === 'done') {
        this.frameBusy = false;
        this.onFrameDone();
      }
    };
    txNode.connect(txGain).connect(ctx.destination);
    this.tx = { node: txNode, gain: txGain };

    let rxNode: AudioWorkletNode | null = null;
    if (source) {
      rxNode = new AudioWorkletNode(ctx, 'slot-rx', {
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { spec: this.spec, extraSec: this.deepDecode ? deepExtraSec(this.spec) : 0 },
      });
      rxNode.port.onmessage = (event: MessageEvent<{ type: string; slotIndex: number; samples: Float32Array; leadSec: number }>) => {
        if (event.data.type !== 'window') return;
        this.handleWindow(event.data.slotIndex, event.data.samples, event.data.leadSec);
        // The audio clock and the wall clock drift apart (tens to hundreds of ppm);
        // re-measure their relation every slot so the grid follows the wall clock.
        this.rx?.port.postMessage({ type: 'origin', sample: this.rxSampleAtWallMs(this.slotOriginWallMs + this.slotOffsetMs) });
      };
      this.rx = rxNode;
      source.connect(rxNode);
      // A node nobody pulls on may never be processed. Route its (silent) output
      // through a muted gain to the destination so it stays live.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      rxNode.connect(mute).connect(ctx.destination);

      this.decoder = new DecoderWorker();
      this.decoder.onmessage = (event: MessageEvent<DecodeResponse>) => this.handleDecoded(event.data);
    }

    this.ctx = ctx;
    this.analyser = analyser;
    await ctx.resume();

    // Anchor the slot grid: the most recent slot boundary, as a sample index.
    const slotMs = this.spec.slotSec * 1000;
    const anchor = this.anchor();
    this.slotOriginWallMs = Math.floor(anchor.wallMs / slotMs) * slotMs;
    rxNode?.port.postMessage({ type: 'origin', sample: this.rxSampleAtWallMs(this.slotOriginWallMs + this.slotOffsetMs) });
  }

  async stop(): Promise<void> {
    this.stopTone();
    this.frameBusy = false;
    this.tx = null;
    this.rx = null;
    this.decoder?.terminate();
    this.decoder = null;
    this.pending.clear();
    this.txSchedule.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }

  get slotGridOffsetMs(): number {
    return this.slotOffsetMs;
  }

  /**
   * Move the slot grid (receive windows and transmit start) against UTC, e.g. to
   * line up with a station whose clock or audio delay differs. Applies at once.
   */
  setSlotOffsetMs(ms: number): void {
    this.slotOffsetMs = ms;
    this.rx?.port.postMessage({ type: 'origin', sample: this.rxSampleAtWallMs(this.slotOriginWallMs + ms) });
  }

  /**
   * Whether to analyse slots in which this station was itself transmitting. Off by
   * default: the receiver hears its own signal far louder than anyone else's.
   */
  setDecodeWhileSending(enabled: boolean): void {
    this.decodeWhileSending = enabled;
  }

  /**
   * Deep decoding: search deepExtraSec(spec) further on both sides of the usual time
   * window, for a station whose clock is off by more than the protocol allows. Costs
   * about a third more decoder time per slot. Applies from the next whole window.
   */
  setDeepDecode(enabled: boolean): void {
    this.deepDecode = enabled;
    this.rx?.port.postMessage({ type: 'extra', sec: enabled ? deepExtraSec(this.spec) : 0 });
  }

  /**
   * The channels to decode, each as the frequency of its tone 0; empty to stop
   * decoding. Cost grows linearly: ~0.3 s of worker time per channel per slot.
   */
  setListenChannels(baseHzs: readonly number[]): void {
    this.listenBaseHzs = [...baseHzs];
  }

  /**
   * Start transmitting a frame of channel symbols at the next slot boundary, tone
   * 0 at `baseFreqHz`. `level` is linear gain, 0..1. Returns the wall-clock time
   * (ms since the epoch) the frame will start.
   */
  sendFrame(symbols: Uint8Array, baseFreqHz: number, level: number): number {
    if (!this.ctx || !this.tx) throw new Error('audio is not started');
    if (!this.txAllowed) throw new Error('transmitting is turned off');
    const startMs = nextSlotStartMs(Date.now() - this.slotOffsetMs, this.spec, MIN_TX_LEAD_MS) + this.slotOffsetMs;
    this.txSchedule.add(startMs, startMs + frameDurationSec(this.spec) * 1000);
    this.setFrameLevel(level);
    this.frameBusy = true;
    this.tx.node.port.postMessage({
      type: 'send',
      symbols,
      baseFreqHz,
      startSample: Math.round(this.sampleAtWallMs(startMs)),
    });
    return startMs;
  }

  setFrameLevel(level: number): void {
    if (!this.ctx || !this.tx) return;
    this.tx.gain.gain.setTargetAtTime(level, this.ctx.currentTime, LEVEL_TC_SEC);
  }

  /**
   * The master switch for everything this station sends: frames and the test tone.
   * Off also silences whatever is on the air now. Checked here, at the one place
   * sound is made, so no feature can get round it.
   */
  setTransmitAllowed(allowed: boolean): void {
    this.txAllowed = allowed;
    if (!allowed) {
      this.cancelFrame();
      this.stopTone();
    }
  }

  get transmitAllowed(): boolean {
    return this.txAllowed;
  }

  /** Fade out first, then stop the modulator: cutting a carrier mid-cycle clicks. */
  cancelFrame(): void {
    if (!this.ctx || !this.tx || !this.frameBusy) return;
    const { node, gain } = this.tx;
    this.frameBusy = false;
    this.txSchedule.endLatestAt(Date.now());
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, TONE_RAMP_TC_SEC);
    // UI-thread timer is fine here: it only silences, it does not place a signal in time.
    setTimeout(() => node.port.postMessage({ type: 'stop' }), TONE_RAMP_TC_SEC * 10 * 1000);
  }

  get toneFreqHz(): number | null {
    return this.tone ? this.tone.osc.frequency.value : null;
  }

  /**
   * Play a steady sine, or retune and re-level it if one is already playing.
   * `level` is linear gain, 0..1. Requires start() first.
   */
  playTone(freqHz: number, level: number): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error('audio is not started');
    if (!this.txAllowed) return;
    const now = ctx.currentTime;
    if (!this.tone) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.frequency.value = freqHz;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      this.tone = { osc, gain };
    } else {
      // Phase stays continuous across a retune; no reset, so no click.
      this.tone.osc.frequency.setValueAtTime(freqHz, now);
    }
    this.tone.gain.gain.setTargetAtTime(level, now, TONE_RAMP_TC_SEC);
  }

  stopTone(): void {
    const ctx = this.ctx;
    const tone = this.tone;
    if (!ctx || !tone) return;
    this.tone = null;
    const now = ctx.currentTime;
    tone.gain.gain.setTargetAtTime(0, now, TONE_RAMP_TC_SEC);
    // Stop once the fade has finished, then release the nodes.
    tone.osc.stop(now + TONE_RAMP_TC_SEC * 10);
    tone.osc.onended = () => {
      tone.osc.disconnect();
      tone.gain.disconnect();
    };
  }

  /** Magnitude in dB per FFT bin, or null before start. The buffer is reused. */
  getSpectrum(): Float32Array | null {
    if (!this.analyser || !this.stream) return null;
    this.analyser.getFloatFrequencyData(this.spectrum);
    return this.spectrum;
  }

  // --- clock -----------------------------------------------------------------

  /**
   * One matched pair: a wall-clock instant and the audio sample index leaving the
   * speaker at it.
   *
   * The wall clock is Date.now(), with the timestamp's age taken off it. Never
   * performance.timeOrigin + performanceTime: performance.now() stops while a phone
   * sleeps, so that sum falls behind the real time by every suspend since the page
   * loaded (seconds on Android), and the station sends and listens that late.
   */
  private anchor(): { wallMs: number; sample: number } {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp();
    const perfNow = performance.now();
    const wallNow = Date.now();
    if (ts.contextTime && ts.performanceTime) {
      return { wallMs: wallNow - (perfNow - ts.performanceTime), sample: ts.contextTime * ctx.sampleRate };
    }
    // No timestamp yet (playback not really begun): the sample being rendered now
    // reaches the speaker one output latency later.
    return { wallMs: wallNow, sample: (ctx.currentTime - this.outputLatencySec) * ctx.sampleRate };
  }

  /** Rendering to the speaker, as the browser reports it (0 where it does not). */
  get outputLatencySec(): number {
    const ctx = this.ctx;
    return ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
  }

  /** Microphone to the audio graph, as the browser reports it (Chrome does); null where unknown (then taken as 0). */
  get inputLatencyReportedSec(): number | null {
    if (!this.stream) return null;
    const now = performance.now();
    // getSettings() allocates: asked at most once a second, not every animation frame.
    if (now - this.inputLatencyAtMs > 1000) {
      this.inputLatencyAtMs = now;
      const latency = (this.stream.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined)?.latency;
      this.inputLatencyCache = typeof latency === 'number' && Number.isFinite(latency) ? latency : null;
    }
    return this.inputLatencyCache;
  }

  get inputLatencySec(): number {
    return this.inputLatencyReportedSec ?? 0;
  }

  /** How much later than the anchor says a microphone sample was heard: input + output latency. */
  get rxLatencySec(): number {
    return this.inputLatencySec + this.outputLatencySec;
  }

  /** The microphone sample index of what reached the microphone at `wallMs`. */
  private rxSampleAtWallMs(wallMs: number): number {
    return this.sampleAtWallMs(wallMs) + this.rxLatencySec * this.ctx!.sampleRate;
  }

  /** How far the spectrum lags the air: microphone latency plus half the FFT window. */
  get spectrumLagMs(): number {
    return (this.inputLatencySec + FFT_SIZE / 2 / this.sampleRate) * 1000;
  }

  private sampleAtWallMs(wallMs: number): number {
    const a = this.anchor();
    return a.sample + ((wallMs - a.wallMs) / 1000) * this.ctx!.sampleRate;
  }

  // --- receive ---------------------------------------------------------------

  private handleWindow(slotIndex: number, samples: Float32Array, leadSec: number): void {
    const slotStartUtcMs = slotStartMs(slotIndex, this.spec) + this.slotOriginWallMs + this.slotOffsetMs;
    const listen = this.listenBaseHzs;
    // Our own transmission is judged against the usual window, even when deep decoding
    // reads a wider one: else every slot before one we send in would be skipped.
    const windowStartMs = slotStartUtcMs - windowLeadSec(this.spec) * 1000;
    const windowEndMs = windowStartMs + windowDurationSec(this.spec) * 1000;
    // Windows only move forward, so anything that ended well before this one is done with.
    this.txSchedule.forgetBefore(windowStartMs - this.spec.slotSec * 1000);
    if (!this.decodeWhileSending) {
      if (this.txSchedule.overlaps(windowStartMs, windowEndMs)) {
        this.onDecoded({ slotStartUtcMs, channels: [], decodeMs: 0, skipped: 'sending' });
        return;
      }
    }
    if (listen.length === 0 || !this.decoder || !this.ctx) {
      this.onDecoded({ slotStartUtcMs, channels: [], decodeMs: 0 });
      return;
    }
    const id = this.nextRequestId++;
    const ownTx = this.txSchedule.overlaps(windowStartMs, windowEndMs);
    // The window is handed to the worker (detached), so a capture must copy it first.
    this.pending.set(id, this.captureWindows
      ? { slotStartUtcMs, ownTx, window: samples.slice(), leadSec, sampleRate: this.ctx.sampleRate }
      : { slotStartUtcMs, ownTx });
    const request: DecodeRequest = {
      id,
      protocolId: this.spec.id,
      sampleRate: this.ctx.sampleRate,
      baseFreqsHz: listen,
      window: samples,
      slotStartUtcMs,
      leadSec,
    };
    this.decoder.postMessage(request, [samples.buffer]);
  }

  /** Keep a copy of each window's audio in the DecodeResult (for the Capture section); off by default. */
  setCaptureWindows(on: boolean): void {
    this.captureWindows = on;
  }

  private handleDecoded(response: DecodeResponse): void {
    const meta = this.pending.get(response.id);
    if (!meta) return;
    this.pending.delete(response.id);
    if (response.ok) {
      this.onDecoded({ ...meta, channels: response.channels, decodeMs: response.decodeMs, peak: response.peak, clipped: response.clipped });
    } else {
      this.onDecoded({ ...meta, channels: [], decodeMs: 0, error: response.error });
    }
  }
}
