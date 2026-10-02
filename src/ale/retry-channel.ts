/**
 * Channel for a retransmit round of a directed message. A round that got no ack on
 * the channel of the round before gives no reason to try the same one again: the
 * problem may be that channel (a speaker or mic that rolls off at the band edge), and
 * nothing in the link table can tell it apart from a lost ack. Each new round goes to
 * a channel not used yet by this message; once all were tried, any but the last one.
 * Pure, so tests can reach it.
 */

/**
 * `used`: channels earlier rounds of this message went on, oldest first. `channels`:
 * the band's channel numbers, ascending. `ranked`: channels the link table likes for
 * the destination, best first (may be empty or hold channels outside `channels`).
 * Among the candidates the best ranked wins; with no link data, the one nearest the
 * middle of the band, the lower number on a tie (the edges are the weakest spots).
 */
export function pickRetryChannel(used: readonly number[], channels: readonly number[], ranked: readonly number[]): number | undefined {
  if (channels.length === 0) return undefined;
  let candidates = channels.filter((c) => !used.includes(c));
  if (candidates.length === 0) candidates = channels.filter((c) => c !== used[used.length - 1]);
  if (candidates.length === 0) return channels[0];
  const best = ranked.find((c) => candidates.includes(c));
  if (best !== undefined) return best;
  const middle = (channels.length - 1) / 2;
  return candidates.reduce((a, b) => {
    const da = Math.abs(channels.indexOf(a) - middle);
    const db = Math.abs(channels.indexOf(b) - middle);
    return db < da ? b : a;
  });
}
