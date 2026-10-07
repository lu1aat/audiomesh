/**
 * Persistent stores in localStorage, one key per kind of data so each can be cleared
 * on its own: the chat log, the stations (users) and the link statistics.
 * Storage is a convenience: private windows, blocked or full storage just mean nothing
 * is kept, so every access is guarded and never throws.
 */

export const CHAT_KEY = 'audiochat:chat';
export const UNREAD_KEY = 'audiochat:unread';
export const STATIONS_KEY = 'audiochat:stations';
export const DEBUG_KEY = 'audiochat:debug';
export const LINK_KEY = 'audiochat:link';

export function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked; see above.
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // See above.
  }
}

/** Runs `save` at most once per `delayMs` after a change, and at once when the page is hidden or closed. */
export class DeferredSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly save: () => void,
    private readonly delayMs = 2000,
  ) {
    addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  }

  /** Something changed. */
  touch(): void {
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  /** Drop a pending save (after the data was cleared and its key removed). */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
