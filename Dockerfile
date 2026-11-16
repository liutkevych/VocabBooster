# syntax=docker/dockerfile:1

# ---- Build: compile the server and bundle the web app ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web

# ---- Runtime: server production dependencies + built files only ----
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_ROOT=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY server/migrations server/migrations
COPY --from=build /app/web/dist web/dist

USER node
EXPOSE 3000
# Cap the JS heap so the process stays well inside a 256 MB machine.
CMD ["node", "--max-old-space-size=160", "server/dist/index.js"]
