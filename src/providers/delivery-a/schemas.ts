import { z } from 'zod';

export const eventTypes = ['ORDER_CREATED', 'ORDER_CONFIRMED', 'ORDER_PREPARING', 'ORDER_READY', 'ORDER_DISPATCHED', 'ORDER_DELIVERED', 'ORDER_CANCELLED'] as const;
export type EventType = typeof eventTypes[number];
export type OrderStatus = 'CREATED' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED';
export const paymentMethods = ['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'CASH'] as const;
export type PaymentMethod = typeof paymentMethods[number];
export interface Customer { customer_id: string; display_name: string; email: string }
export interface Modifier { modifier_id: string; name: string; quantity: number; unit_price: number }
export interface OrderItem { product_id: string; name: string; quantity: number; unit_price: number; modifiers: Modifier[]; line_total: number }
export interface Order {
  order_id: string; store_id: string; created_at: string; customer: Customer; items: OrderItem[];
  subtotal: number; delivery_fee: number; discount: number; total: number; currency: 'BRL';
  payment: { method: PaymentMethod; status: 'PAID' | 'PENDING' }; status: OrderStatus;
}
export const createOrderSchema = z.strictObject({
  store_id: z.string().min(1).optional(),
  items: z.array(z.strictObject({
    product_id: z.string().min(1), quantity: z.number().int().min(1).max(100),
    modifiers: z.array(z.strictObject({ modifier_id: z.string().min(1), quantity: z.number().int().min(1).max(10) })).max(20).optional(),
  })).min(1).max(100).optional(),
  delivery_fee: z.number().int().min(0).max(100000).optional(),
  discount: z.number().int().min(0).max(1000000).optional(),
  payment_method: z.enum(paymentMethods).optional(),
});
export type CreateOrder = z.infer<typeof createOrderSchema>;
export const createEventSchema = z.strictObject({ eventType: z.enum(eventTypes) });
export const listQuerySchema = z.strictObject({
  store_id: z.string().optional(), status: z.enum(['CREATED', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED']).optional(),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(20),
});
export function page<T>(data: T[], offset: number, limit: number) {
  return { data: data.slice(offset, offset + limit), pagination: { offset, limit, total: data.length } };
}
