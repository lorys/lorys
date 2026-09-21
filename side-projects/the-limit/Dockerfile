# Node 24 runs TypeScript directly via built-in type stripping — no build step needed.
FROM node:24-alpine

WORKDIR /app

# Install production dependencies using the committed lockfile.
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile && yarn cache clean

# Copy the server, the question pages and the static assets.
COPY tsconfig.json ./
COPY src ./src
COPY questions ./questions
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000

USER node

# cwd must be the project root: the server resolves ./questions and ./web from it.
# MONGO_URL is supplied at runtime (--env-file), never baked into the image.
CMD ["node", "src/index.ts"]
