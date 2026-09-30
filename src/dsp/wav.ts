/** Mono 16-bit PCM WAV, enough to hand a captured window to other tools and read it back. */

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i]! * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

export function encodeWav16(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}

/** Reads what encodeWav16 writes (mono, 16-bit PCM); anything else throws. */
export function decodeWav16(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12;
  let sampleRate = 0;
  while (at + 8 <= bytes.length) {
    const size = v.getUint32(at + 4, true);
    if (tag(at) === 'fmt ') {
      if (v.getUint16(at + 8, true) !== 1 || v.getUint16(at + 10, true) !== 1 || v.getUint16(at + 22, true) !== 16) {
        throw new Error('only mono 16-bit PCM is supported');
      }
      sampleRate = v.getUint32(at + 12, true);
    } else if (tag(at) === 'data') {
      const n = Math.min(size, bytes.length - at - 8) >> 1;
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = v.getInt16(at + 8 + i * 2, true) / 32768;
      return { samples, sampleRate };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
