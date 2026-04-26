#!/usr/bin/env node
import fs from 'node:fs';

const configPath = process.env.OPENCLAW_CONFIG_PATH || '/root/.openclaw/openclaw.json';
const phaseArg = process.argv.find((arg) => arg.startsWith('--phase='));
const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'startup';

const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
};

const writeConfig = (config) => {
  fs.mkdirSync(configPath.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

const config = readConfig();

config.gateway = config.gateway || {};
config.channels = config.channels || {};

config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

config.gateway.auth = config.gateway.auth || {};
if (process.env.OPENCLAW_GATEWAY_TOKEN) {
  config.gateway.auth.mode = 'token';
  config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
} else {
  delete config.gateway.auth.mode;
  delete config.gateway.auth.token;
}
delete config.gateway.auth.password;

config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.heartbeat = config.agents.defaults.heartbeat || {};
config.agents.defaults.heartbeat.every = '0m';

// Cloud product baseline: the web app is an OpenClaw renderer, not a developer
// workstation. Keep ordinary chat on a lean tool profile; Agent Teams can opt
// into heavier tools explicitly when the strategy layer needs them.
config.tools = config.tools || {};
config.tools.profile = 'minimal';
config.tools.web = config.tools.web || {};
config.tools.web.search = config.tools.web.search || {};
config.tools.web.search.enabled = false;

config.browser = config.browser || {};
config.browser.enabled = false;

config.plugins = config.plugins || {};
config.plugins.enabled = true;
delete config.plugins.allow;

const latencyHeavyPluginDeny = [
  'acpx',
  'browser',
  'phone-control',
  'talk-voice',
  'amazon-bedrock',
  'amazon-bedrock-mantle',
  'xai',
];
config.plugins.deny = [...latencyHeavyPluginDeny];
config.plugins.slots = config.plugins.slots || {};
config.plugins.slots.memory = 'memory-core';

if (process.env.OPENCLAW_DEV_MODE === 'true') {
  config.gateway.controlUi.allowInsecureAuth = true;
  config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
}

if (process.env.CF_AI_GATEWAY_MODEL) {
  const raw = process.env.CF_AI_GATEWAY_MODEL;
  const slashIdx = raw.indexOf('/');
  const gwProvider = raw.substring(0, slashIdx);
  const modelId = raw.substring(slashIdx + 1);

  const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
  const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

  let baseUrl;
  if (accountId && gatewayId) {
    baseUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${gwProvider}`;
    if (gwProvider === 'workers-ai') baseUrl += '/v1';
  } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
    baseUrl = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1`;
  }

  if (baseUrl && apiKey) {
    const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
    const providerName = `cf-ai-gw-${gwProvider}`;

    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers[providerName] = {
      baseUrl,
      apiKey,
      api,
      models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
    };
    config.agents.defaults.model = { primary: `${providerName}/${modelId}` };
  }
}

const desiredOpenRouterModelId = 'anthropic/claude-sonnet-4.6';
const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
const gatewayApiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
if (accountId && gatewayId && gatewayApiKey) {
  const openRouterBaseUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openrouter`;
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  config.models.providers['cf-ai-gw-openrouter'] = {
    baseUrl: openRouterBaseUrl,
    apiKey: gatewayApiKey,
    api: 'openai-completions',
    models: [
      {
        id: desiredOpenRouterModelId,
        name: desiredOpenRouterModelId,
        contextWindow: 1000000,
        maxTokens: 8192,
      },
    ],
  };
  config.agents.defaults.model = {
    primary: `cf-ai-gw-openrouter/${desiredOpenRouterModelId}`,
  };
}

// Direct OpenRouter (no AI Gateway) — opt-in latency comparison path.
// Activates only when OPENCLAW_USE_DIRECT_OPENROUTER=1 AND we have a key.
// Wins over the cf-ai-gw-openrouter default by being applied AFTER it.
const directOpenRouterKey = process.env.OPENROUTER_API_KEY;
const useDirectOpenRouter = process.env.OPENCLAW_USE_DIRECT_OPENROUTER === '1';
if (useDirectOpenRouter && directOpenRouterKey) {
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  config.models.providers['direct-openrouter'] = {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: directOpenRouterKey,
    api: 'openai-completions',
    models: [
      {
        id: desiredOpenRouterModelId,
        name: desiredOpenRouterModelId,
        contextWindow: 1000000,
        maxTokens: 8192,
      },
    ],
  };
  config.agents.defaults.model = {
    primary: `direct-openrouter/${desiredOpenRouterModelId}`,
  };
}

const directGatewayProvider = config.models?.providers?.['cloudflare-ai-gateway'];
if (
  directGatewayProvider &&
  typeof directGatewayProvider === 'object' &&
  typeof directGatewayProvider.baseUrl === 'string' &&
  directGatewayProvider.baseUrl.includes('/anthropic')
) {
  directGatewayProvider.models = [
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      reasoning: true,
      input: ['text', 'image'],
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
      contextWindow: 1000000,
      maxTokens: 64000,
    },
  ];
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
  config.channels.telegram = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    enabled: true,
    dmPolicy,
  };
  if (process.env.TELEGRAM_DM_ALLOW_FROM) {
    config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
  } else if (dmPolicy === 'open') {
    config.channels.telegram.allowFrom = ['*'];
  }
}

if (process.env.DISCORD_BOT_TOKEN) {
  const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
  const dm = { policy: dmPolicy };
  if (dmPolicy === 'open') dm.allowFrom = ['*'];
  config.channels.discord = {
    token: process.env.DISCORD_BOT_TOKEN,
    enabled: true,
    dm,
  };
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  config.channels.slack = {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    enabled: true,
  };
}

writeConfig(config);
console.log(
  `[configure] product config enforced (${phase}): tools.profile=${config.tools.profile}, model=${config.agents.defaults.model?.primary ?? 'unset'}`
);
