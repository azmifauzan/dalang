FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install -g pnpm@10.34.9 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json README.md LICENSE ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY packages ./packages
RUN --mount=type=cache,target=/pnpm/store pnpm build \
    && pnpm --filter dalang-cli deploy --prod --legacy --store-dir /pnpm/store /app \
    && node /app/bin/dalang.js --version

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl dbus git gh gnome-keyring gzip libglib2.0-bin lsof tar xdg-dbus-proxy \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /workspace
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/dalang-entrypoint
ENV PATH="/home/node/.local/bin:${PATH}" \
    DALANG_CONTAINER=1 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dalang-session/bus \
    XDG_RUNTIME_DIR=/tmp/dalang-session
USER node
WORKDIR /home/node
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh \
    && bash /tmp/claude-install.sh \
    && curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh \
    && CODEX_NON_INTERACTIVE=1 sh /tmp/codex-install.sh \
    && curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh \
    && bash /tmp/agy-install.sh \
    && rm /tmp/claude-install.sh /tmp/codex-install.sh /tmp/agy-install.sh \
    && claude --version && codex --version && agy --version
COPY --from=build /app /app
EXPOSE 4173
ENTRYPOINT ["dalang-entrypoint"]
CMD ["node", "/app/bin/dalang.js", "web", "--no-open"]
