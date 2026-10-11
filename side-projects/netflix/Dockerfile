FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MOVIES_PATH=/movies \
    MOVIES_INFOS_PATH=/data/movies.json \
    ACCOUNTS_PATH=/data/accounts.enc

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bin ./bin
COPY public ./public

# /movies: the video library (mounted read-only)
# /data: movies.json (TMDB cache) and accounts.enc (accounts + watch progress)
RUN mkdir -p /movies /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

CMD ["node", "src/index.js"]
