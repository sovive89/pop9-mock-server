import { randomUUID } from 'node:crypto';
import type { Scenario } from '../../core/scenario-engine/engine.js';
import type { EventType, Order } from './schemas.js';

export interface Occurrence {
  eventId: string; eventType: EventType; occurredAt: string; orderId: string;
  scenario: Scenario; body: string;
}
export function presentOrder(order: Order, scenario: Scenario): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...structuredClone(order) };
  if (scenario === 'MISSING_FIELD') delete payload.store_id;
  if (scenario === 'UNKNOWN_FIELD') payload.experimental_delivery_hint = { entrance: 'Porta fictícia B', version: 99 };
  if (scenario === 'INVALID_PAYLOAD') { payload.items = 'not-an-array'; payload.total = { invalid: true }; }
  return payload;
}
export function occurrence(order: Order, eventType: EventType, scenario: Scenario, now: () => number): Occurrence {
  const eventId = `EVT-${randomUUID()}`;
  const occurredAt = new Date(now()).toISOString();
  return {
    eventId, eventType, occurredAt, orderId: order.order_id, scenario,
    body: JSON.stringify({ eventId, eventType, occurredAt, orderId: order.order_id, data: { order: presentOrder(order, scenario) } }),
  };
}
