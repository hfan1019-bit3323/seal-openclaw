import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { waitForProcess } from '../gateway';
import { createSnapshot, restoreIfNeeded } from '../persistence';

const runtimeApi = new Hono<AppEnv>();

runtimeApi.use('*', createAccessMiddleware({ type: 'json' }));

type SessionIndexEntry = {
  sessionId?: string;
  updatedAt?: number;
  sessionFile?: string;
  origin?: {
    provider?: string;
    surface?: string;
    label?: string;
  };
  deliveryContext?: {
    channel?: string;
  };
};

type SessionIndex = Record<string, SessionIndexEntry>;

type RuntimeChatSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  sessionKey: string;
};

type RuntimeChatMessage = {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: 'text'; text: string }>;
  attachments: unknown[];
  createdAt: string;
};

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const readNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const readJsonFile = async <T>(
  sandbox: AppEnv['Variables']['sandbox'],
  path: string,
): Promise<T> => {
  const proc = await sandbox.startProcess(`cat ${path}`);
  await waitForProcess(proc, 10000);
  const logs = await proc.getLogs();
  if (proc.exitCode !== 0) {
    throw new Error(logs.stderr || `Failed to read ${path}`);
  }
  return JSON.parse(logs.stdout || '{}') as T;
};

const fileExists = async (
  sandbox: AppEnv['Variables']['sandbox'],
  path: string,
): Promise<boolean> => {
  const proc = await sandbox.startProcess(`sh -lc 'test -f "$1"' -- ${JSON.stringify(path)}`);
  await waitForProcess(proc, 10000);
  return proc.exitCode === 0;
};

const readTextFile = async (
  sandbox: AppEnv['Variables']['sandbox'],
  path: string,
): Promise<string> => {
  const result = await sandbox.exec(`cat ${JSON.stringify(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to read ${path}`);
  }
  return result.stdout || '';
};

const readTextFileHead = async (
  sandbox: AppEnv['Variables']['sandbox'],
  path: string,
  lineCount: number = 200,
): Promise<string> => {
  const result = await sandbox.exec(`sed -n '1,${lineCount}p' ${JSON.stringify(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to read ${path}`);
  }
  return result.stdout || '';
};

