import type { FastifyBaseLogger } from 'fastify';
export type LabLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export function record(logger: LabLogger, type: string, fields: Record<string, unknown>) {
  logger.info({ labEvent: type, ...fields });
}
