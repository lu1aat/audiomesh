/**
 * How busy each channel is: the number of other transmitters heard on it lately.
 * Pure: the caller hands in the frames it heard (from the frame log).
 */

/** How far back the count looks. */
export const LOAD_WINDOW_SLOTS = 8;

export interface HeardOn {
  readonly slot: number;
  readonly channel: number;
  /** Who put it on the air: the sender, or for a repeated frame its repeater tag. */
  readonly transmitter: string;
}

/** Channel -> distinct transmitters heard on it in the `LOAD_WINDOW_SLOTS` slots before `slot`. */
export function channelLoad(heard: readonly HeardOn[], slot: number): Map<number, number> {
  const who = new Map<number, Set<string>>();
  for (const h of heard) {
    if (h.slot >= slot || slot - h.slot > LOAD_WINDOW_SLOTS || h.channel <= 0) continue;
    let set = who.get(h.channel);
    if (!set) who.set(h.channel, (set = new Set()));
    set.add(h.transmitter);
  }
  return new Map([...who].map(([ch, set]) => [ch, set.size]));
}

/**
 * With no link data: the least busy channel, the home channel on a tie, else the one
 * nearest to it. `numbers` must not be empty.
 */
export function quietestChannel(numbers: readonly number[], load: ReadonlyMap<number, number>, home: number): number {
  const busy = (n: number): number => load.get(n) ?? 0;
  return [...numbers].sort((a, b) => busy(a) - busy(b) || Math.abs(a - home) - Math.abs(b - home) || a - b)[0]!;
}
