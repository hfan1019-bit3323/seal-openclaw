#!/usr/bin/env node
/**
 * Build-time instrumentation for the OpenClaw embedded-runner cold gap.
 *
 * Background: cold first-token latency shows ~45s between
 *   `embedded run start: runId=...`
 *   `embedded run prompt start: runId=...`
 * The current preload (`openclaw-embedded-runner-preload.mjs`) already loads
 * `attempt-execution.runtime-*.js` in the gateway child, so the gap is not
 * raw chunk import time — it's per-conversation prep (sandbox resolve,
 * resource loader reload, MCP/LSP runtime materialization, agent session
 * creation, etc.).
 *
 * Without measurement we can't tell which step dominates, so this script
 * patches the `selection-*.js` chunk in the installed openclaw package to
 * insert single-line `[gap-trace] <label> +<deltaMs>ms total=<totalMs>ms`
 * markers before every major await between the two existing log lines. The
 * markers go to stderr so they show up in `wrangler tail` output without
 * needing a debug log level.
 *
 * Idempotent: re-running on an already-patched file is a no-op.
 *
 * Anchors are content-based, not line-based, so they survive minor upstream
 * shuffling. If openclaw upgrades and an anchor is renamed the patch
 * silently skips that anchor (and the build still succeeds — the gateway
 * just loses one trace point).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const distRoot =
  process.argv[2] ||
  process.env.OPENCLAW_DIST_ROOT ||
  '/usr/local/lib/node_modules/openclaw/dist';

if (!existsSync(distRoot)) {
  console.error(`[instrument] openclaw dist root not found: ${distRoot}`);
  process.exit(0);
}

// Multiple chunks match `selection-*.js`. The one we want contains both the
// `embedded run start` and `embedded run prompt start` log strings — that's
// the runEmbeddedAttempt body. Pick by content, not by filename.
const candidates = readdirSync(distRoot).filter((name) =>
  /^selection-.*\.js$/.test(name),
);
const file = candidates.find((name) => {
  try {
    const txt = readFileSync(join(distRoot, name), 'utf8');
    return (
      txt.includes('embedded run start: runId=') &&
      txt.includes('embedded run prompt start: runId=')
    );
  } catch {
    return false;
  }
});
if (!file) {
  console.error(
    `[instrument] no selection-*.js chunk contains the embedded-run anchors (candidates: ${candidates.join(', ') || 'none'})`,
  );
  process.exit(0);
}

const filePath = join(distRoot, file);
let src = readFileSync(filePath, 'utf8');

const helperKey = '__OC_GAP_TRACE_HELPER_v1__';
if (src.includes(helperKey)) {
  console.error(`[instrument] ${file} already patched, skipping`);
  process.exit(0);
}

// Helper that records a timestamped marker. Module-scoped state keeps
// per-run timing simple: __ocGapTraceStart is reset every time we see the
// `embedded run start` log line, so deltas are relative to that.
const helper = `\n// ${helperKey}\nlet __ocGapTraceStart = 0;\nlet __ocGapTraceLast = 0;\nfunction __ocGapTraceReset() { __ocGapTraceStart = performance.now(); __ocGapTraceLast = __ocGapTraceStart; }\nfunction __ocGapTraceMark(label) { try { const now = performance.now(); const total = (now - __ocGapTraceStart).toFixed(1); const delta = (now - __ocGapTraceLast).toFixed(1); __ocGapTraceLast = now; console.error('[gap-trace] ' + label + ' +' + delta + 'ms total=' + total + 'ms'); } catch {} }\n`;

// Insert helper immediately after the last top-level static import.
const importBlockEnd = (() => {
  let idx = 0;
  const importRe = /^(import\b[^\n]*|import[\s\S]*?from\s+['"][^'"]+['"];?)\s*$/gm;
  let match;
  while ((match = importRe.exec(src)) !== null) {
    idx = match.index + match[0].length;
  }
  return idx;
})();
src = src.slice(0, importBlockEnd) + '\n' + helper + src.slice(importBlockEnd);

// Anchors: each entry maps a unique substring in the source to a label that
// will appear in the trace. We INSERT the trace-mark line *before* the
// anchor line, so the mark records "we are about to enter <label>".
const anchors = [
  // Reset at the existing `embedded run start` debug call so timings are
  // relative to that log line. The `__ocGapTraceReset()` call replaces the
  // existing line via prefix injection.
  {
    needle:
      'log$3.debug(`embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`);',
    label: null, // sentinel: emits __ocGapTraceReset() instead of a mark
  },
  {
    needle: 'const sandbox = await resolveSandboxContext({',
    label: 'before resolveSandboxContext',
  },
  {
    needle: 'const { sessionAgentId } = resolveSessionAgentIds({',
    label: 'after resolveSandboxContext',
  },
  {
    needle: 'const sessionLock = await acquireSessionWriteLock({',
    label: 'before acquireSessionWriteLock',
  },
  {
    needle: 'const sessionLabel = params.sessionKey ?? params.sessionId;',
    label: 'after acquireSessionWriteLock',
  },
  {
    needle: 'const bootstrapRouting = await resolveAttemptWorkspaceBootstrapRouting({',
    label: 'before resolveAttemptWorkspaceBootstrapRouting',
  },
  {
    needle:
      'const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles: resolvedContextFiles, shouldRecordCompletedBootstrapTurn } = await resolveAttemptBootstrapContext({',
    label: 'before resolveAttemptBootstrapContext',
  },
  {
    needle: 'const bundleMcpSessionRuntime = toolsEnabled ? await getOrCreateSessionMcpRuntime({',
    label: 'before getOrCreateSessionMcpRuntime',
  },
  {
    needle:
      'const bundleMcpRuntime = bundleMcpSessionRuntime ? await materializeBundleMcpToolsForRun({',
    label: 'before materializeBundleMcpToolsForRun',
  },
  {
    needle: 'const bundleLspRuntime = toolsEnabled ? await createBundleLspToolRuntime({',
    label: 'before createBundleLspToolRuntime',
  },
  {
    needle: 'await prewarmSessionFile(params.sessionFile);',
    label: 'before prewarmSessionFile',
  },
  {
    needle: 'await runAttemptContextEngineBootstrap({',
    label: 'before runAttemptContextEngineBootstrap',
  },
  {
    needle: 'await prepareSessionManagerForRun({',
    label: 'before prepareSessionManagerForRun',
  },
  {
    needle: 'await resourceLoader.reload();',
    label: 'before resourceLoader.reload',
  },
  {
    needle: '({session} = await createAgentSession({',
    label: 'before createAgentSession',
  },
  {
    needle:
      'log$3.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId} ` + routingSummary);',
    label: 'before embedded run prompt start',
  },
];

let patched = 0;
let missing = 0;
for (const anchor of anchors) {
  const idx = src.indexOf(anchor.needle);
  if (idx === -1) {
    console.error(`[instrument] anchor not found, skipping: ${anchor.label ?? '(reset)'}`);
    missing += 1;
    continue;
  }
  // Find the start of the anchor's line so we can preserve indentation.
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const indent = src.slice(lineStart, idx);
  const insertion =
    anchor.label === null
      ? `${indent}__ocGapTraceReset();\n`
      : `${indent}__ocGapTraceMark(${JSON.stringify(anchor.label)});\n`;
  src = src.slice(0, lineStart) + insertion + src.slice(lineStart);
  patched += 1;
}

writeFileSync(filePath, src);
console.error(
  `[instrument] patched ${file}: ${patched} markers inserted, ${missing} anchors missing`,
);
