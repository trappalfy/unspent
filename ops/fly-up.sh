#!/usr/bin/env bash
# API gateway and indexer on Fly.io from the owner's files: secrets from .env.mainnet and keys/, the site URL and API
# host from .env.vercel (the same ones the site was deployed with). Creates the apps if missing, sets secrets through
# stdin (never on the command line), deploys one machine each and adds the TLS certificate for the API host.
# Re-run after changing keys or the domain (`LAUNCH=1 pnpm --filter @unspent/ops vercel-env` first).
#
#   ops/fly-up.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GATEWAY_APP="${GATEWAY_APP:-unspent-gateway}"
INDEXER_APP="${INDEXER_APP:-unspent-indexer}"

val() { grep -E "^$1=" "$2" | head -1 | cut -d= -f2- || true; }
need() { [ -n "$2" ] || { echo "✗ $1 is empty"; exit 1; }; }

DB="$(val DATABASE_URL_DIRECT .env.mainnet)"
HELIUS="$(val HELIUS_API_KEY .env.mainnet)"
ANTHROPIC="$(val ANTHROPIC_API_KEYS .env.mainnet)"
ALERT="$(val ALERT_WEBHOOK_URL .env.mainnet)"
SITE="$(val NEXT_PUBLIC_SITE_URL .env.vercel)"
API_HOST="$(val NEXT_PUBLIC_API_HOST .env.vercel)"
need DATABASE_URL_DIRECT "$DB"
need HELIUS_API_KEY "$HELIUS"
need ANTHROPIC_API_KEYS "$ANTHROPIC"
need "NEXT_PUBLIC_SITE_URL (.env.vercel)" "$SITE"
need "NEXT_PUBLIC_API_HOST (.env.vercel)" "$API_HOST"
[ -f keys/mainnet-gateway-keypair.json ] || { echo "✗ keys/mainnet-gateway-keypair.json is missing"; exit 1; }
fly auth whoami >/dev/null

for app in "$GATEWAY_APP" "$INDEXER_APP"; do
  fly status -a "$app" >/dev/null 2>&1 || fly apps create "$app" --org personal
done

{
  echo "DATABASE_URL=$DB"
  echo "RPC_URL=https://mainnet.helius-rpc.com/?api-key=$HELIUS"
  echo "GATEWAY_KEYPAIR=$(tr -d '\n' < keys/mainnet-gateway-keypair.json)"
  echo "ANTHROPIC_API_KEYS=$ANTHROPIC"
  echo "NEXT_PUBLIC_SITE_URL=$SITE"
  [ -z "$ALERT" ] || echo "ALERT_WEBHOOK_URL=$ALERT"
} | fly secrets import -a "$GATEWAY_APP" --stage

{
  echo "DATABASE_URL=$DB"
  echo "RPC_URL=https://mainnet.helius-rpc.com/?api-key=$HELIUS"
  echo "RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=$HELIUS"
} | fly secrets import -a "$INDEXER_APP" --stage

fly deploy -c fly.gateway.toml -a "$GATEWAY_APP" --ha=false --yes
fly deploy -c fly.indexer.toml -a "$INDEXER_APP" --ha=false --yes

fly certs add "$API_HOST" -a "$GATEWAY_APP" >/dev/null 2>&1 || true
echo
echo "✓ gateway: https://$GATEWAY_APP.fly.dev/health"
echo "DNS at the domain's registrar: CNAME  ${API_HOST%%.*}  →  $GATEWAY_APP.fly.dev"
fly certs show "$API_HOST" -a "$GATEWAY_APP" 2>/dev/null | grep -iE "status|configured|issued" || true
