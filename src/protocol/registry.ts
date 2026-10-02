import type { Protocol } from './protocol';
import type { ProtocolId } from './spec';
import { gfsk8Deep, gfsk8Fast, gfsk8Long, gfsk8Medium, gfsk8Normal, gfsk8Turbo } from './gfsk8';

/**
 * The only place that knows which protocols exist. Typed as a full Record over
 * ProtocolId, so adding an id to the union without registering it here is a
 * compile error.
 */
const PROTOCOLS: Record<ProtocolId, Protocol> = {
  // Fastest first: this order is the one the Protocol selector shows.
  'gfsk8-turbo': gfsk8Turbo,
  'gfsk8-fast': gfsk8Fast,
  'gfsk8-medium': gfsk8Medium,
  'gfsk8-normal': gfsk8Normal,
  'gfsk8-long': gfsk8Long,
  'gfsk8-deep': gfsk8Deep,
};

export const DEFAULT_PROTOCOL_ID: ProtocolId = 'gfsk8-normal';

export function getProtocol(id: ProtocolId): Protocol {
  return PROTOCOLS[id];
}

export function listProtocols(): readonly Protocol[] {
  return Object.values(PROTOCOLS);
}

export function isProtocolId(value: string): value is ProtocolId {
  return Object.hasOwn(PROTOCOLS, value);
}
