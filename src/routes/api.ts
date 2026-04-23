import { Hono } from 'hono';
import { posix as pathPosix } from 'node:path';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureGateway, findExistingGatewayProcess, killGateway, waitForProcess } from '../gateway';
import { createSnapshot, getLastBackupId, signalRestoreNeeded } from '../persistence';
import { runtimeApi } from './runtime';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

type SeedFileInput = {
  path?: string;
  contentBase64?: string;
};

const SEED_ALLOWED_ROOTS = [
  '/home/openclaw/.openclaw/',
  '/home/openclaw/clawd/',
  '/home/openclaw/clawd/.persist/',
] as const;

const normalizeSeedPath = (rawPath: string): string => {
  const normalized = pathPosix.normalize(rawPath.trim());
  if (!normalized.startsWith('/')) {
    throw new Error(`Seed path must be absolute: ${rawPath}`);
  }
  if (!SEED_ALLOWED_ROOTS.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Seed path is outside allowed roots: ${rawPath}`);
  }
  return normalized;
};

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure gateway is running first
    await ensureGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices
    // Must specify --url and --token (OpenClaw v2026.2.3 requires explicit credentials with --url)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure gateway is running first
    await ensureGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure gateway is running first
    await ensureGateway(sandbox, c.env);

    // First, get the list of pending devices
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const listProc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveProc = await sandbox.startProcess(
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        // eslint-disable-next-line no-await-in-loop
        const approveLogs = await approveProc.getLogs();
        const success =
          approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get backup/restore status
adminApi.get('/storage', async (c) => {
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CLOUDFLARE_ACCOUNT_ID
  );

  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');

  const lastBackupId = hasCredentials ? await getLastBackupId(c.env.BACKUP_BUCKET) : null;

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastBackupId,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts via SDK snapshots.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Create a new snapshot
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Log mount state before backup for diagnostics
    let mountState = 'unknown';
    let dirContents = 'unknown';
    try {
      const mnt = await sandbox.exec('mount | grep openclaw || echo "NO_OVERLAY"');
      mountState = mnt.stdout?.trim() ?? 'empty';
      const ls = await sandbox.exec('ls /home/openclaw/clawd/ 2>&1 || echo "(empty)"');
      dirContents = ls.stdout?.trim() ?? 'empty';
    } catch {
      // non-fatal
    }
    const handle = await createSnapshot(sandbox, c.env.BACKUP_BUCKET);
    return c.json({
      success: true,
      message: 'Snapshot created successfully',
      backupId: handle.id,
      debug: { mountState, dirContents },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const status =
      errorMessage.includes('not configured') || errorMessage.includes('Missing') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: errorMessage,
      },
      status,
    );
  }
});

// POST /api/admin/storage/seed - Seed selected local state/workspace files into /home/openclaw
adminApi.post('/storage/seed', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = (await c.req.json()) as {
      files?: SeedFileInput[];
      createSnapshot?: boolean;
    };

    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) {
      return c.json({ success: false, error: 'files is required' }, 400);
    }

    const written: Array<{ path: string; bytes: number }> = [];

    for (const file of files) {
      const rawPath = typeof file.path === 'string' ? file.path : '';
      const hasContent = typeof file.contentBase64 === 'string';
      const contentBase64 = hasContent ? file.contentBase64 || '' : '';
      if (!rawPath || !hasContent) {
        return c.json({ success: false, error: 'Each file needs path and contentBase64' }, 400);
      }

      const targetPath = normalizeSeedPath(rawPath);
      const content = Buffer.from(contentBase64, 'base64').toString('utf-8');
      await sandbox.mkdir(pathPosix.dirname(targetPath), { recursive: true });
      await sandbox.writeFile(targetPath, content, { encoding: 'utf-8' });
      written.push({ path: targetPath, bytes: Buffer.byteLength(content, 'utf-8') });
    }

    let backupId: string | null = null;
    if (body.createSnapshot) {
      const handle = await createSnapshot(sandbox, c.env.BACKUP_BUCKET);
      backupId = handle.id;
    }

    return c.json({
      success: true,
      written,
      backupId,
      message: backupId
        ? 'Seed files written and snapshot created'
        : 'Seed files written successfully',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Kill the gateway process (shared logic with crash retry)
    const existingProcess = await findExistingGatewayProcess(sandbox);
    console.log('[Restart] Killing gateway, existing process:', existingProcess?.id ?? 'none');
    await killGateway(sandbox);

    // Signal that all Worker isolates need to re-restore from R2.
    // This writes a marker to R2 that restoreIfNeeded checks, ensuring
    // the FUSE overlay is mounted even if a different isolate handles
    // the next request (e.g. browser WebSocket reconnect).
    await signalRestoreNeeded(c.env.BACKUP_BUCKET);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, will restart on next request'
        : 'No existing process found, will start on next request',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);
api.route('/runtime', runtimeApi);

export { api };
