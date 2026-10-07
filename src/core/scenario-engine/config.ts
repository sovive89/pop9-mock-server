import { z } from 'zod';

export const scenarios = ['NORMAL', 'DUPLICATE_EVENT', 'RATE_LIMIT', 'UNAUTHORIZED', 'SERVER_ERROR', 'UNAVAILABLE', 'TIMEOUT', 'OUT_OF_ORDER', 'MISSING_FIELD', 'UNKNOWN_FIELD', 'INVALID_PAYLOAD'] as const;
export const configSchema = z.strictObject({
  scenario: z.enum(scenarios),
  latencyMs: z.number().int().min(0).max(60000),
  errorRate: z.number().min(0).max(1),
  timeoutDelayMs: z.number().int().min(0).max(120000),
  rateLimit: z.strictObject({
    enabled: z.boolean(), requests: z.number().int().min(1).max(100000),
    windowSeconds: z.number().int().min(1).max(86400), includeRetryAfter: z.boolean(),
  }),
  webhookDestination: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Use HTTP or HTTPS').nullable(),
  webhookRetries: z.number().int().min(0).max(10),
  webhookRetryDelayMs: z.number().int().min(0).max(60000),
  webhookTimeoutMs: z.number().int().min(1).max(60000),
});
export const configPatchSchema = configSchema.partial().extend({ rateLimit: configSchema.shape.rateLimit.partial().optional() });
export type ProviderConfig = z.infer<typeof configSchema>;
export function defaultConfig(): ProviderConfig {
  return {
    scenario: 'NORMAL', latencyMs: 0, errorRate: 1, timeoutDelayMs: 10000,
    rateLimit: { enabled: false, requests: 10, windowSeconds: 60, includeRetryAfter: true },
    webhookDestination: null, webhookRetries: 0, webhookRetryDelayMs: 500, webhookTimeoutMs: 3000,
  };
}
