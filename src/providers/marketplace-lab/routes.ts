import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../../core/authentication/index.js';

// Synthetic contracts. These shapes are NOT asserted to match official iFood or 99Food APIs.
const units = [
  { unitId: 'UNIT-001', name: 'Burger Lab Guará', merchants: { ifood: 'IFD-001', '99food': '99F-001' }, items: [
    { id: 'BURGER-001', name: 'Hambúrguer clássico', cents: 2500 },
    { id: 'FRIES-001', name: 'Batata frita', cents: 1200 },
  ] },
  { unitId: 'UNIT-002', name: 'Burger Lab Águas Claras', merchants: { ifood: 'IFD-002', '99food': '99F-002' }, items: [
    { id: 'CHEESE-001', name: 'Cheeseburger', cents: 2800 },
    { id: 'SODA-001', name: 'Refrigerante', cents: 700 },
  ] },
] as const;
const providerNames = ['ifood', '99food'] as const;
type Provider = typeof providerNames[number];
const createOrder = z.strictObject({
  merchantId: z.string().min(1),
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(30).default(1),
});
const connections = new Map<string, boolean>();
const orders = new Map<string, unknown>();
const events = new Map<string, unknown>();

export async function marketplaceRoutes(app: FastifyInstance, token?: string) {
  // Development-only ephemeral state. The Vercel serverless adapter must persist it
  // before these mutation endpoints can be considered end-to-end functional.
  app.addHook('onRequest', async request => authenticate(request, token));
  for (const provider of providerNames) {
    const prefix = '/' + provider;
    app.get(prefix + '/stores', async () => ({
      data: units.map(unit => ({ merchantId: unit.merchants[provider], unitName: unit.name })),
      contract: 'SYNTHETIC_NOT_OFFICIAL',
    }));
    app.get(prefix + '/products', async () => ({
      data: units.flatMap(unit => unit.items.map(item => ({
        merchantId: unit.merchants[provider], externalItemId: provider.toUpperCase() + '-' + item.id,
        name: item.name, priceCents: item.cents,
      }))),
      contract: 'SYNTHETIC_NOT_OFFICIAL',
    }));
    app.post(prefix + '/lab/authorize', async (request, reply) => {
      const { merchantId } = z.strictObject({ merchantId: z.string() }).parse(request.body);
      const unit = units.find(u => u.merchants[provider] === merchantId);
      if (!unit) return reply.code(404).send({ error: 'UNKNOWN_MERCHANT' });
      connections.set(provider + ':' + merchantId, true);
      return { provider, merchantId, unitId: unit.unitId, state: 'AUTHORIZED', simulated: true };
    });
    app.post(prefix + '/lab/disconnect', async (request, reply) => {
      const { merchantId } = z.strictObject({ merchantId: z.string() }).parse(request.body);
      if (!units.some(u => u.merchants[provider] === merchantId)) return reply.code(404).send({ error: 'UNKNOWN_MERCHANT' });
      connections.delete(provider + ':' + merchantId);
      return { provider, merchantId, state: 'DISCONNECTED', simulated: true };
    });
    app.post(prefix + '/test/orders', async (request, reply) => {
      const input = createOrder.parse(request.body);
      const unit = units.find(u => u.merchants[provider] === input.merchantId);
      if (!unit) return reply.code(404).send({ error: 'UNKNOWN_MERCHANT' });
      if (!connections.get(provider + ':' + input.merchantId)) return reply.code(403).send({ error: 'MERCHANT_NOT_AUTHORIZED' });
      const item = unit.items.find(i => provider.toUpperCase() + '-' + i.id === input.itemId);
      if (!item) return reply.code(422).send({ error: 'UNKNOWN_PRODUCT_FOR_MERCHANT' });
      const orderId = provider.toUpperCase() + '-' + randomUUID();
      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();
      // Deliberately distinct provider RAW shapes, for adapter development only.
      const raw = provider === 'ifood'
        ? { id: orderId, merchant: { id: input.merchantId }, items: [{ code: input.itemId, amount: input.quantity, unitPrice: item.cents }], status: 'PLACED' }
        : { orderCode: orderId, shopCode: input.merchantId, products: [{ sku: input.itemId, count: input.quantity, price: item.cents }], state: 'NEW' };
      const envelope = { provider, contract: 'SYNTHETIC_NOT_OFFICIAL', eventId, occurredAt, raw };
      orders.set(provider + ':' + orderId, envelope);
      events.set(provider + ':' + eventId, envelope);
      return reply.code(201).send(envelope);
    });
    app.get(prefix + '/test/orders', async () => ({ data: [...orders.entries()].filter(([k]) => k.startsWith(provider + ':')).map(([, v]) => v) }));
    app.get(prefix + '/test/events', async () => ({ data: [...events.entries()].filter(([k]) => k.startsWith(provider + ':')).map(([, v]) => v) }));
  }
}
