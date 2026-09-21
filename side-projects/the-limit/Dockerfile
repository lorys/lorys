# syntax=docker/dockerfile:1

# One image, one process: Fastify serves the compiled server, the question pages and the static
# web/ directory from the same origin. web/ is plain HTML/CSS/JS (Chart.js comes from a CDN at
# runtime), so tsc is the only build — there is no bundler.
#   docker compose up -d --build

FROM node:24-alpine AS build
WORKDIR /build
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
# A type error fails the image here rather than at container start.
RUN yarn build

# Same layer, minus the devDependencies tsc needed.
FROM build AS prune
RUN yarn install --frozen-lockfile --production && yarn cache clean

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prune /build/node_modules ./node_modules
# tsconfig has rootDir "./", so the emit lands in dist/src — flatten it to /app/dist.
COPY --from=build /build/dist/src ./dist
# Needed at runtime, not just for the install: "type": "module" is what makes node read the
# emitted .js as ESM. Without it the top-level await in index.js is a syntax error.
COPY package.json ./
# index.ts readdirSync()s ./questions at module load and @fastify/static serves ./web, both
# resolved from process.cwd() — so they have to sit next to the WORKDIR the CMD runs from.
COPY questions ./questions
COPY web ./web
USER node
EXPOSE 3000
# There is no /health route; "/" is web/index.html off @fastify/static. The server only listens
# after mongo.connect() resolves, so an unhealthy container here means Mongo is unreachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
