/**
 * What the Network screen shows, computed from the LQA table. Pure: no DOM, no clock
 * (the caller passes the current slot).
 */

import type { LqaRow, LqaTable, Sample } from './lqa';

export type StationStatus = 'active' | 'recent' | 'quiet';

/** Heard within this long ago counts as active / recent; older is quiet. */
export const ACTIVE_SEC = 120;
export const RECENT_SEC = 600;

export function stationStatus(ageSec: number): StationStatus {
  return ageSec <= ACTIVE_SEC ? 'active' : ageSec <= RECENT_SEC ? 'recent' : 'quiet';
}

/** SNR range mapped onto the colour scale: below the decoder's floor .. a strong signal. */
export const SNR_FLOOR_DB = -24;
export const SNR_CEIL_DB = 0;

/** 0..1 position of an SNR on the colour scale, clamped. */
export function snrLevel(snrDb: number): number {
  return Math.min(1, Math.max(0, (snrDb - SNR_FLOOR_DB) / (SNR_CEIL_DB - SNR_FLOOR_DB)));
}

export type SignalLevel = 'good' | 'fair' | 'weak';

/** Green / yellow / red: comfortably above the decoder floor, near it, at or below it. */
export const GOOD_DB = -12;
export const FAIR_DB = -18;

export function signalLevel(snrDb: number): SignalLevel {
  return snrDb >= GOOD_DB ? 'good' : snrDb >= FAIR_DB ? 'fair' : 'weak';
}

/** Map colour by time since a station was last heard: green for the first minute, then through
 * orange and red to grey at RECENT_SEC, when the map fades the station. [ageSec, r, g, b]. */
const AGE_STOPS: readonly (readonly [number, number, number, number])[] = [
  [60, 74, 222, 128], // --good
  [200, 240, 160, 70], // orange
  [400, 240, 119, 107], // --bad
  [RECENT_SEC, 110, 116, 128], // grey
];

/** Fill for a station heard `ageSec` ago, and whether dark text reads better on it than light.
 * `opacity` < 1: the fill is drawn that see-through over a dark background (text choice allows for it). */
export function ageColor(ageSec: number, opacity = 1): { fill: string; darkText: boolean } {
  let c: readonly number[] = AGE_STOPS[AGE_STOPS.length - 1]!.slice(1);
  if (ageSec <= AGE_STOPS[0]![0]) c = AGE_STOPS[0]!.slice(1);
  else {
    for (let i = 1; i < AGE_STOPS.length; i++) {
      const a = AGE_STOPS[i - 1]!, b = AGE_STOPS[i]!;
      if (ageSec > b[0]) continue;
      const k = (ageSec - a[0]) / (b[0] - a[0]);
      c = [1, 2, 3].map((j) => Math.round(a[j]! + k * (b[j]! - a[j]!)));
      break;
    }
  }
  const DARK_BG_LUMA = 25;
  const luma = opacity * (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!) + (1 - opacity) * DARK_BG_LUMA;
  return { fill: `rgb(${c.join(',')})`, darkText: luma > 130 };
}

/** "just now", "45 s ago", "7 min ago", "3 h ago". */
export function formatAge(ageSec: number): string {
  if (ageSec < 10) return 'just now';
  if (ageSec < 90) return `${Math.round(ageSec)} s ago`;
  if (ageSec < 5400) return `${Math.round(ageSec / 60)} min ago`;
  return `${Math.round(ageSec / 3600)} h ago`;
}

export interface StationInfo {
  readonly id: number;
  readonly lastSlot: number;
  readonly ageSec: number;
  readonly status: StationStatus;
  /** SNR of the newest frame heard from it, if any is still in the history. */
  readonly lastSnrDb?: number;
  readonly lastChannel?: number;
  /** Colour class of `lastSnrDb`. */
  readonly level?: SignalLevel;
  /** Where to transmit to reach it, and whether it told us so or we are guessing. */
  readonly best?: { channel: number; score: number; measured: boolean };
  /** It says it runs a repeater (heard within the repeater memory). */
  readonly repeater: boolean;
  /** Frames from other stations that reached us through it, when it is a repeater. */
  readonly framesVia?: number;
  /** Its newest frame that reached us through a repeater (via null = repeater not identified). */
  readonly relayed?: { readonly slot: number; readonly ageSec: number; readonly via: number | null; readonly tag: number };
  /** Heard direct within the link-quality memory; false = known only through a repeater. */
  readonly direct: boolean;
}

