import type { Order } from '../schemas.js';
import { customers } from './customers.js';
export function fixtureOrders(): Order[] {
  return structuredClone([
    {
      order_id: 'DEL-001', store_id: 'STORE-001', created_at: '2026-10-07T12:00:00.000Z', customer: customers[0],
      items: [{ product_id: 'PRODUCT-001', name: 'Hambúrguer artesanal', quantity: 2, unit_price: 3200,
        modifiers: [{ modifier_id: 'MOD-001', name: 'Queijo extra', quantity: 1, unit_price: 400 }], line_total: 7200 }],
      subtotal: 7200, delivery_fee: 700, discount: 500, total: 7400, currency: 'BRL', payment: { method: 'PIX', status: 'PAID' }, status: 'CREATED',
    },
    {
      order_id: 'DEL-002', store_id: 'STORE-002', created_at: '2026-10-07T12:15:00.000Z', customer: customers[1],
      items: [{ product_id: 'PRODUCT-004', name: 'Prato executivo vegetariano', quantity: 1, unit_price: 3600, modifiers: [], line_total: 3600 }],
      subtotal: 3600, delivery_fee: 500, discount: 0, total: 4100, currency: 'BRL', payment: { method: 'CASH', status: 'PENDING' }, status: 'CONFIRMED',
    },
  ] satisfies Order[]);
}
