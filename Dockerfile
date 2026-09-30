# Gladys sandbox: read-only rootfs, /data is the only writable path, non-root.
FROM node:24-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY index.js gladys-assistant-integration.json ./
COPY src ./src

ENV NODE_ENV=production
VOLUME ["/data"]
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
