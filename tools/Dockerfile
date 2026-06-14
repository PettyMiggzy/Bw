# Dockerfile for the $CHRONIC new-mint firehose worker (Railway).
# Railway builds this automatically when Root Directory = tools, bypassing the
# Railpack/Nixpacks auto-detector that can't pick a start command on its own.
FROM node:20-slim

WORKDIR /app

# install deps first for layer caching; no lockfile in tools/, so use install
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# app source
COPY . .

# long-running websocket worker — no port to expose
CMD ["node", "newmints-listener.js"]
