# Gateway and indexer on Fly.io (Q11): one image, each Fly app runs its own command (fly.gateway.toml,
# fly.indexer.toml). The site is on Vercel and is not built here.
FROM node:24-slim
RUN npm install -g pnpm@12.5.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@unspent/gateway..." --filter "@unspent/indexer..."
# IP-to-country database for the gateway's regional check (Q13); rebuild the image monthly to refresh it.
RUN node services/gateway/scripts/fetch-geoip.mjs /app/geo/country.mmdb
ENV NODE_ENV=production GEOIP_DB_PATH=/app/geo/country.mmdb
CMD ["pnpm", "--filter", "@unspent/gateway", "start"]
