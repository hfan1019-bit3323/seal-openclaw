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
# PATCH CONFIG (product cloud source of truth)
# ============================================================
/usr/local/bin/configure-openclaw-product.mjs --phase=startup

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

OPENCLAW_BIN="$(command -v openclaw)"
PRELOAD_SCRIPT="/usr/local/bin/openclaw-embedded-runner-preload.mjs"

if [ "${OPENCLAW_PRELOAD_EMBEDDED_RUNNER:-true}" = "false" ]; then
    exec "$OPENCLAW_BIN" gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi

echo "Preloading embedded runner runtime in gateway process (no model call)..."
exec node --import "$PRELOAD_SCRIPT" "$OPENCLAW_BIN" gateway --port 18789 --verbose --allow-unconfigured --bind lan
