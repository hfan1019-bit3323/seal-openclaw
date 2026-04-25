import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const enabled = process.env.OPENCLAW_PRELOAD_EMBEDDED_RUNNER !== 'false';
const isGatewayChild = process.env.OPENCLAW_NODE_OPTIONS_READY === '1';

if (enabled && isGatewayChild) {
  const startedAt = Date.now();
  const distRoot =
    process.env.OPENCLAW_DIST_ROOT || '/usr/local/lib/node_modules/openclaw/dist';

  try {
    if (!existsSync(distRoot)) {
      throw new Error(`OpenClaw dist root not found: ${distRoot}`);
    }

    const files = readdirSync(distRoot)
      .filter((file) => /^attempt-execution\.runtime-.*\.js$/.test(file))
      .sort();

    if (files.length === 0) {
      throw new Error('attempt-execution runtime chunk not found');
    }

    for (const file of files) {
      await import(pathToFileURL(join(distRoot, file)).href);
    }

    const detail =
      process.env.OPENCLAW_PRELOAD_VERBOSE === 'true' ? ` (${files.join(', ')})` : '';
    console.log(`[preload] embedded runner runtime probe ready in ${Date.now() - startedAt}ms${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preload] embedded runner runtime probe skipped: ${message}`);
  }
}
