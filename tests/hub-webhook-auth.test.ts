import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendWebhook } from '../src/core/webhook-dispatcher/transport.js';
import { defaultConfig } from '../src/core/scenario-engine/config.js';

const originalToken = process.env.HUB_WEBHOOK_BEARER_TOKEN;
const originalDestination = process.env.HUB_WEBHOOK_DESTINATION;
afterEach(() => {
  if (originalToken === undefined) delete process.env.HUB_WEBHOOK_BEARER_TOKEN;
  else process.env.HUB_WEBHOOK_BEARER_TOKEN = originalToken;
  if (originalDestination === undefined) delete process.env.HUB_WEBHOOK_DESTINATION;
  else process.env.HUB_WEBHOOK_DESTINATION = originalDestination;
  vi.unstubAllGlobals();
});

describe('Hub webhook authentication', () => {
  it('sends a configured bearer token without changing event bytes', async () => {
    process.env.HUB_WEBHOOK_BEARER_TOKEN = 'lab-secret';
    process.env.HUB_WEBHOOK_DESTINATION = 'https://hub.example/v1/webhooks/source-id';
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { ...defaultConfig(), webhookDestination: 'https://hub.example/v1/webhooks/source-id' };
    const body = '{"eventId":"evt-1","data":{"value":1}}';
    const attempt = await sendWebhook({ eventId: 'evt-1', body }, config, 1, Date.now);
    expect(attempt.success).toBe(true);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer lab-secret');
    expect(init.body).toBe(body);
    expect(JSON.stringify(attempt)).not.toContain('lab-secret');
  });
  it('refuses to send credentials to a destination other than the pinned Hub endpoint', async () => {
    process.env.HUB_WEBHOOK_BEARER_TOKEN = 'lab-secret';
    process.env.HUB_WEBHOOK_DESTINATION = 'https://hub.example/v1/webhooks/source-id';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = { ...defaultConfig(), webhookDestination: 'https://other.example/collect' };
    const attempt = await sendWebhook({ eventId: 'evt-2', body: '{}' }, config, 1, Date.now);
    expect(attempt.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(attempt)).not.toContain('lab-secret');
  });
  it('does not send authorization when the token is absent', async () => {
    delete process.env.HUB_WEBHOOK_BEARER_TOKEN;
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { ...defaultConfig(), webhookDestination: 'https://hub.example/v1/webhooks/source-id' };
    await sendWebhook({ eventId: 'evt-1', body: '{}' }, config, 1, Date.now);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string,string>).Authorization).toBeUndefined();
  });
});
