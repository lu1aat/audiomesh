/** The Capture section of the Network screen: switch, list and downloads for WindowCapture. */

import { captureFileStem, captureMeta, type CapturedWindow, type CaptureMode, type WindowCapture } from '../dsp/window-capture';
import { encodeWav16 } from '../dsp/wav';

/** Capture switches itself off after this long, so it cannot stay on unnoticed. */
export const CAPTURE_AUTO_OFF_MS = 30 * 60 * 1000;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A window's WAV and the JSON describing it: both are needed to replay it. */
function downloadWindow(w: CapturedWindow): void {
  const stem = captureFileStem(w);
  download(`${stem}.wav`, encodeWav16(w.samples, w.sampleRate), 'audio/wav');
  download(`${stem}.json`, JSON.stringify(captureMeta(w), null, 1), 'application/json');
}

export class CaptureView {
  private onSince = 0;
  private readonly feature = el<HTMLInputElement>('capture-feature');
  private readonly toggle = el<HTMLButtonElement>('capture-toggle');
  private readonly mode = el<HTMLSelectElement>('capture-mode');
  private readonly note = el<HTMLInputElement>('capture-note');
  private readonly list = el<HTMLTableElement>('capture-list');
  private readonly state = el('capture-state');
  private readonly all = el<HTMLButtonElement>('capture-download-all');
  private readonly clearButton = el<HTMLButtonElement>('capture-clear');
  private readonly dot = document.querySelector<HTMLElement>('[data-dot="capture"]');
  private readonly block = el('capture-block');

  /**
   * `featureOn`: the Settings switch that shows this section (persisted by the caller through
   * `onFeature`). Capturing itself always starts off and is started here with the button.
   */
  constructor(
    private readonly capture: WindowCapture,
    private readonly setEngine: (on: boolean) => void,
    featureOn: boolean,
    onFeature: (on: boolean) => void,
  ) {
    this.featureOn = featureOn;
    this.feature.checked = featureOn;
    this.mode.value = capture.mode;
    this.feature.addEventListener('change', () => {
      this.featureOn = this.feature.checked;
      if (!this.featureOn) {
        // Switched off in Settings: stop, and free the audio kept in memory.
        this.setCapturing(false);
        capture.clear();
      }
      onFeature(this.featureOn);
      this.render();
    });
    this.note.addEventListener('input', () => {
      capture.note = this.note.value;
    });
    this.toggle.addEventListener('click', () => this.setCapturing(!capture.enabled));
    this.mode.addEventListener('change', () => {
      capture.mode = this.mode.value as CaptureMode;
    });
    this.all.addEventListener('click', () => capture.windows.forEach(downloadWindow));
    this.clearButton.addEventListener('click', () => capture.clear());
    capture.onChange = () => this.render();
    setInterval(() => {
      if (capture.enabled && Date.now() - this.onSince > CAPTURE_AUTO_OFF_MS) this.setCapturing(false);
    }, 15_000);
    this.render();
  }

  private featureOn: boolean;

  private setCapturing(on: boolean): void {
    this.capture.enabled = on;
    this.onSince = Date.now();
    this.setEngine(on);
    this.render();
  }

  private render(): void {
    const c = this.capture;
    const mb = (c.bytes / (1024 * 1024)).toFixed(1);
    this.state.textContent =
      (c.enabled ? 'Capturing; stops by itself after 30 minutes. ' : 'Not capturing. ') +
      `${c.windows.length} window${c.windows.length === 1 ? '' : 's'} kept (${mb} MB)` +
      (c.dropped ? `, ${c.dropped} older dropped to stay under the memory cap` : '') + '.';
    // The Network section exists once Network capture is switched on in Settings.
    this.block.hidden = !this.featureOn;
    this.toggle.textContent = c.enabled ? 'Stop capture' : 'Start capture';
    this.toggle.classList.toggle('btn-highlight', !c.enabled);
    this.all.disabled = this.clearButton.disabled = c.windows.length === 0;
    this.dot?.classList.toggle('dot-yellow', c.enabled);
    this.list.replaceChildren();
    const head = this.list.createTHead().insertRow();
    for (const h of ['Slot (UTC)', 'Channels with sync', 'Best sync', 'Decoded', 'Note', '']) head.insertCell().textContent = h;
    const body = this.list.createTBody();
    for (const w of [...c.windows].reverse()) {
      const row = body.insertRow();
      row.insertCell().textContent = new Date(w.slotStartUtcMs).toISOString().slice(11, 19);
      row.insertCell().textContent = String(w.channels.filter((ch) => (ch.sync?.score ?? 0) >= 0.3).length);
      row.insertCell().textContent = w.bestSync.toFixed(2) + (w.partial ? ' (partial)' : '');
      if (w.partial) row.cells[row.cells.length - 1]!.title = 'Sync in one block only: the tail or head of a neighbour slot\'s frame, not a whole frame';
      row.insertCell().textContent = String(w.decoded);
      row.insertCell().textContent = w.note;
      const cell = row.insertCell();
      const get = document.createElement('button');
      get.type = 'button';
      get.className = 'btn-action';
      get.textContent = 'Download';
      get.addEventListener('click', () => downloadWindow(w));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-action';
      del.textContent = 'Remove';
      del.addEventListener('click', () => c.remove(w.id));
      cell.append(get, ' ', del);
    }
  }
}
