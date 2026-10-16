import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';

describe('synthetic marketplace laboratory', () => {
  it('exposes two distinct merchants per provider and two items per unit', async () => {
    const { app } = buildApp({ logger: false });
    try {
      for (const provider of ['ifood', '99food']) {
        const stores = await app.inject({ method: 'GET', url: '/' + provider + '/stores' });
        const products = await app.inject({ method: 'GET', url: '/' + provider + '/products' });
        expect(stores.statusCode).toBe(200);
        expect(stores.json().data).toHaveLength(2);
        expect(products.json().data).toHaveLength(4);
        expect(products.json().contract).toBe('SYNTHETIC_NOT_OFFICIAL');
      }
    } finally { await app.close(); }
  });

  it('requires per-merchant authorization and emits different RAW shapes', async () => {
    const { app } = buildApp({ logger: false });
    try {
      const order = (provider: string, merchantId: string, itemId: string) => app.inject({
        method: 'POST', url: '/' + provider + '/test/orders', payload: { merchantId, itemId },
      });
      expect((await order('ifood', 'IFD-001', 'IFOOD-BURGER-001')).statusCode).toBe(403);
      for (const [provider, merchantId] of [['ifood', 'IFD-001'], ['99food', '99F-001']]) {
        expect((await app.inject({ method: 'POST', url: '/' + provider + '/lab/authorize', payload: { merchantId } })).statusCode).toBe(200);
      }
      const a = await order('ifood', 'IFD-001', 'IFOOD-BURGER-001');
      const b = await order('99food', '99F-001', '99FOOD-BURGER-001');
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect(a.json().raw.merchant.id).toBe('IFD-001');
      expect(b.json().raw.shopCode).toBe('99F-001');
      expect((await order('ifood', 'IFD-002', 'IFOOD-CHEESE-001')).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
