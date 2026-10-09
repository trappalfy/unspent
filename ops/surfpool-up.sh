#!/usr/bin/env bash
# Local mainnet fork for end-to-end runs: fresh Surfpool, the program (sBPFv2 copy: Surfpool can't parse v3 ELFs),
# launch.ts for localnet. Never touches a public cluster; Surfpool only reads mainnet accounts it doesn't have yet.
#
#   ops/surfpool-up.sh          # start + deploy + launch
#   NO_LAUNCH=1 ops/surfpool-up.sh   # start + deploy only (ops/rehearse.sh launches with multisigs itself)
#   ops/surfpool-up.sh stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SURFPOOL="${SURFPOOL_BIN:-$HOME/.local/bin/surfpool}"
WORK="${SURF_DIR:-${TMPDIR:-/tmp}/unspent-surf}"
U=http://127.0.0.1:8899
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

pkill -9 -f "surfpool start" 2>/dev/null || true
[ "${1:-}" = "stop" ] && exit 0
sleep 1

V2="$ROOT/target/deploy-v2/unspent.so"
if [ ! -f "$V2" ]; then
  echo "building the sBPFv2 copy for Surfpool"
  (cd "$ROOT" && cp target/deploy/unspent.so target/deploy/unspent.v3.so \
    && anchor build --arch v2 >/dev/null && mkdir -p target/deploy-v2 && cp target/deploy/unspent.so "$V2" \
    && mv target/deploy/unspent.v3.so target/deploy/unspent.so)
fi

rm -rf "$WORK" && mkdir -p "$WORK"
# SURF_RPC_URL picks the mainnet datasource (e.g. https://solana-rpc.publicnode.com when the default one flakes).
# OFFLINE=1: no datasource at all (deterministic; the USDC mint comes from ops/fixtures, no Metaplex metadata, no
# Jupiter routes). Use it when the network to mainnet RPC is unreliable.
if [ "${OFFLINE:-}" = "1" ]; then SOURCE=(--offline)
elif [ -n "${SURF_RPC_URL:-}" ]; then SOURCE=(--rpc-url "$SURF_RPC_URL"); else SOURCE=(--network mainnet); fi
(cd "$WORK" && exec nohup "$SURFPOOL" start "${SOURCE[@]}" --no-tui --no-studio --disable-instruction-profiling --no-deploy -y) >"$WORK/surfpool.log" 2>&1 </dev/null &
disown
for _ in $(seq 1 60); do
  curl -s -X POST $U -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && break
  sleep 1
done

cd "$ROOT"
if [ "${OFFLINE:-}" = "1" ]; then
  python3 - "$U" <<'PY'
import base64, json, sys, urllib.request
f = json.load(open("ops/fixtures/usdc-mint.json"))
acc = {"lamports": f["lamports"], "data": base64.b64decode(f["data_base64"]).hex(), "owner": f["owner"], "executable": False, "rentEpoch": 0}
body = {"jsonrpc": "2.0", "id": 1, "method": "surfnet_setAccount", "params": [f["address"], acc]}
urllib.request.urlopen(urllib.request.Request(sys.argv[1], json.dumps(body).encode(), {"content-type": "application/json"}))
PY
fi
for k in deployer admin gateway treasury-owner; do
  [ -f "keys/localnet-$k-keypair.json" ] || solana-keygen new --no-bip39-passphrase -s -o "keys/localnet-$k-keypair.json" >/dev/null
done
solana airdrop 20 keys/localnet-deployer-keypair.json --url $U >/dev/null
solana airdrop 5 keys/localnet-gateway-keypair.json --url $U >/dev/null
solana airdrop 5 keys/localnet-admin-keypair.json --url $U >/dev/null
solana program deploy "$V2" --skip-feature-verify --program-id keys/unspent-program-keypair.json -k keys/localnet-deployer-keypair.json \
  --url $U 2>&1 | grep -E "Program Id|Error"
rm -f keys/localnet-credit-mint-keypair.json
cd ops
[ "${NO_LAUNCH:-}" = "1" ] || NETWORK=localnet \
  ADMIN="$(solana-keygen pubkey ../keys/localnet-admin-keypair.json)" \
  GATEWAY="$(solana-keygen pubkey ../keys/localnet-gateway-keypair.json)" \
  TREASURY_OWNER="$(solana-keygen pubkey ../keys/localnet-treasury-owner-keypair.json)" \
  TOKEN_SYMBOL=TEST TOKEN_URI=http://localhost:3000/token.json SKIP_METADATA="${OFFLINE:-}" \
  npx tsx launch.ts 2>&1 | grep -E "wrote|Error"
[ "${OFFLINE:-}" = "1" ] && { echo "surfpool (offline) up at $U"; exit 0; }
# Keep Surfpool's connection to the mainnet datasource busy: on NATed networks an idle connection is dropped silently
# and every later remote fetch hangs ~30 s ("Failed to fetch accounts from remote"). A lookup of a random (absent)
# account every few seconds forces a remote fetch. Exits with Surfpool.
(
  while pgrep -f "surfpool start" >/dev/null; do
    KEY=$(python3 -c "import os;A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(os.urandom(32),'big');s=''
while n: n,r=divmod(n,58); s=A[r]+s
print(s)")
    curl -s -m 40 -X POST $U -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$KEY\",{\"encoding\":\"base64\"}]}" >/dev/null
    sleep 4
  done
) >/dev/null 2>&1 </dev/null &
disown
echo "surfpool up at $U (log: $WORK/surfpool.log)"
