import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../errors/index.js';

export function authenticate(request: FastifyRequest, expected?: string) {
  if (!expected) return;
  const actual = Buffer.from(request.headers.authorization ?? '');
  const target = Buffer.from(`Bearer ${expected}`);
  if (actual.length !== target.length || !timingSafeEqual(actual, target)) throw new HttpError(401, 'Invalid or missing bearer token');
}
