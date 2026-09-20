# syntax=docker/dockerfile:1.7
# Humanize self-hosted runner. Reviews private repositories inside the customer's network
# using a local model, so repository content never reaches a cloud provider.

FROM node:22.23.2-bookworm-slim AS build
WORKDIR /src
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable
# Manifests first: dependency installation is cached until a manifest actually changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.build.json ./
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build
# `pnpm deploy` resolves the workspace links into a self-contained tree. Copying the
# workspace as-is does not work: each package's links live in its own node_modules, which a
# build context excludes, so the runtime cannot resolve @humanize/* at all.
RUN pnpm --filter=@humanize/runner --prod --legacy deploy /out

FROM node:22.23.2-bookworm-slim AS runtime
# git is the one external binary the runner needs: repositories are cloned, never built.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# An unprivileged account. The runner holds a repository-scoped read-only token and a local
# model endpoint; nothing it does requires root, so nothing it does gets root.
RUN groupadd --system --gid 10001 humanize \
 && useradd --system --uid 10001 --gid humanize --home /home/humanize --create-home humanize

WORKDIR /app
COPY --from=build --chown=root:root /out ./

# The only writable path. Workspaces are ephemeral and deleted after every job; mounting a
# tmpfs here keeps repository content off disk entirely.
ENV HUMANIZE_WORKSPACE_ROOT=/workspace
RUN mkdir -p /workspace && chown humanize:humanize /workspace
# A tmpfs mounted here is owned by root unless the mount says otherwise, so a deployment
# must pass uid=10001,gid=10001; see compose.yaml. The build-time owner only covers the
# case where the path is left as an ordinary directory in the image.
VOLUME ["/workspace"]

USER humanize:humanize
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    OLLAMA_BASE_URL=http://host.docker.internal:11434

# No EXPOSE and no port binding: the runner dials out to the control plane and to a local
# model, and nothing ever dials in. Ollama is reached across the host boundary rather than
# being published, so a local model server stays unreachable from outside this machine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node","--input-type=module","-e","process.exit(0)"]

ENTRYPOINT ["node","dist/main.js"]
