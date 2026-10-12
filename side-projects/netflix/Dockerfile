FROM node:22-alpine

# ffmpeg reads the subtitle tracks embedded in mkv/mp4 files and converts movies browsers can't play.
# libva-intel-driver: Intel Quick Sync (Haswell…Skylake) for H.264 encoding, used when /dev/dri is passed in.
RUN apk add --no-cache ffmpeg libva-intel-driver

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bin ./bin
COPY public ./public

# /movies: the video library (mounted read-write: downloads and conversions write into it)
# /data: movies.json (TMDB cache), accounts.enc (accounts + watch progress), subtitles/ (extracted tracks),
#        convert.json (files already converted or found compatible)
RUN mkdir -p /movies /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

CMD ["node", "src/index.js"]
