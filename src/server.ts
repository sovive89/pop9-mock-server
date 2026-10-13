import { buildApp } from './app.js';
import { injectSpeedInsights } from '@vercel/speed-insights';

const production = process.env.NODE_ENV === 'production';
const adminToken = process.env.ADMIN_TOKEN || undefined;
const deliveryToken = process.env.DELIVERY_A_TOKEN || undefined;
if (production && (!adminToken || !deliveryToken || adminToken === deliveryToken)) {
  throw new Error('Production requires distinct ADMIN_TOKEN and DELIVERY_A_TOKEN');
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const { app } = buildApp({ adminToken, deliveryToken, logLevel: process.env.LOG_LEVEL });
injectSpeedInsights();
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
try { await app.listen({ host: process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'), port }); }
catch (error) { app.log.error(error); process.exitCode = 1; }
