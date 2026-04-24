#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Runs openclaw onboard --non-interactive to configure from env vars
# 2. Patches config for features onboard doesn't cover (channels, gateway auth)
# 3. Starts the gateway
#
# NOTE: Persistence (backup/restore) is handled by the Sandbox SDK at the
# Worker level, not inside the container. The Worker calls createBackup()
# and restoreBackup() which use squashfs snapshots stored in R2.
# No rclone or R2 credentials are needed inside the container.

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
PERSIST_STATE_DIR="/home/openclaw/clawd/.persist/openclaw"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# Restore mirrored runtime state from the persistent workspace area.
# The Sandbox snapshot path reliably preserves /home/openclaw/clawd, so we
# mirror .openclaw there before backup and hydrate it back on boot.
if [ -d "$PERSIST_STATE_DIR" ]; then
    echo "Restoring mirrored OpenClaw state from $PERSIST_STATE_DIR"
    mkdir -p /home/openclaw/.openclaw
    cp -a "$PERSIST_STATE_DIR/." /home/openclaw/.openclaw/
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    # Determine auth choice — openclaw onboard reads the actual key values
    # from environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    # so we only pass --auth-choice, never the key itself, to avoid
    # exposing secrets in process arguments visible via ps/proc.
    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth shared by runtime / Control UI / outer Worker
# - Trusted proxies for sandbox networking metadata
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
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

// Product chat should boot as a lean OpenClaw kernel, not as the full
// developer workstation profile. Expensive tools can be re-enabled explicitly
// when Agent Teams need them, but they should not block ordinary first-token
// latency for the web product path.
config.tools = config.tools || {};
config.tools.profile = 'minimal';
config.tools.web = config.tools.web || {};
config.tools.web.search = config.tools.web.search || {};
config.tools.web.search.enabled = false;

config.browser = config.browser || {};
config.browser.enabled = false;

config.plugins = config.plugins || {};
config.plugins.enabled = true;

// Product cloud baseline:
// OpenClaw ships many bundled plugins enabled by default for workstation use.
// For 2026.4.21, keep the default plugin graph intact and only use deny.
// Cloud recovery testing showed both restrictive plugins.allow and explicit
// entries.enabled=false can hang the Gateway during startup.
delete config.plugins.allow;

// Keep the deny list as a belt-and-suspenders guard for particularly expensive
// or workstation-only plugins, including aliases that may not be present in a
// given OpenClaw build.
const latencyHeavyPluginDeny = [
    'acpx',
    'browser',
    'phone-control',
    'talk-voice',
    'amazon-bedrock',
    'amazon-bedrock-mantle',
    'xai'
];
const existingPluginDeny = Array.isArray(config.plugins.deny) ? config.plugins.deny : [];
config.plugins.deny = Array.from(new Set([...existingPluginDeny, ...latencyHeavyPluginDeny]));
delete config.plugins.entries;
config.plugins.slots = config.plugins.slots || {};
config.plugins.slots.memory = 'memory-core';

// Allow any origin to connect to the gateway control UI.
// The gateway runs inside a Cloudflare Container behind the Worker, which
// proxies requests from the public workers.dev domain. Without this,
// openclaw >= 2026.2.26 rejects WebSocket connections because the browser's
// origin (https://....workers.dev) doesn't match the gateway's localhost.
// Security is handled by CF Access + gateway token auth, not origin checks.
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
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
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: providerName + '/' + modelId };
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Normalize the OpenRouter Claude default to Sonnet 4.6.
// We keep the proven CF AI Gateway -> OpenRouter path, but stop falling back
// to the older 4.5 catalog on restart. This keeps cloud behavior aligned with
// the current Anthropic default without changing the outer routing model.
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
                maxTokens: 8192
            }
        ]
    };
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = { primary: `cf-ai-gw-openrouter/${desiredOpenRouterModelId}` };
}

// Keep the direct Cloudflare AI Gateway provider catalog in sync as a fallback
// reference, even though the primary path remains OpenRouter.
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
                cacheWrite: 3.75
            },
            contextWindow: 1000000,
            maxTokens: 64000
        }
    ];
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

# Keep the inner Gateway on Moltworker's native token auth path so the
# outer Worker, runtime bridge, and Control UI all share the same contract.
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
else
    echo "Starting gateway with device pairing (no token)..."
fi
exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
