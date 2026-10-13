FROM node:24-alpine

WORKDIR /app

# Install production dependencies using the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the server and static assets.
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
