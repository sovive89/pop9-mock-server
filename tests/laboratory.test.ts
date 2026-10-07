import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../src/app.js';
import { defaultConfig, type ProviderConfig } from '../src/core/scenario-engine/config.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup(options: AppOptions = {}) {
  const result = buildApp({ logger: false, ...options });
  cleanups.push(() => result.app.close());
  return result;
}
async function configure(app: ReturnType<typeof buildApp>['app'], patch: Partial<ProviderConfig>) {
  const response = await app.inject({ method: 'PATCH', url: '/admin/providers/delivery-a/config', payload: patch });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function receiver(statuses = [200], hold = false) {
  const bodies: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    bodies.push(body);
    if (!hold) { response.writeHead(statuses[Math.min(bodies.length - 1, statuses.length - 1)]); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { bodies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook` };
}
async function create(app: ReturnType<typeof buildApp>['app']) {
  return app.inject({ method: 'POST', url: '/delivery-a/test/orders', payload: {} });
}

describe('Delivery A contract', () => {
  it('creates realistic orders and computes cent values including modifiers', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'POST', url: '/delivery-a/test/orders', payload: {
      store_id: 'STORE-001', items: [{ product_id: 'PRODUCT-001', quantity: 2, modifiers: [{ modifier_id: 'MOD-001', quantity: 1 }] }],
      discount: 500, delivery_fee: 700, payment_method: 'PIX',
    } });
    expect(response.statusCode).toBe(201);
    const order = response.json();
    expect(order).toMatchObject({ subtotal: 7200, delivery_fee: 700, discount: 500, total: 7400, status: 'CREATED', currency: 'BRL' });
    expect(order.order_id).toMatch(/^DEL-/);
    expect(order.customer.email).toContain('example.invalid');
    expect(order.items[0].modifiers).toHaveLength(1);
    expect((await app.inject(`/delivery-a/orders/${order.order_id}`)).json()).toEqual(order);
    expect((await app.inject('/delivery-a/stores')).json().pagination.total).toBe(2);
    const products = (await app.inject('/delivery-a/products?store_id=STORE-002')).json().data;
    expect(products.every((product: { store_id: string }) => product.store_id === 'STORE-002')).toBe(true);
  });
  it('two legitimate events for the same order have different IDs and immutable snapshots', async () => {
    const { app, lab } = setup();
    const order = (await create(app)).json();
    const event = await app.inject({ method: 'POST', url: `/delivery-a/test/orders/${order.order_id}/events`, payload: { eventType: 'ORDER_CONFIRMED' } });
    expect(event.statusCode).toBe(201);
    const events = [...lab.store.events.values()].map(event => JSON.parse(event.body));
    expect(events).toHaveLength(2);
    expect(events[0].eventId).not.toBe(events[1].eventId);
    expect(events.map(event => event.orderId)).toEqual([order.order_id, order.order_id]);
    expect(events.map(event => event.data.order.status)).toEqual(['CREATED', 'CONFIRMED']);
  });
  it('rejects mismatched products, invalid types and excessive discounts', async () => {
    const { app, lab } = setup();
    for (const payload of [{ items: [{ product_id: 'PRODUCT-004', quantity: 1 }] }, { discount: 1000000 }, { items: 'invalid' }, { unexpected: true }]) {
      expect((await app.inject({ method: 'POST', url: '/delivery-a/test/orders', payload })).statusCode).toBe(400);
    }
    expect(lab.store.orders.size).toBe(2);
    expect(lab.store.events.size).toBe(0);
    expect((await app.inject('/delivery-a/orders/not-found')).statusCode).toBe(404);
  });
});

describe('Scenario Engine and rate limiter', () => {
  it.each([['UNAUTHORIZED', 401], ['UNAVAILABLE', 503], ['SERVER_ERROR', 500], ['RATE_LIMIT', 429]] as const)('%s returns %i', async (scenario, status) => {
    const { app } = setup();
    await configure(app, { scenario });
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(status);
    expect((await app.inject('/admin/providers')).statusCode).toBe(200);
  });
  it('forces 429 with optional Retry-After', async () => {
    const { app } = setup();
    await configure(app, { scenario: 'RATE_LIMIT' });
    expect((await app.inject('/delivery-a/orders')).headers['retry-after']).toBe('60');
    await configure(app, { rateLimit: { ...defaultConfig().rateLimit, includeRetryAfter: false } });
    expect((await app.inject('/delivery-a/orders')).headers['retry-after']).toBeUndefined();
  });
  it('enforces configurable quota and releases it when the window expires', async () => {
    let now = 1000;
    const { app } = setup({ now: () => now });
    await configure(app, { rateLimit: { enabled: true, requests: 2, windowSeconds: 60, includeRetryAfter: true } });
    expect((await app.inject('/delivery-a/stores')).statusCode).toBe(200);
    expect((await app.inject('/delivery-a/products')).statusCode).toBe(200);
    now += 1500;
    const blocked = await app.inject('/delivery-a/orders');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('59');
    now += 60000;
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(200);
  });
  it('MISSING_FIELD removes a field from responses and event snapshots only', async () => {
    const { app, lab } = setup();
    await configure(app, { scenario: 'MISSING_FIELD' });
    const order = (await create(app)).json();
    expect(order).not.toHaveProperty('store_id');
    expect((await app.inject('/delivery-a/orders/DEL-001')).json()).not.toHaveProperty('store_id');
    expect(lab.store.orders.get(order.order_id)).toHaveProperty('store_id');
    expect(JSON.parse([...lab.store.events.values()][0].body).data.order).not.toHaveProperty('store_id');
  });
  it('UNKNOWN_FIELD introduces unexpected data', async () => {
    const { app } = setup();
    await configure(app, { scenario: 'UNKNOWN_FIELD' });
    expect((await app.inject('/delivery-a/orders/DEL-001')).json()).toHaveProperty('experimental_delivery_hint');
  });
  it('INVALID_PAYLOAD violates structure while remaining parseable JSON', async () => {
    const { app } = setup();
    await configure(app, { scenario: 'INVALID_PAYLOAD' });
    const order = (await app.inject('/delivery-a/orders/DEL-001')).json();
    expect(order.items).toBe('not-an-array');
    expect(order.total).toEqual({ invalid: true });
  });
  it('errorRate determines scenario activation', async () => {
    const { app } = setup({ random: () => 0.5 });
    await configure(app, { scenario: 'UNAVAILABLE', errorRate: 0 });
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(200);
    await configure(app, { errorRate: 1 });
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(503);
  });
  it('adds latency and an artificial timeout delay', async () => {
    const { app } = setup();
    await configure(app, { scenario: 'TIMEOUT', latencyMs: 15, timeoutDelayMs: 40 });
    const start = performance.now();
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(200);
    expect(performance.now() - start).toBeGreaterThanOrEqual(50);
  });
});

describe('Webhook delivery', () => {
  it('DUPLICATE_EVENT delivers precisely the same eventId, occurredAt and body twice', async () => {
    const target = await receiver();
    const { app, lab } = setup();
    await configure(app, { scenario: 'DUPLICATE_EVENT', webhookDestination: target.url });
    await create(app);
    await lab.dispatcher.idle();
    expect(target.bodies).toHaveLength(2);
    expect(target.bodies[0]).toBe(target.bodies[1]);
    expect(lab.store.events.size).toBe(1);
    expect(lab.dispatcher.attempts.map(attempt => attempt.attemptNumber)).toEqual([1, 2]);
  });
  it('OUT_OF_ORDER sends READY before PREPARING for the same order', async () => {
    const target = await receiver();
    const { app, lab } = setup();
    await configure(app, { scenario: 'OUT_OF_ORDER', webhookDestination: target.url });
    const order = (await create(app)).json();
    await lab.dispatcher.idle();
    const messages = target.bodies.map(body => JSON.parse(body));
    expect(messages.map(event => event.eventType)).toEqual(['ORDER_CREATED', 'ORDER_READY', 'ORDER_PREPARING']);
    expect(new Set(messages.map(event => event.eventId)).size).toBe(3);
    expect(messages.every(event => event.orderId === order.order_id)).toBe(true);
  });
  it('retries HTTP 503 with an identical occurrence and records results', async () => {
    const target = await receiver([503, 200]);
    const { app, lab } = setup();
    await configure(app, { webhookDestination: target.url, webhookRetries: 2, webhookRetryDelayMs: 1 });
    await create(app);
    await lab.dispatcher.idle();
    expect(target.bodies).toHaveLength(2);
    expect(target.bodies[0]).toBe(target.bodies[1]);
    expect(lab.dispatcher.attempts.map(attempt => attempt.responseStatus)).toEqual([503, 200]);
    expect(lab.dispatcher.attempts.map(attempt => attempt.success)).toEqual([false, true]);
    expect(lab.dispatcher.attempts[0]).toMatchObject({ destination: target.url, attemptNumber: 1, responseStatus: 503 });
    expect(lab.dispatcher.attempts[0].responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(lab.dispatcher.attempts[0].requestedAt))).toBe(false);
  });
  it('manual redelivery keeps original payload even after scenario and order change', async () => {
    const target = await receiver();
    const { app, lab } = setup();
    await configure(app, { webhookDestination: target.url, scenario: 'MISSING_FIELD' });
    const order = (await create(app)).json();
    await lab.dispatcher.idle();
    const original = target.bodies[0];
    const eventId = JSON.parse(original).eventId;
    await configure(app, { scenario: 'NORMAL' });
    await app.inject({ method: 'POST', url: `/delivery-a/test/orders/${order.order_id}/events`, payload: { eventType: 'ORDER_CONFIRMED' } });
    const response = await app.inject({ method: 'POST', url: `/admin/providers/delivery-a/events/${eventId}/redeliver` });
    expect(response.statusCode).toBe(202);
    await lab.dispatcher.idle();
    expect(target.bodies[2]).toBe(original);
    expect(lab.dispatcher.attempts[2].attemptNumber).toBe(2);
  });
  it('does not retry permanent HTTP 400 errors', async () => {
    const target = await receiver([400]);
    const { app, lab } = setup();
    await configure(app, { webhookDestination: target.url, webhookRetries: 3, webhookRetryDelayMs: 1 });
    await create(app); await lab.dispatcher.idle();
    expect(target.bodies).toHaveLength(1);
    expect(lab.dispatcher.attempts[0].success).toBe(false);
  });
  it('times out receiver requests and bounds the retry count', async () => {
    const target = await receiver([200], true);
    const { app, lab } = setup();
    await configure(app, { webhookDestination: target.url, webhookTimeoutMs: 25, webhookRetries: 1, webhookRetryDelayMs: 1 });
    await create(app); await lab.dispatcher.idle();
    expect(lab.dispatcher.attempts).toHaveLength(2);
    expect(lab.dispatcher.attempts.every(attempt => attempt.responseStatus === null && !attempt.success)).toBe(true);
  });
});

describe('Administration and reset', () => {
  it('reset restores defaults, fixtures and quota and clears event/delivery history', async () => {
    const target = await receiver();
    const { app, lab } = setup();
    await configure(app, { webhookDestination: target.url, scenario: 'DUPLICATE_EVENT', latencyMs: 1, rateLimit: { enabled: true, requests: 1, windowSeconds: 60, includeRetryAfter: true } });
    await create(app); await lab.dispatcher.idle();
    expect((await app.inject('/delivery-a/stores')).statusCode).toBe(429);
    const reset = await app.inject({ method: 'POST', url: '/admin/providers/delivery-a/reset' });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().config).toEqual(defaultConfig());
    expect(lab.store.orders.size).toBe(2);
    expect(lab.store.events.size).toBe(0);
    expect(lab.dispatcher.attempts).toHaveLength(0);
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(200);
    expect((await app.inject('/admin/providers/delivery-a/config')).json()).toEqual(defaultConfig());
  });
  it('reset cancels in-flight deliveries and pending retries', async () => {
    const target = await receiver([200], true);
    const { app, lab } = setup();
    await configure(app, { webhookDestination: target.url, webhookTimeoutMs: 10000, webhookRetries: 5 });
    await create(app);
    await new Promise(resolve => setTimeout(resolve, 30));
    const oldQueue = lab.dispatcher.idle();
    await app.inject({ method: 'POST', url: '/admin/providers/delivery-a/reset' });
    await oldQueue;
    expect(lab.dispatcher.attempts).toHaveLength(0);
    expect(lab.store.events.size).toBe(0);
    expect(target.bodies.length).toBeLessThanOrEqual(1);
  });
  it('reset prevents delayed requests from creating new records afterward', async () => {
    const { app, lab } = setup();
    await configure(app, { latencyMs: 50 });
    const pending = create(app);
    await new Promise(resolve => setTimeout(resolve, 10));
    await app.inject({ method: 'POST', url: '/admin/providers/delivery-a/reset' });
    expect((await pending).statusCode).toBe(409);
    expect(lab.store.orders.size).toBe(2);
    expect(lab.store.events.size).toBe(0);
  });
  it('supports partial rate-limit updates and rejects invalid config without mutation', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'PATCH', url: '/admin/providers/delivery-a/config', payload: { rateLimit: { requests: 3 } } });
    expect(response.json().rateLimit).toEqual({ ...defaultConfig().rateLimit, requests: 3 });
    const invalid = await app.inject({ method: 'PATCH', url: '/admin/providers/delivery-a/config', payload: { scenario: 'UNKNOWN', latencyMs: -1 } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject('/admin/providers/delivery-a/config')).json()).toEqual(response.json());
  });
  it('separates administrator and provider credentials and exposes public health only', async () => {
    const { app } = setup({ adminToken: 'admin-test', deliveryToken: 'delivery-test' });
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/admin/providers')).statusCode).toBe(401);
    expect((await app.inject('/delivery-a/orders')).statusCode).toBe(401);
    expect((await app.inject({ url: '/admin/providers', headers: { authorization: 'Bearer delivery-test' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/admin/providers', headers: { authorization: 'Bearer admin-test' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/delivery-a/orders', headers: { authorization: 'Bearer delivery-test' } })).statusCode).toBe(200);
  });
});
