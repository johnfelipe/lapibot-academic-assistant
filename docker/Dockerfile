FROM node:20-slim

WORKDIR /app

# Install dependencies first (better caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled code
COPY dist/ ./dist/

# Install git + SSH (needed for auto-pulling course updates via GitHub webhook)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN git config --system safe.directory /app/courses

# SSH config for node user — deploy key is mounted read-only at runtime
RUN mkdir -p /home/node/.ssh && chmod 700 /home/node/.ssh \
    && ssh-keyscan github.com > /home/node/.ssh/known_hosts 2>/dev/null \
    && printf 'Host github.com\n  IdentityFile /home/node/.ssh/github_deploy_courses\n  StrictHostKeyChecking accept-new\n' > /home/node/.ssh/config \
    && chmod 600 /home/node/.ssh/config \
    && chown -R node:node /home/node/.ssh

# Run as node user (uid=1000) — matches host's lapibot user who owns /opt/lapibot-courses
USER node

EXPOSE 3001 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