export interface ChannelInfo {
  readonly channel: number;
  /** Worst case over all stations heard; undefined when nothing is known about it. */
  readonly score?: number;
  /** 1 = best; only for the top three known channels. */
  readonly rank?: number;
}

/** `from`'s signal reaches `to` at `snrDb` (best channel). Ids are station ids. */
export interface GraphEdge {
  readonly from: number;
  readonly to: number;
  readonly snrDb: number;
  readonly level: SignalLevel;
  /** Nothing newer than RECENT_SEC backs this link: drawn faded. */
  readonly stale: boolean;
}

/** `from` reached us through the repeater `via` (signal level unknown: the repeater does not say). */
export interface RelayEdge {
  readonly from: number;
  readonly via: number;
  readonly stale: boolean;
}

/** What the chat session knows about repeaters, for the model. */
export interface RepeaterInfo {
  /** Repeater id -> last slot it showed it is one. */
  readonly repeaters: ReadonlyMap<number, number>;
  /** Repeater id -> frames received through it. */
  readonly framesVia: ReadonlyMap<number, number>;
  readonly paths: readonly { from: number; via: number; slot: number }[];
  /** Stations heard through a repeater: id -> newest such frame (via null = repeater not identified). */
  readonly relayed?: ReadonlyMap<number, { readonly slot: number; readonly via: number | null; readonly tag: number }>;
  /** We run a repeater ourselves. */
  readonly self: boolean;
}

/** A repeater not heard from for this long is no longer marked as one. */
export const REPEATER_MEMORY_SEC = 30 * 60;

export interface LinkModel {
  /** Station ids for the graph: us first (when known), then everyone heard or mentioned. */
  readonly nodes: readonly number[];
  readonly edges: readonly GraphEdge[];
  /** Stations heard through a repeater: drawn as grey dotted lines to it. */
  readonly relays: readonly RelayEdge[];
  /** Graph nodes that run a repeater (us included, when we do). */
  readonly repeaters: readonly number[];
  /** Graph stations not heard or mentioned for more than RECENT_SEC: drawn faded, not removed. */
  readonly staleNodes: readonly number[];
  /** The newest packet from any station. */
  readonly lastPacket?: { readonly station: number; readonly ageSec: number };
  readonly stations: readonly StationInfo[];
  readonly channels: readonly ChannelInfo[];
  readonly rows: readonly LqaRow[];
  readonly samples: readonly Sample[];
}

/** How far back the history chart looks by default (the caller may ask for more, see `historySec`). */
export const HISTORY_SEC = 30 * 60;

