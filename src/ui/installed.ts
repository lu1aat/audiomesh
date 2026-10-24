/** Running as an installed app: its own window, no tabs and no address bar. */
export function installedApp(): boolean {
  return (
    ['standalone', 'fullscreen', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches) ||
    (navigator as { standalone?: boolean }).standalone === true // iOS home screen
  );
}

/**
 * An installed app on a phone or tablet, which has a single window: there a link that opens a
 * new tab (Android) covers the app with a page that has no history to go back to. Pages of our
 * own then open in place, so the back gesture returns.
 */
export function singleWindowApp(): boolean {
  return installedApp() && matchMedia('(pointer: coarse)').matches;
}

/** The Navigation API, where the browser has it (Chrome, Edge, Safari 26). */
interface NavEntry { readonly key: string; readonly index: number }
interface Nav { readonly currentEntry: NavEntry | null; entries(): NavEntry[]; traverseTo(key: string): { finished: Promise<unknown> } }
const nav = (): Nav | undefined => (globalThis as { navigation?: Nav }).navigation;

/**
 * sessionStorage (one per tab): the history entry of the app that opened a page of ours in place.
 * Kept by key, not found by address: an entry's URL reads null under `Referrer-Policy: no-referrer`
 * (router.php sends it).
 */
const RETURN_KEY = 'audiochat:return';

/** The app, as it opens a page of ours in place: that page can then come back to this entry. */
export function rememberReturn(): void {
  try {
    const key = nav()?.currentEntry?.key;
    if (key) sessionStorage.setItem(RETURN_KEY, key);
  } catch {
    // No storage or no Navigation API: the page's link opens the app instead.
  }
}

function returnEntry(): NavEntry | null {
  const n = nav();
  const cur = n?.currentEntry;
  if (!n || !cur) return null;
  let key: string | null = null;
  try {
    key = sessionStorage.getItem(RETURN_KEY);
  } catch {
    return null;
  }
  return n.entries().find((e) => e.key === key && e.index < cur.index) ?? null;
}

/** Whether this tab came here from the app, which is still behind us in its history. */
export function canReturnToApp(): boolean {
  return returnEntry() !== null;
}

/** Go back to the app's entry, across any chapters visited in between; false when there is none. */
export function returnToApp(onFail: () => void): boolean {
  const to = returnEntry();
  if (!to) return false;
  nav()!.traverseTo(to.key).finished.catch(onFail);
  return true;
}
