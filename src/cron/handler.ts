import { getSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import { buildSandboxOptions, ensureSandboxLocated, resolveSandboxDoName } from '../index';
import { ensureGateway } from '../gateway';
import { shouldWakeContainer, DEFAULT_LEAD_TIME_MS, CRON_STORE_R2_KEY } from './wake';

/**
 * Handle Workers Cron Trigger.
 *
 * Two responsibilities, both backed by ensureGateway():
 *
 * 1. Keep-alive: warm the OpenClaw gateway on a configurable cadence so the
 *    user-facing chat path never pays the ~70s cold gateway cost. Controlled
 *    by KEEPALIVE_GATEWAY (default 'true') and KEEPALIVE_GATEWAY_EVERY_MINUTES
 *    (default 4). The Worker cron schedule itself still fires every minute
 *    (see wrangler.jsonc), but we only do work on the throttled cadence.
 *
 * 2. Wake-ahead: before an OpenClaw-internal cron job fires, make sure the
 *    container is awake so the in-container scheduler can run on time.
 *    Controlled by CRON_WAKE_AHEAD_MINUTES (default 10).
 */
export async function handleScheduled(env: OpenClawEnv): Promise<void> {
  const nowMs = Date.now();

  const keepaliveEnabled = env.KEEPALIVE_GATEWAY !== 'false';
  const keepaliveEveryMin = parseInt(env.KEEPALIVE_GATEWAY_EVERY_MINUTES || '', 10);
  const keepaliveCadenceMin = keepaliveEveryMin > 0 ? keepaliveEveryMin : 4;
  const minuteOfHour = Math.floor(nowMs / 60_000) % 60;
  const isKeepaliveTick = keepaliveEnabled && minuteOfHour % keepaliveCadenceMin === 0;

  let wakeReason: string | null = null;

  if (isKeepaliveTick) {
    wakeReason = `keep-alive (every ${keepaliveCadenceMin}m)`;
  }

  const cronStoreObject = await env.BACKUP_BUCKET.get(CRON_STORE_R2_KEY);
  if (cronStoreObject) {
    const cronStoreJson = await cronStoreObject.text();
    const leadMinutes = parseInt(env.CRON_WAKE_AHEAD_MINUTES || '', 10);
    const leadTimeMs = leadMinutes > 0 ? leadMinutes * 60 * 1000 : DEFAULT_LEAD_TIME_MS;
    const earliestRun = shouldWakeContainer(cronStoreJson, nowMs, leadTimeMs);
    if (earliestRun) {
      const deltaMinutes = ((earliestRun - nowMs) / 60_000).toFixed(1);
      wakeReason = wakeReason
        ? `${wakeReason} + cron job in ${deltaMinutes}m`
        : `cron job in ${deltaMinutes}m`;
    }
  }

  if (!wakeReason) {
    console.log('[CRON] No wake reason this tick, skipping');
    return;
  }

  console.log(`[CRON] Waking/keeping gateway hot: ${wakeReason}`);
  await ensureSandboxLocated(env);
  const sandbox = getSandbox(env.Sandbox, resolveSandboxDoName(env), buildSandboxOptions(env));
  await ensureGateway(sandbox, env);
  console.log('[CRON] Gateway is warm');
}
