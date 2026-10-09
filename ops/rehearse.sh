#!/usr/bin/env bash
# Mainnet launch rehearsal on a local mainnet fork (docs/LAUNCH.md): the same scripts in the same order as on mainnet,
# with Metaplex metadata from the fork. keys/localnet-admin-keypair.json stands in for the owner's admin wallet, and
# the admin actions go through /app/admin in a real browser, as on mainnet. Never touches a public cluster.
# Needs `pnpm --filter @unspent/db devdb` and Chrome.
#
#   ops/rehearse.sh            # launch + verify + /app/admin (pause, limits, backup key, freeze, shutdown)
#   RUN_UI=1 ops/rehearse.sh   # also the user-side browser e2e (tests/e2e/ui.ts) on the launched program
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
pub() { solana-keygen pubkey "keys/localnet-$1-keypair.json"; }

say "1. Fresh mainnet fork, program deployed by the deployer key"
NO_LAUNCH=1 bash ops/surfpool-up.sh

cd ops
export NETWORK=localnet RPC_URL=http://127.0.0.1:8899
TSX=./node_modules/.bin/tsx
rm -f ../keys/localnet-credit-mint-keypair.json

say "2. Launch: credit mint + metadata → mint authority to Config → treasury → initialize → upgrade authority to admin"
ADMIN="$(cd .. && pub admin)" GATEWAY="$(cd .. && pub gateway)" \
  TOKEN_SYMBOL=TEST TOKEN_URI=http://localhost:3000/token.json $TSX launch.ts

say "3. Verify the deployment"
$TSX verify.ts

if [ "${RUN_UI:-}" = "1" ]; then
  say "4. User-side browser e2e on the launched program"
  (cd ../tests/e2e && pnpm ui)
fi

say "5. /app/admin with the admin wallet: pause, limit raise after admin_delay, backup key, freeze, shutdown"
(cd ../tests/e2e && E2E_SHUTDOWN=1 pnpm admin)

printf '\nREHEARSAL PASSED\n'
