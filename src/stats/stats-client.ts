/**
 * MQTT over WebSocket to the one fixed broker (see STATS_BROKER_URL). Only ever started by the
 * "Publish Network Stats" setting. mqtt.js is a dynamic import, so a build where the setting is
 * never turned on does not even load it.
 */

import { STATS_BROKER_URL, STATS_TOPIC_ALL, parseStatsRecord, statsTopic, type StatsContext, type StatsRecord } from './stats-record';

export type StatsStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

/** Records kept for the stats screen, newest last. */
export const STATS_KEPT = 500;

/** The parts of an mqtt.js client this file uses. */
interface MqttLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  subscribe(topic: string, cb?: (err: Error | null) => void): unknown;
  publish(topic: string, payload: string, opts?: { qos?: 0 | 1 }): unknown;
  end(force?: boolean): unknown;
}

export class StatsClient {
  status: StatsStatus = 'off';
  /** Last error text, '' when none. */
  error = '';
  readonly records: StatsRecord[] = [];
  onChange: () => void = () => {};
  private client: MqttLike | null = null;
  /** Bumped by start/stop so a late connection of an older start is dropped. */
  private run = 0;

  constructor(private readonly context: () => StatsContext) {}

  get running(): boolean {
    return this.client !== null || this.status === 'connecting';
  }

  async start(): Promise<void> {
    if (this.running) return;
    const run = ++this.run;
    this.setStatus('connecting');
    try {
      const mqtt = await import('mqtt');
      if (run !== this.run) return;
      const c = mqtt.default.connect(STATS_BROKER_URL, { reconnectPeriod: 5000, connectTimeout: 10000 }) as unknown as MqttLike;
      this.client = c;
      c.on('connect', () => {
        this.error = '';
        this.setStatus('connected');
        c.subscribe(STATS_TOPIC_ALL);
      });
      c.on('reconnect', () => this.setStatus('reconnecting'));
      c.on('offline', () => this.setStatus('offline'));
      c.on('error', (e: Error) => {
        this.error = e.message;
        this.setStatus('error');
      });
      c.on('message', (_topic: string, payload: Uint8Array) => {
        const rec = parseStatsRecord(new TextDecoder().decode(payload));
        if (!rec) return;
        this.records.push(rec);
        if (this.records.length > STATS_KEPT) this.records.splice(0, this.records.length - STATS_KEPT);
        this.onChange();
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.setStatus('error');
    }
  }

  stop(): void {
    this.run++;
    this.client?.end(true);
    this.client = null;
    this.records.length = 0;
    this.error = '';
    this.setStatus('off');
  }

  /** Send one record; dropped silently while not connected (stats are best effort). */
  publish(rec: StatsRecord): void {
    if (this.status !== 'connected' || !this.client) return;
    this.client.publish(statsTopic(this.context()), JSON.stringify(rec), { qos: 0 });
  }

  private setStatus(s: StatsStatus): void {
    this.status = s;
    this.onChange();
  }
}
