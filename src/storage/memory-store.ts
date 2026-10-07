import { defaultConfig } from '../core/scenario-engine/config.js';
import { fixtureOrders } from '../providers/delivery-a/fixtures/orders.js';
import type { Order } from '../providers/delivery-a/schemas.js';
import type { Occurrence } from '../providers/delivery-a/events.js';
import { HttpError } from '../core/errors/index.js';
import { randomUUID } from 'node:crypto';
import type { ProviderConfig } from '../core/scenario-engine/config.js';

export interface MemorySnapshot { generation: string; config: ProviderConfig; orders: [string, Order][]; events: [string, Occurrence][] }

export class MemoryStore {
  generation: string = randomUUID();
  config = defaultConfig();
  orders = new Map<string, Order>();
  events = new Map<string, Occurrence>();
  readonly maxOrders = 10000;
  readonly maxEvents = 10000;
  constructor() { this.reset(); }
  reset() { this.generation = randomUUID(); this.config = defaultConfig(); this.orders = new Map(fixtureOrders().map(order => [order.order_id, order])); this.events.clear(); }
  snapshot(): MemorySnapshot { return structuredClone({ generation: this.generation, config: this.config, orders: [...this.orders], events: [...this.events] }); }
  restore(snapshot: MemorySnapshot) { this.generation = snapshot.generation; this.config = structuredClone(snapshot.config); this.orders = new Map(snapshot.orders); this.events = new Map(snapshot.events); }
  assertCapacity(eventsNeeded = 1, ordersNeeded = 0) {
    if (this.events.size + eventsNeeded > this.maxEvents || this.orders.size + ordersNeeded > this.maxOrders) {
      throw new HttpError(409, 'Laboratory capacity reached; reset this provider');
    }
  }
}
