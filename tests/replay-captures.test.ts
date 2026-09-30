/**
 * Replays windows saved from the Capture section (Network screen > Capture > Download)
 * through the real demodulator. Put the .wav and .json pairs in ./captures (or set
 * CAPTURES=dir) and run: npx vitest run tests/replay-captures.test.ts
 * Skipped when there are none. Prints, per window, what the capture saw on the air
 * against what this build decodes now, so a decoder change can be judged on real audio.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWav16 } from '../src/dsp/wav';
import { CandidatePool, decodeChannelsCombining } from '../src/protocol/combine';
import { distinctFrames } from '../src/protocol/multi-decode';
import { getProtocol, isProtocolId } from '../src/protocol/registry';

const dir = process.env.CAPTURES ?? 'captures';
/** One pool per protocol across the files, oldest first, so consecutive windows of one retransmission combine. */
const pools = new Map<string, CandidatePool>();
const metas = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];

describe.skipIf(metas.length === 0)('replay captured windows', () => {
  for (const file of metas) {
    it(file, () => {
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      expect(isProtocolId(meta.protocolId)).toBe(true);
      const wav = decodeWav16(readFileSync(join(dir, file.replace(/\.json$/, '.wav'))));
      expect(wav.sampleRate).toBe(meta.sampleRate);
      const demodulator = getProtocol(meta.protocolId).createDemodulator(meta.sampleRate);
      const t0 = performance.now();
      const protocol = getProtocol(meta.protocolId);
      let pool = pools.get(meta.protocolId);
      if (!pool) pools.set(meta.protocolId, (pool = new CandidatePool(protocol.createCodec(), protocol.spec)));
      const channels = decodeChannelsCombining(demodulator, pool, wav.samples, meta.baseFreqsHz, meta.leadSec, meta.slotStartUtcMs);
      const ms = performance.now() - t0;
      const heard = distinctFrames(channels);
      const synced = channels.filter((c) => (c.sync?.score ?? 0) >= 0.3).map((c) => `${c.baseFreqHz.toFixed(0)}Hz:${c.sync!.score.toFixed(2)}`);
      console.log(`${file}${meta.note ? ` [${meta.note}]` : ''}: ${heard.length} frame(s) now (${meta.channels.reduce((n: number, c: { decoded: number }) => n + c.decoded, 0)} on the air), ` +
        `sync ${synced.join(' ') || 'none'}, ${ms.toFixed(0)} ms` +
        heard.map((h) => ` | ${h.baseFreqHz.toFixed(0)}Hz ${h.frame.snrDb.toFixed(0)} dB dt ${h.frame.timeOffsetSec.toFixed(2)}${h.frame.copies ? ` (${h.frame.copies} copies)` : ''}`).join(''));
    });
  }
});
