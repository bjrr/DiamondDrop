# CaratForUs MVP1 — single Node application, no sidecars (D3, architecture §
# "Hosting"). Deliberately boring: one process, one region, Fly-managed
# Postgres. No Redis, no queue, no worker container — the two recurring jobs
# are cron-shaped and run through the platform scheduler against authenticated
# internal routes.

# Pinned to a digest-stable minor rather than `20` so a rebuild months from now
# produces the same runtime. `engines` in package.json requires >=20.
ARG NODE_VERSION=20.18-slim

# ---------------------------------------------------------------- deps
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# OpenSSL is a Prisma runtime requirement on slim images; without it the query
# engine fails to load with an error that does not mention OpenSSL.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
# `npm ci` runs prisma generate through the package's own postinstall if one
# exists; the explicit generate in `build` below covers the case where it does
# not, and is cheap.
RUN npm ci --include=dev

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app
COPY . .
RUN npx prisma generate
RUN npm run build

# Drop dev dependencies from the tree that ships. Done AFTER the build so the
# build still has vite, react-router's CLI and typescript available.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
# `prisma migrate deploy` (fly.toml's release_command) needs the schema and the
# migration SQL at runtime, not just at build time.
COPY --from=build /app/prisma ./prisma

EXPOSE 3000

# react-router-serve, exactly as `npm run start` does locally — the production
# server is the same one the app is developed against.
CMD ["npx", "react-router-serve", "./build/server/index.js"]
