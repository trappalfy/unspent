# Unspent program — security notes

The program has not had an external audit. This document describes what the program enforces, who can do what,
and the risks that remain.

## What the program guarantees

- Credits are minted only by `buy_credits`, 1:1 against USDC transferred into the reserve in the same instruction.
  Mint authority is the `Config` PDA; the mint has no freeze authority.
- USDC leaves the reserve only through:
  - `settle` / `settle_many`: exactly the amount of credits burned, and only to the treasury;
  - `redeem`: 1:1 for burned credits, only after `shutdown`;
  - `sweep_surplus`: only USDC above the credit supply, only to the treasury.
- Credits leave the vault only through `withdraw` (the owner, up to `balance − reserved`), `settle` (burned), and
  `sweep_surplus` (burns only credits above the sum of users' balances).
- `withdraw` needs no approval and works while paused and after shutdown. A reservation can't hold funds longer than
  `reservation_ttl`; after that anyone can release it with `expire`, or the owner can pass it to `withdraw`.
- Invariants, checked by the test suite after every step of randomized action sequences:
  `reserve ≥ supply`, `vault ≥ total_user_balance`, per user `reserved ≤ balance` and `reserved = Σ live reservations`,
  `active_reserved = Σ live reservations`, `total_released = total_burned`.

## Roles and blast radius

| Role | Can | Cannot |
|---|---|---|
| Upgrade authority (Squads multisig, time lock ≥ `admin_delay`) | Upgrade the program; call `initialize` once | — while upgradable, the backing promise depends on this multisig; freezing upgrades removes this risk |
| Admin (Squads multisig, no time lock) | Immediately: pause / unpause, lower limits, revoke the gateway, switch to the pre-approved backup gateway, `shutdown`, `sweep_surplus`. After `admin_delay`: raise limits, change `admin_delay`, set a backup gateway, change the treasury | Mint credits, move reserve USDC or vault credits outside the paths above |
| Gateway (hot key) | `reserve`, `settle`, `settle_many` | Hold more than `max_reservation` per request or `max_reserved_per_user` per user; burn more than `burn_cap_per_window` per 10 minutes; send USDC anywhere but the treasury |

**Gateway key compromise.** Until the admin revokes it or switches to the backup key, an attacker can hold up to
`max_reserved_per_user` of each user's balance and burn up to `burn_cap_per_window` per 10 minutes (up to 2× across
a window boundary). Burned credits' USDC goes to Unspent's treasury, not to the attacker. Users can still withdraw
everything that isn't held.

**Admin compromise.** Risk-increasing changes are visible onchain for `admin_delay` (48 h) before they apply.
Withdrawals are instant, so users can leave first. The admin can `shutdown`, which only opens redemption.

## USDC issuer freeze

USDC on Solana (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) is a classic SPL Token mint whose freeze authority
(`7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar`, an SPL multisig controlled by Circle) can freeze any USDC token
account, including this program's reserve and treasury accounts. While the reserve is frozen, every instruction
that moves USDC into or out of it (purchases, redemptions and settlements with a non-zero cost) fails with
`AccountFrozen`, and the program has no way to recover or migrate those funds until Circle thaws the account. A
frozen treasury likewise blocks settlements with a non-zero cost. Failed instructions revert atomically, so credit
balances, vaults and reservations stay consistent: users can still withdraw credits from the vault, and held
reservations expire as usual. The classic SPL Token program has no permanent-delegate or clawback mechanism, so the
risk is that funds get frozen, not that they get seized onchain.

## Other notes

- `request_id` is a reservation PDA seed. A live reservation can't be created twice; after it closes the same id
  could be reused, so the gateway never reuses ids.
- `settle_many` closes each reservation before moving to the next, rejects a reservation listed twice, re-reads a
  user account that appears in several entries, and skips (does not fail on) entries that are already closed, were
  paid by another rent payer, or don't fit the burn window.
- Events use `emit!` (program logs). Logs can be truncated under heavy logging; the indexer backfills from
  transactions and balances are always read from accounts, not from events.
- Rent of a reservation is paid by the gateway and returned to it on settle, expire or withdraw.
- `settle` does not check `expires_at`: a late settlement of a request that really ran is valid, and it never
  charges more than the reservation. The gateway caps request duration at `reservation_ttl − 10 min`.
- The treasury token account must never be closed: settlements need it, and replacing it takes `admin_delay`.
  Meanwhile reservations expire normally and users lose nothing.

## Tooling

- `cargo clippy -p unspent --lib -- -D warnings`: clean.
- `cargo audit` (2026-10-09): no vulnerabilities. Five "unmaintained" warnings, all transitive through the Solana,
  Anchor and LiteSVM crates, none in code we control: `ansi_term` (RUSTSEC-2021-0139), `bincode` 1.3.3
  (RUSTSEC-2025-0141), `derivative` (RUSTSEC-2024-0388), `libsecp256k1` (RUSTSEC-2025-0161), `paste`
  (RUSTSEC-2024-0436). Accepted until the upstream crates replace them.
