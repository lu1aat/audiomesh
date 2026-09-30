/// <reference lib="webworker" />
/**
 * Transmit worklet. A thin shell around Gfsk8Modulator: message plumbing and
 * nothing else. Timing is by sample counting against `currentFrame`, never by
 * timers.
 *
 * Messages in:  {type:'send', symbols: Uint8Array, baseFreqHz, startSample?}
 *                 startSample is on this context's sample clock; omitted = start now
 *               {type:'stop'}
 * Messages out: {type:'done'} when a frame has finished playing
 */

import { Gfsk8Modulator } from '../../protocol/gfsk8/modulator';
import type { ProtocolSpec } from '../../protocol/spec';

interface SendMessage {
  type: 'send';
  symbols: Uint8Array;
  baseFreqHz: number;
  startSample?: number;
}
interface StopMessage {
  type: 'stop';
}
type TxMessage = SendMessage | StopMessage;

class GfskTxProcessor extends AudioWorkletProcessor {
  private readonly modulator: Gfsk8Modulator;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const spec = options.processorOptions.spec as ProtocolSpec;
    this.modulator = new Gfsk8Modulator(sampleRate, spec);
    this.port.onmessage = (event: MessageEvent<TxMessage>) => {
      const msg = event.data;
      if (msg.type === 'send') {
        // Synthesis allocates; doing it here keeps it out of process().
        this.modulator.schedule(msg.symbols, msg.baseFreqHz, msg.startSample ?? currentFrame);
      } else {
        this.modulator.cancel();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const wasBusy = this.modulator.busy;
    this.modulator.fill(out, currentFrame);
    if (wasBusy && !this.modulator.busy) this.port.postMessage({ type: 'done' });
    // Returning false would kill the processor for the session.
    return true;
  }
}

registerProcessor('gfsk-tx', GfskTxProcessor);