export function buildLinkModel(
  lqa: LqaTable,
  channels: readonly number[],
  slot: number,
  slotSec: number,
  myId: number | null = null,
  relay: RepeaterInfo | null = null,
  historySec: number = HISTORY_SEC,
): LinkModel {
  const isRepeater = (id: number): boolean => {
    if (id === myId && relay?.self) return true;
    const at = relay?.repeaters.get(id);
    return at !== undefined && (slot - at) * slotSec <= REPEATER_MEMORY_SEC;
  };
  const rows = lqa.snapshot(slot);
  const samples = lqa.history(slot - Math.ceil(historySec / slotSec));
  const direct = [...new Set(rows.map((r) => r.station))].sort((a, b) => a - b);
  // Stations heard through a repeater count as heard too, for as long as a repeater is remembered.
  const relayed = new Map([...(relay?.relayed ?? [])].filter(([id, r]) => id !== myId && (slot - r.slot) * slotSec <= REPEATER_MEMORY_SEC));
  const ids = [...new Set([...direct, ...relayed.keys()])].sort((a, b) => a - b);

  const stations = ids.map((id): StationInfo => {
    const directSlot = Math.max(...rows.filter((r) => r.station === id).map((r) => r.lastSlot));
    const r = relayed.get(id);
    const lastSlot = Math.max(directSlot, r?.slot ?? -Infinity);
    const ageSec = Math.max(0, (slot - lastSlot) * slotSec);
    const latest = samples.filter((x) => x.station === id).at(-1);
    return {
      id,
      lastSlot,
      ageSec,
      status: stationStatus(ageSec),
      lastSnrDb: latest?.snrDb,
      lastChannel: latest?.channel,
      level: latest && signalLevel(latest.snrDb),
      best: lqa.bestFor(id, channels, slot),
      repeater: isRepeater(id),
      framesVia: relay?.framesVia.get(id),
      relayed: r && { ...r, ageSec: Math.max(0, (slot - r.slot) * slotSec) },
      direct: directSlot > -Infinity,
    };
  });

  // Only stations with link quality of their own: the others would count as unknown on every channel.
  const ranked = lqa.rankChannels(direct, channels, slot);
  const channelInfo = channels.map((channel): ChannelInfo => {
    const i = ranked.findIndex((r) => r.channel === channel);
    return i < 0 ? { channel } : { channel, score: ranked[i]!.score, rank: i < 3 ? i + 1 : undefined };
  });

  // Graph: our own two directions from the table, other stations' links from what they reported.
  // Evidence older than RECENT_SEC (the station list's "quiet") is marked stale, so the graph fades it.
  const best = new Map<string, { snrDb: number; slot: number }>();
  const lastSeen = new Map<number, number>();
  const seenAt = (id: number, at: number): void => { lastSeen.set(id, Math.max(lastSeen.get(id) ?? -Infinity, at)); };
  const link = (from: number, to: number, snrDb: number, at: number): void => {
    const k = `${from}>${to}`;
    const old = best.get(k);
    best.set(k, { snrDb: Math.max(old?.snrDb ?? -Infinity, snrDb), slot: Math.max(old?.slot ?? -Infinity, at) });
    seenAt(from, at);
    seenAt(to, at);
  };
  if (myId !== null) {
    for (const r of rows) {
      if (r.reportedDb !== undefined) link(myId, r.station, r.reportedDb, r.lastSlot);
      if (r.heardDb !== undefined) link(r.station, myId, r.heardDb, r.lastSlot);
    }
  }
  for (const t of lqa.thirdPartyLinks(slot)) link(t.talker, t.listener, t.snrDb, t.slot);
  // Every link is drawn, including ones to stations only others hear (we know them from reports).
  const edges = [...best].map(([k, v]): GraphEdge => {
    const [from, to] = k.split('>').map(Number) as [number, number];
    return { from, to, snrDb: v.snrDb, level: signalLevel(v.snrDb), stale: (slot - v.slot) * slotSec > RECENT_SEC };
  });
  const relays: RelayEdge[] = [];
  for (const p of relay?.paths ?? []) {
    if ((slot - p.slot) * slotSec > REPEATER_MEMORY_SEC) continue;
    relays.push({ from: p.from, via: p.via, stale: (slot - p.slot) * slotSec > RECENT_SEC });
    seenAt(p.from, p.slot);
    seenAt(p.via, p.slot);
  }
  // Every station we know stays a node, even without links.
  for (const st of stations) seenAt(st.id, st.lastSlot);
  const others = new Set<number>(lastSeen.keys());
  if (myId !== null) others.delete(myId);
  const nodes = [...(myId === null ? [] : [myId]), ...[...others].sort((a, b) => a - b)];
  const staleNodes = nodes.filter((id) => id !== myId && (slot - (lastSeen.get(id) ?? -Infinity)) * slotSec > RECENT_SEC);

  const newest = stations.reduce<StationInfo | undefined>((a, s) => (!a || s.lastSlot > a.lastSlot ? s : a), undefined);
  return { nodes, edges, relays, repeaters: nodes.filter(isRepeater), staleNodes, lastPacket: newest && { station: newest.id, ageSec: newest.ageSec }, stations, channels: channelInfo, rows, samples };
}
