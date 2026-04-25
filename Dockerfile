FROM docker.io/cloudflare/sandbox:0.7.20

# Install Node.js 22 (required by OpenClaw)
# The base image has Node 20, we need to replace it with Node 22
# Using direct binary download for reliability
# Note: rclone is no longer needed — persistence uses Sandbox SDK backup/restore API
ENV NODE_VERSION=22.22.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install OpenClaw
# Pin to specific version for reproducible builds
#
# OPENCLAW_EAGER_BUNDLED_PLUGIN_DEPS=1 makes the package's postinstall script
# install bundled plugin runtime deps during image build instead of lazily on
# the first gateway boot. This pulls in deps for plugins we will never use
# (amazon-bedrock, telegram, whatsapp, etc.) but moves those installs out of
# the cold-start critical path on every container wake. Without it, the
# gateway runs `npm install <plugin-deps>` at first start, which has been
# observed to add ~50s to first-token latency.
ENV OPENCLAW_EAGER_BUNDLED_PLUGIN_DEPS=1
RUN npm install -g openclaw@2026.4.21 \
    && openclaw --version

# Cloud product runtime pre-bake:
# OpenClaw's eager postinstall places bundled plugin deps at the package root,
# but the Gateway still expects plugin-local node_modules for some default
# bundled providers before the deny list fully helps. Keep the plugin dirs
# intact, but move those npm installs into image build time.
RUN cd /usr/local/lib/node_modules/openclaw/dist/extensions/amazon-bedrock \
    && npm install --ignore-scripts --package-lock=false --save=false --legacy-peer-deps \
    && cd /usr/local/lib/node_modules/openclaw/dist/extensions/amazon-bedrock-mantle \
    && npm install --ignore-scripts --package-lock=false --save=false --legacy-peer-deps

# Use /home/openclaw as the home directory instead of /root.
# The Sandbox SDK backup API only allows directories under /home, /workspace,
# /tmp, or /var/tmp — not /root.
ENV HOME=/home/openclaw
RUN mkdir -p /home/openclaw/.openclaw \
    && mkdir -p /home/openclaw/clawd \
    && mkdir -p /home/openclaw/clawd/skills \
    && ln -s /home/openclaw/.openclaw /root/.openclaw \
    && ln -s /home/openclaw/clawd /root/clawd

# Copy startup script
# Use a real Docker instruction instead of a comment so changes to the
# startup flow always invalidate cached layers during wrangler deploy.
ARG IMAGE_CACHE_BUST=2026-04-25-v41-product-config-enforcer
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
COPY openclaw-embedded-runner-preload.mjs /usr/local/bin/openclaw-embedded-runner-preload.mjs
COPY configure-openclaw-product.mjs /usr/local/bin/configure-openclaw-product.mjs
RUN chmod +x /usr/local/bin/start-openclaw.sh /usr/local/bin/configure-openclaw-product.mjs

# Copy custom skills
COPY skills/ /home/openclaw/clawd/skills/

# Bake seal ai workspace skeleton (R2 sync overlays on top at runtime)
COPY workspace/SOUL.md   /home/openclaw/clawd/SOUL.md
COPY workspace/AGENTS.md /home/openclaw/clawd/AGENTS.md
COPY workspace/USER.md   /home/openclaw/clawd/USER.md
COPY workspace/skills/   /home/openclaw/clawd/skills/

# Ensure all files are readable for mksquashfs (Sandbox SDK backup).
# OpenClaw and other tools may create restrictive config files at runtime,
# but we fix build-time permissions here; runtime permissions are fixed
# before each backup via sandbox.exec("chmod -R a+rX /home/openclaw").
RUN chmod -R a+rX /home/openclaw

# Set working directory
WORKDIR /home/openclaw/clawd

# Expose the gateway port
EXPOSE 18789
