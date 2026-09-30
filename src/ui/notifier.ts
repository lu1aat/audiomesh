/**
 * System notifications for incoming messages and announcements, only while the page
 * is in the background. Local only: nothing is pushed from a server. Works on desktop
 * browsers and Android Chrome (through the service worker in public/sw.js); iOS Safari
 * only allows notifications for a page added to the home screen (iOS 16.4+).
 */

export type NotifyState = 'unsupported' | 'denied' | 'default' | 'granted';

export class Notifier {
  enabled = false;
  private registration: ServiceWorkerRegistration | null = null;

  static get supported(): boolean {
    return typeof Notification !== 'undefined';
  }

  get state(): NotifyState {
    return Notifier.supported ? Notification.permission : 'unsupported';
  }

  /** Register the service worker (also what caches the app for offline use; without it desktop notifications fall back to `new Notification`). */
  async init(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    try {
      this.registration = await navigator.serviceWorker.register('./sw.js');
    } catch {
      // Insecure context or blocked: plain Notification still works on desktop.
    }
  }

  /** Ask for permission; call from a click. Resolves true when notifications may be shown. */
  async enable(): Promise<boolean> {
    if (!Notifier.supported) return false;
    if (Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // Very old Safari only supports the callback form; treat as denied.
      }
    }
    return Notification.permission === 'granted';
  }

  /** True while the user is looking at the chat; the page sets this, the default is "page visible and focused". */
  attentive: () => boolean = () => !document.hidden && document.hasFocus();

  /** Show one notification if enabled, permitted and the user is not looking at the chat. */
  notify(title: string, body: string, tag: string): void {
    if (!this.enabled || this.state !== 'granted' || this.attentive()) return;
    this.show(title, body, tag).catch(() => {
      // Notifications are a convenience; never let them break decoding.
    });
  }

  /** Send one now, ignoring the attention check. Resolves with a one-line result for the UI. */
  async test(): Promise<string> {
    if (this.state === 'unsupported') return 'This browser has no Notification API.';
    if (!(await this.enable())) return `Permission is ${this.state}: allow notifications for this site in the browser settings.`;
    try {
      const how = await this.show('audiomesh', 'Test notification', 'test');
      return `Sent (${how}). If nothing appeared, check the operating system's notification settings and do-not-disturb.`;
    } catch (e) {
      return `Failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Try the service worker first (the only way on Android), then the plain constructor. Rejects when both fail. */
  private async show(title: string, body: string, tag: string): Promise<string> {
    const options: NotificationOptions = { body, tag };
    let swError: unknown = null;
    if (this.registration) {
      try {
        await (await navigator.serviceWorker.ready).showNotification(title, options);
        return 'service worker';
      } catch (e) {
        swError = e;
      }
    }
    try {
      const n = new Notification(title, options);
      n.onclick = () => {
        window.focus();
        n.close();
      };
      return 'page';
    } catch (e) {
      throw swError ?? e;
    }
  }
}
