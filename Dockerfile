# Reproducible Linux build/test environment for PrintPilot.
# Usage:
#   docker build -t printpilot-build .
#   docker run --rm -v "$PWD":/app -w /app printpilot-build
# The default CMD runs unit + e2e tests and packages the Linux targets.

FROM node:22-bookworm

# Electron runtime deps (headless run) + Xvfb for e2e.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
    libgbm1 \
    libxss1 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Repo is bind-mounted at /app; install, verify, then package Linux targets.
CMD ["sh", "-c", "npm ci && npm run typecheck && npm test && xvfb-run -a npm run test:e2e && npm run build && npx electron-builder --linux --publish never"]
