/**
 * DOM control for the test tone, and the level slider shared with transmission.
 * Resolves the chosen source to a frequency and drives the engine; owns no audio
 * state itself.
 */

import { referenceTonesHz, type Band, type Channel } from '../band/band-plan';
import type { AudioEngine } from '../audio/engine';

/** Slider position (1..50) to linear gain (0.01..0.5). Kept well under full scale. */
const levelToGain = (position: number): number => position / 100;

export class TestToneControl {
  private readonly source = document.getElementById('tone-source') as HTMLSelectElement;
  private readonly customLabel = document.getElementById('tone-custom-label') as HTMLElement;
  private readonly custom = document.getElementById('tone-custom') as HTMLInputElement;
  private readonly level = document.getElementById('tone-level') as HTMLInputElement;
  private readonly button = document.getElementById('tone-button') as HTMLButtonElement;
  private readonly state = document.getElementById('tone-state') as HTMLElement;
  private selected: Channel | null = null;

  constructor(private readonly engine: AudioEngine) {
    this.source.addEventListener('change', () => {
      this.customLabel.hidden = this.source.value !== 'custom';
      this.retune();
    });
    this.custom.addEventListener('input', () => this.retune());
    this.level.addEventListener('input', () => {
      this.engine.setFrameLevel(levelToGain(this.level.valueAsNumber));
      this.retune();
    });
    this.button.addEventListener('click', () => {
      if (this.engine.toneFreqHz !== null) this.engine.stopTone();
      else this.retune(true);
      this.refresh();
    });
  }

  /** Linear gain, 0.01..0.5, from the level slider. */
  get gain(): number {
    return levelToGain(this.level.valueAsNumber);
  }

  /** Rebuild the frequency choices for a band: selected channel, its reference tones, custom. */
  setBand(band: Band): void {
    const [low, centre, high] = referenceTonesHz(band) as [number, number, number];
    const options: [string, string][] = [
      ['channel', 'Selected channel (centre)'],
      [String(low), `Low reference, ${low} Hz`],
      [String(centre), `Centre reference, ${centre} Hz`],
      [String(high), `High reference, ${high} Hz`],
      ['custom', 'Custom…'],
    ];
    this.source.replaceChildren(
      ...options.map(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        return o;
      }),
    );
    this.customLabel.hidden = true;
    this.retune();
  }

  /** Called when the selected channel changes, so a playing channel tone follows it. */
  setSelectedChannel(channel: Channel | null): void {
    this.selected = channel;
    this.retune();
    this.refresh();
  }

  /** Called when audio starts or stops. */
  refresh(): void {
    const playing = this.engine.toneFreqHz;
    this.button.disabled = !this.engine.running || !this.engine.transmitAllowed;
    this.button.textContent = playing !== null ? 'Stop tone' : 'Play tone';
    this.state.textContent = playing !== null ? `${Math.round(playing)} Hz` : 'off';
    this.state.className = playing !== null ? 'chip chip-ok' : 'chip';
  }

  private frequencyHz(): number | null {
    if (this.source.value === 'channel') return this.selected ? this.selected.centerHz : null;
    const hz = this.source.value === 'custom' ? this.custom.valueAsNumber : Number(this.source.value);
    return Number.isFinite(hz) && hz > 0 ? hz : null;
  }

  /** Retune a tone that is already playing, or start one when `start` is set. */
  private retune(start = false): void {
    if (!this.engine.running) return;
    if (!start && this.engine.toneFreqHz === null) return;
    const hz = this.frequencyHz();
    if (hz === null) {
      // e.g. "selected channel" with no channel chosen: silence rather than a stale tone.
      this.engine.stopTone();
    } else {
      this.engine.playTone(hz, levelToGain(this.level.valueAsNumber));
    }
    this.refresh();
  }
}
