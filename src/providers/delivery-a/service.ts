import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../../storage/memory-store.js';
import { HttpError } from '../../core/errors/index.js';
import type { Scenario } from '../../core/scenario-engine/engine.js';
import type { WebhookDispatcher } from '../../core/webhook-dispatcher/index.js';
import type { LabLogger } from '../../core/logging/index.js';
import { record } from '../../core/logging/index.js';
import { products } from './fixtures/products.js';
import { stores } from './fixtures/stores.js';
import { customers } from './fixtures/customers.js';
import type { CreateOrder, EventType, Order, OrderStatus } from './schemas.js';
import { occurrence } from './events.js';

export class DeliveryService {
  constructor(readonly store: MemoryStore, private readonly dispatcher: WebhookDispatcher, private readonly logger: LabLogger, private readonly now: () => number) {}
  get(id: string): Order {
    const order = this.store.orders.get(id);
    if (!order) throw new HttpError(404, 'Order not found');
    return order;
  }
  create(input: CreateOrder, scenario: Scenario) {
    const count = scenario === 'OUT_OF_ORDER' ? 3 : 1;
    this.store.assertCapacity(count, 1);
    this.ensureQueue(count, scenario);
    const storeId = input.store_id ?? 'STORE-001';
    if (!stores.some(store => store.store_id === storeId)) throw new HttpError(400, 'Unknown store_id');
    const defaultProduct = products.find(product => product.store_id === storeId)!;
    const items = (input.items ?? [{ product_id: defaultProduct.product_id, quantity: 2 }]).map(item => {
      const product = products.find(product => product.product_id === item.product_id && product.store_id === storeId);
      if (!product) throw new HttpError(400, 'Product does not belong to this store');
      const modifiers = (item.modifiers ?? []).map(modifier => {
        const fixture = product.modifiers.find(candidate => candidate.modifier_id === modifier.modifier_id);
        if (!fixture) throw new HttpError(400, 'Unknown modifier for product');
        return { ...fixture, quantity: modifier.quantity };
      });
      return { product_id: product.product_id, name: product.name, quantity: item.quantity, unit_price: product.unit_price, modifiers,
        line_total: item.quantity * (product.unit_price + modifiers.reduce((total, modifier) => total + modifier.quantity * modifier.unit_price, 0)) };
    });
    const subtotal = items.reduce((total, item) => total + item.line_total, 0);
    const delivery_fee = input.delivery_fee ?? 700;
    const discount = input.discount ?? 0;
    if (discount > subtotal + delivery_fee) throw new HttpError(400, 'Discount exceeds order value');
    const method = input.payment_method ?? 'PIX';
    const order: Order = {
      order_id: `DEL-${randomUUID()}`, store_id: storeId, created_at: new Date(this.now()).toISOString(),
      customer: structuredClone(customers[0]), items, subtotal, delivery_fee, discount,
      total: subtotal + delivery_fee - discount, currency: 'BRL',
      payment: { method, status: method === 'CASH' ? 'PENDING' : 'PAID' }, status: 'CREATED',
    };
    this.store.orders.set(order.order_id, order);
    this.emit(order.order_id, 'ORDER_CREATED', scenario);
    if (scenario === 'OUT_OF_ORDER') { this.emit(order.order_id, 'ORDER_READY', scenario); this.emit(order.order_id, 'ORDER_PREPARING', scenario); }
    return order;
  }
  private ensureQueue(count: number, scenario: Scenario) {
    if (this.store.config.webhookDestination) this.dispatcher.assertCapacity(count * (scenario === 'DUPLICATE_EVENT' ? 2 : 1));
  }
  emit(id: string, eventType: EventType, scenario: Scenario) {
    const order = this.get(id);
    this.store.assertCapacity(); this.ensureQueue(1, scenario);
    order.status = eventType.replace('ORDER_', '') as OrderStatus;
    const event = occurrence(order, eventType, scenario, this.now);
    this.store.events.set(event.eventId, event);
    record(this.logger, 'event_created', { eventId: event.eventId, orderId: id, eventType, scenario });
    this.dispatcher.enqueue(event, this.store.config, scenario === 'DUPLICATE_EVENT' ? 2 : 1);
    return event;
  }
}
