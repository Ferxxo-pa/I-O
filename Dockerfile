FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=5000
ENV DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 5000

CMD ["node", "dist/index.js"]
