#!/usr/bin/env bash
# Mainnet launch rehearsal on a local mainnet fork (docs/LAUNCH.md): the same scripts in the same order as on mainnet,
# with real Squads v4 multisigs and Metaplex metadata from the fork. Local keys stand in for the owner's wallets.
# Never touches a public cluster.
#
#   ops/rehearse.sh            # launch + verify + admin and upgrade paths through Squads
#   RUN_UI=1 ops/rehearse.sh   # also the browser e2e (tests/e2e/ui.ts) on the launched program
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
U=http://127.0.0.1:8899
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
pub() { solana-keygen pubkey "keys/localnet-$1-keypair.json"; }
cheat() { curl -s -X POST $U -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" >/dev/null; }

say "1. Fresh mainnet fork, program deployed by the deployer key"
NO_LAUNCH=1 bash ops/surfpool-up.sh
for k in member-1 member-2 member-3 proposer; do
  [ -f "keys/localnet-$k-keypair.json" ] || solana-keygen new --no-bip39-passphrase -s -o "keys/localnet-$k-keypair.json" >/dev/null
  solana airdrop 2 "keys/localnet-$k-keypair.json" --url $U >/dev/null
done

cd ops
export NETWORK=localnet RPC_URL=$U
TSX=./node_modules/.bin/tsx
MEMBERS="$(cd .. && pub member-1),$(cd .. && pub member-2),$(cd .. && pub member-3)"
PROPOSER="$(cd .. && pub proposer)"
rm -f deployments/localnet-squads.json ../keys/localnet-credit-mint-keypair.json

say "2. Squads: admin (2 of 3, no time lock) and upgrade authority (2 of 3, 48 h time lock)"
MEMBERS=$MEMBERS PROPOSER=$PROPOSER $TSX squads.ts create admin
MEMBERS=$MEMBERS PROPOSER=$PROPOSER TIME_LOCK=172800 $TSX squads.ts create upgrade
ADMIN_VAULT=$(node -p "require('./deployments/localnet-squads.json').admin.vault")

say "3. Launch: credit mint + metadata → mint authority to Config → treasury → initialize"
ADMIN=$ADMIN_VAULT TREASURY_OWNER=$ADMIN_VAULT GATEWAY="$(cd .. && pub gateway)" \
  TOKEN_SYMBOL=TEST TOKEN_URI=http://localhost:3000/token.json $TSX launch.ts

say "4. Upgrade authority → upgrade multisig"
$TSX squads.ts handover

say "5. Verify the deployment"
$TSX verify.ts

vote() { # kind index: two members approve, one executes
  MEMBER_KEYPAIR=keys/localnet-member-1-keypair.json $TSX squads.ts approve "$1" "$2"
  MEMBER_KEYPAIR=keys/localnet-member-2-keypair.json $TSX squads.ts approve "$1" "$2"
  MEMBER_KEYPAIR=keys/localnet-member-1-keypair.json $TSX squads.ts execute "$1" "$2"
}
expect() { # pattern: the admin state shown by `squads show admin` must contain it
  $TSX squads.ts show admin | grep -q -- "$1" && echo "✓ $1" || { echo "✗ expected: $1"; exit 1; }
}
export PROPOSER_KEYPAIR=keys/localnet-proposer-keypair.json

say "6. Admin through Squads: pause purchases, then resume"
$TSX squads.ts propose admin pause buy
vote admin 1
expect "buy_paused true"
$TSX squads.ts propose admin unpause buy
vote admin 2
expect "buy_paused false"

say "7. A limit raise waits admin_delay; anyone applies it after"
$TSX squads.ts propose admin set-limit max-reservation 30
vote admin 3
expect "pending MaxReservation"
NOW=$(date +%s)
cheat surfnet_timeTravel "[{\"absoluteTimestamp\": $(( (NOW + 172800 + 120) * 1000 ))}]"
$TSX squads.ts propose admin apply max-reservation
vote admin 4
$TSX squads.ts propose admin set-limit max-reservation 25
vote admin 5
$TSX squads.ts show admin | grep -q "pending" && { echo "✗ a pending change is left"; exit 1; } || echo "✓ raise applied after the delay, lowered back at once"

if [ "${RUN_UI:-}" = "1" ]; then
  say "8. Browser e2e on the launched program"
  (cd ../tests/e2e && pnpm ui)
fi

say "9. Upgrade multisig: freezing upgrades waits for its 48 h time lock"
$TSX squads.ts propose upgrade freeze-upgrades
MEMBER_KEYPAIR=keys/localnet-member-1-keypair.json $TSX squads.ts approve upgrade 1
MEMBER_KEYPAIR=keys/localnet-member-3-keypair.json $TSX squads.ts approve upgrade 1
if MEMBER_KEYPAIR=keys/localnet-member-1-keypair.json $TSX squads.ts execute upgrade 1 >/dev/null 2>&1; then
  echo "✗ executed before the time lock"; exit 1
else echo "✓ execution refused before the time lock"; fi
NOW=$(date +%s)
cheat surfnet_timeTravel "[{\"absoluteTimestamp\": $(( (NOW + 2 * 172800 + 600) * 1000 ))}]"
MEMBER_KEYPAIR=keys/localnet-member-1-keypair.json $TSX squads.ts execute upgrade 1
EXPECT_FROZEN=1 $TSX verify.ts | grep -E "frozen|VERIFIED|FAILED"

say "10. Shutdown through Squads"
$TSX squads.ts propose admin shutdown
vote admin 6
expect "shut_down true"

printf '\nREHEARSAL PASSED\n'
