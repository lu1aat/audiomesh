/// <reference lib="webworker" />
/**
 * Receive worklet: records the microphone into per-slot windows and ships each to
 * the UI thread. No analysis here; that is the decoder worker's job.
 *
 * Messages in:  {type:'origin', sample}   a slot boundary, on this context's sample clock
 *                {type:'extra', sec}       widen the windows by this much each side (deep decoding)
 * Messages out: {type:'window', slotIndex, samples, leadSec}   samples is transferred, not copied
 */

import { SlotRecorder } from '../slot-recorder';
import type { ProtocolSpec } from '../../protocol/spec';

type InMessage = { type: 'origin'; sample: number } | { type: 'extra'; sec: number };

class SlotRxProcessor extends AudioWorkletProcessor {
  private recorder: SlotRecorder;
  private readonly spec: ProtocolSpec;
  private origin: number | null = null;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.spec = options.processorOptions.spec as ProtocolSpec;
    this.recorder = new SlotRecorder(sampleRate, this.spec, Number(options.processorOptions.extraSec) || 0);
    this.port.onmessage = (event: MessageEvent<InMessage>) => {
      const m = event.data;
      if (m.type === 'origin') {
        this.origin = m.sample;
        this.recorder.setSlotOrigin(m.sample);
      } else if (m.type === 'extra') {
        // A new window size: a fresh recorder (allocates, but only on this rare message, never in process()).
        // The slot being recorded is lost; the next whole window comes out as usual.
        this.recorder = new SlotRecorder(sampleRate, this.spec, m.sec);
        if (this.origin !== null) this.recorder.setSlotOrigin(this.origin);
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input) {
      const window = this.recorder.process(input, currentFrame);
      if (window) {
        this.port.postMessage({ type: 'window', slotIndex: window.slotIndex, samples: window.samples, leadSec: this.recorder.leadSec }, [
          window.samples.buffer,
        ]);
      }
    }
    // Returning false would kill the processor for the session.
    return true;
  }
}

registerProcessor('slot-rx', SlotRxProcessor);
