# Node 24 runs TypeScript directly via built-in type stripping — no build step needed.
FROM node:24-alpine

WORKDIR /app

# Install production dependencies using the committed lockfile.
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile && yarn cache clean

# Copy the server and static assets.
COPY tsconfig.json ./
COPY src ./src
COPY web ./web

ENV NODE_ENV=production
EXPOSE 3000

# cwd must be the project root so the server can serve ./web
CMD ["node", "src/index.ts"]