const deleteMatchingTranscriptFiles = async (
  sandbox: AppEnv['Variables']['sandbox'],
  agentId: string,
  transcriptStem: string,
): Promise<string[]> => {
  const escapedAgentId = JSON.stringify(agentId);
  const escapedStem = JSON.stringify(transcriptStem);
  const result = await sandbox.exec(
    `sh -lc 'agent=$1; stem=$2; find /home/openclaw -type f -path "*/agents/$agent/sessions/$stem.jsonl*" -print -delete' -- ${escapedAgentId} ${escapedStem}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to delete transcript files for ${transcriptStem}`);
  }
  return (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const deleteSessionIndexEntry = async (
  sandbox: AppEnv['Variables']['sandbox'],
  indexPath: string,
  sessionKey: string,
): Promise<void> => {
  const command = [
    'node -e',
    JSON.stringify(
      `const fs=require('node:fs');` +
        `const path=${JSON.stringify(indexPath)};` +
        `const sessionKey=${JSON.stringify(sessionKey)};` +
        `const raw=fs.readFileSync(path,'utf8');` +
        `const data=raw.trim()?JSON.parse(raw):{};` +
        `delete data[sessionKey];` +
        `fs.writeFileSync(path, JSON.stringify(data, null, 2));`,
    ),
  ].join(' ');
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to update session index ${indexPath}`);
  }
};

const normalizeRuntimePrefix = (value: string | null | undefined): string => {
  const normalized = (value || 'seal').trim().toLowerCase();
  return normalized.replace(/[^a-z0-9:_-]+/g, '-') || 'seal';
};

const buildSessionKeyPrefix = (agentId: string, sessionKeyPrefix: string) =>
  `agent:${agentId}:${normalizeRuntimePrefix(sessionKeyPrefix)}:`;

const stripTranscriptSuffix = (value: string): string =>
  value.replace(/\.jsonl(?:\.reset\..+)?$/i, '');

const resolveSessionIndexPath = async (
  sandbox: AppEnv['Variables']['sandbox'],
  agentId: string,
): Promise<string | null> => {
  const candidates = [
    `/home/openclaw/clawd/.persist/openclaw/agents/${agentId}/sessions/sessions.json`,
    `/home/openclaw/.openclaw/agents/${agentId}/sessions/sessions.json`,
    `/root/.openclaw/agents/${agentId}/sessions/sessions.json`,
    `/workspace/.openclaw/agents/${agentId}/sessions/sessions.json`,
  ];

  for (const candidate of candidates) {
    // The container layout differs across OpenClaw versions; probe the common roots.
    // Missing history should degrade to an empty list, not a hard 500.
    // eslint-disable-next-line no-await-in-loop -- small bounded probe list
    if (await fileExists(sandbox, candidate)) return candidate;
  }

  return null;
};

const listSessionTranscriptFiles = async (
  sandbox: AppEnv['Variables']['sandbox'],
  agentId: string,
): Promise<string[]> => {
  const proc = await sandbox.startProcess(
    `sh -lc 'agent="$1"; find /home/openclaw -type f -path "*/agents/\${agent}/sessions/*.jsonl" | sort' -- ${JSON.stringify(agentId)}`,
  );
  await waitForProcess(proc, 10000);
  const logs = await proc.getLogs();
  if (proc.exitCode !== 0 && !(logs.stdout || '').trim()) return [];

  const files = (logs.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const preferredByStem = new Map<string, string>();

  for (const file of files) {
    const basename = file.split('/').pop() || file;
    const stem = stripTranscriptSuffix(basename);
    const current = preferredByStem.get(stem);
    const isPersisted = file.includes('/clawd/.persist/openclaw/');
    const currentIsPersisted = current?.includes('/clawd/.persist/openclaw/') || false;

    if (!current || (isPersisted && !currentIsPersisted)) {
      preferredByStem.set(stem, file);
    }
  }

  return [...preferredByStem.values()];
};

const stripSenderEnvelope = (text: string): string =>
  text
    .replace(
      /^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i,
      '',
    )
    .replace(/^\[[^\]]+\]\s*/i, '')
    .trim();

const stripDirectiveTags = (text: string): string =>
  text.replace(/\[\[(reply_to_current|reply_to:[^\]]+|audio_as_voice)\]\]/gi, '').trim();

const extractTextContent = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const buildChatTitle = (text: string): string => {
  const normalized = stripSenderEnvelope(stripDirectiveTags(text)).replace(/\s+/g, ' ').trim();
  if (!normalized) return '新对话';
  return normalized.length > 28 ? `${normalized.slice(0, 28)}...` : normalized;
};

const isBackgroundTranscript = (
  sessionStem: string,
  parsed: { messages: RuntimeChatMessage[]; title: string | null },
): boolean => {
  const normalizedStem = sessionStem.toLowerCase();
  if (
    normalizedStem.startsWith('heartbeat') ||
    normalizedStem.startsWith('cron-') ||
    normalizedStem.startsWith('wake-')
  ) {
    return true;
  }

  const firstUserMessage = parsed.messages.find((message) => message.role === 'user');
  const firstText = firstUserMessage?.parts[0]?.text?.toLowerCase() || '';
  return firstText.includes('read heartbeat.md') || firstText.includes('reply heartbeat_ok');
};

const parseTranscript = (
  chatId: string,
  transcript: string,
): { messages: RuntimeChatMessage[]; createdAt: string | null; title: string | null } => {
  const lines = transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const messages: RuntimeChatMessage[] = [];
  let createdAt: string | null = null;
  let firstUserText: string | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'message') continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') continue;
    const role = readString(message.role);
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = stripDirectiveTags(stripSenderEnvelope(extractTextContent(message.content)));
    if (!text) continue;

    const timestamp = readString(record.timestamp) || readString(message.timestamp) || new Date().toISOString();
    if (!createdAt) createdAt = timestamp;
    if (role === 'user' && !firstUserText) firstUserText = text;

    messages.push({
      id: readString(record.id) || crypto.randomUUID(),
      chatId,
      role,
      parts: [{ type: 'text', text }],
      attachments: [],
      createdAt: timestamp,
    });
  }

  return {
    messages,
    createdAt,
    title: firstUserText ? buildChatTitle(firstUserText) : null,
  };
};

const loadRuntimeSessionIndex = async (
  sandbox: AppEnv['Variables']['sandbox'],
  agentId: string,
  sessionKeyPrefix: string,
): Promise<Array<{ chat: RuntimeChatSummary; sessionFile: string }>> => {
  const indexPath = await resolveSessionIndexPath(sandbox, agentId);
  const keyPrefix = buildSessionKeyPrefix(agentId, sessionKeyPrefix);
  const entries: Array<{ chat: RuntimeChatSummary; sessionFile: string }> = [];

  if (indexPath) {
    const index = await readJsonFile<SessionIndex>(sandbox, indexPath);

    for (const [sessionKey, entry] of Object.entries(index)) {
      if (!sessionKey.startsWith(keyPrefix)) continue;
      const sessionFile = readString(entry.sessionFile);
      if (!sessionFile) continue;

      const provider = entry.origin?.provider || entry.deliveryContext?.channel || '';
      if (provider && provider !== 'webchat') continue;

      const chatId = sessionKey.slice(keyPrefix.length);
      let transcript = '';
      try {
        transcript = await readTextFileHead(sandbox, sessionFile);
      } catch {
        continue;
      }
      const parsed = parseTranscript(chatId, transcript);
      const updatedAtValue = readNumber(entry.updatedAt);
      const updatedAt = updatedAtValue
        ? new Date(updatedAtValue).toISOString()
        : parsed.createdAt || new Date().toISOString();

      entries.push({
        chat: {
          id: chatId,
          title: parsed.title || '新对话',
          createdAt: parsed.createdAt || updatedAt,
          updatedAt,
          sessionId: readString(entry.sessionId),
          sessionKey,
        },
        sessionFile,
      });
    }
  }

  if (entries.length === 0) {
    const transcripts = await listSessionTranscriptFiles(sandbox, agentId);
    const normalizedPrefix = `${normalizeRuntimePrefix(sessionKeyPrefix)}:`;

    for (const sessionFile of transcripts) {
      const basename = sessionFile.split('/').pop() || sessionFile;
      const sessionStem = stripTranscriptSuffix(basename);
      if (sessionStem.endsWith('.reset')) continue;

      const rawChatId = sessionStem.startsWith(normalizedPrefix)
        ? sessionStem.slice(normalizedPrefix.length)
        : sessionStem;
      const chatId = rawChatId || sessionStem;
      let transcript = '';
      try {
        transcript = await readTextFileHead(sandbox, sessionFile);
      } catch (error) {
        console.log('[runtime-history] fallback read failed', {
          sessionFile,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const parsed = parseTranscript(chatId, transcript);
      const background = isBackgroundTranscript(sessionStem, parsed);
      if (parsed.messages.length === 0) continue;
      if (background) continue;
      const updatedAt = parsed.createdAt || new Date().toISOString();

      entries.push({
        chat: {
          id: chatId,
          title: parsed.title || '新对话',
          createdAt: parsed.createdAt || updatedAt,
          updatedAt,
          sessionId: sessionStem,
          sessionKey: sessionStem,
        },
        sessionFile,
      });
    }
  }

  return entries.sort((a, b) => Date.parse(b.chat.updatedAt) - Date.parse(a.chat.updatedAt));
};

runtimeApi.get('/chats', async (c) => {
  const sandbox = c.get('sandbox');
  await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);

  const sessionKeyPrefix = c.req.query('prefix') || 'seal';
  const agentId = c.req.query('agentId') || 'main';
  const chats = await loadRuntimeSessionIndex(sandbox, agentId, sessionKeyPrefix);

  return c.json({
    chats: chats.map((entry) => entry.chat),
  });
});

runtimeApi.get('/chats/:chatId', async (c) => {
  const sandbox = c.get('sandbox');
  await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);

  const chatId = c.req.param('chatId');
  const sessionKeyPrefix = c.req.query('prefix') || 'seal';
  const agentId = c.req.query('agentId') || 'main';
  const chats = await loadRuntimeSessionIndex(sandbox, agentId, sessionKeyPrefix);
  const matched = chats.find((entry) => entry.chat.id === chatId);

  if (!matched) {
    return c.json({ error: 'Chat not found' }, 404);
  }

  const transcript = await readTextFile(sandbox, matched.sessionFile);
  const parsed = parseTranscript(chatId, transcript);

  return c.json({
    chat: matched.chat,
    messages: parsed.messages,
  });
});

runtimeApi.delete('/chats/:chatId', async (c) => {
  const sandbox = c.get('sandbox');
  await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);

  const chatId = c.req.param('chatId');
  const sessionKeyPrefix = c.req.query('prefix') || 'seal';
  const agentId = c.req.query('agentId') || 'main';
  const chats = await loadRuntimeSessionIndex(sandbox, agentId, sessionKeyPrefix);
  const matched = chats.find((entry) => entry.chat.id === chatId);

  if (!matched) {
    return c.json({ error: 'Chat not found' }, 404);
  }

  const transcriptBasename = matched.sessionFile.split('/').pop() || '';
  const transcriptStem = stripTranscriptSuffix(transcriptBasename);
  const deletedFiles = await deleteMatchingTranscriptFiles(sandbox, agentId, transcriptStem);

  const indexPath = await resolveSessionIndexPath(sandbox, agentId);
  if (indexPath) {
    await deleteSessionIndexEntry(sandbox, indexPath, matched.chat.sessionKey);
  }

  const backup = await createSnapshot(sandbox, c.env.BACKUP_BUCKET);

  return c.json({
    success: true,
    deletedChatId: chatId,
    deletedFiles,
    backupId: backup.id,
  });
});

export { runtimeApi };
