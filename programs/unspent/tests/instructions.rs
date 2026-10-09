//! Unit tests of every user/gateway instruction (UNSPENT_BRIEF.md §13 "Юнит"): checks and boundaries, pauses and
//! shutdown, the counter-delta table of §6.3, settle_many batches and withdraw with expired reservations.
#![allow(clippy::result_large_err)] // TxResult carries LiteSVM's FailedTransactionMetadata

mod common;
use common::*;

use anchor_lang::{error::ErrorCode as AnchorError, prelude::Pubkey, InstructionData};
use anchor_spl::token::spl_token;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::TransactionError;
use unspent::{error::UnspentError as E, ConfigField, PauseTarget};

// ================================================================ helpers

fn i(x: u64) -> i128 {
    x as i128
}

fn gw(env: &Env) -> Keypair {
    env.gateway.insecure_clone()
}

fn set_limit(env: &mut Env, field: ConfigField, value: u64) {
    let ix = env.ix_set_limit(&env.admin.pubkey(), field, value);
    assert_ok(env.as_admin(ix));
    assert_eq!(env.config().limit(field).unwrap(), value, "lowering {field:?} applies at once");
}

fn set_pause(env: &mut Env, target: PauseTarget, paused: bool) {
    let ix = env.ix_set_pause(&env.admin.pubkey(), target, paused);
    assert_ok(env.as_admin(ix));
}

fn shutdown(env: &mut Env) {
    let ix = env.ix_shutdown(&env.admin.pubkey());
    assert_ok(env.as_admin(ix));
    assert!(env.config().shut_down);
}

fn set_cap(env: &mut Env, u: &User, cap: u64) -> TxResult {
    let ix = env.ix_set_my_reserve_cap(&u.key(), cap);
    env.send(&[ix], &[&u.kp])
}

fn withdraw_with(env: &mut Env, u: &User, amount: u64, expired: &[([u8; 32], Pubkey)]) -> TxResult {
    let ix = env.ix_withdraw(&u.key(), u.credits, amount, expired);
    env.send(&[ix], &[&u.kp])
}

/// Index of the failing instruction inside the transaction.
fn failed_ix_index(res: &TxResult) -> Option<u8> {
    match res {
        Err(f) => match &f.err {
            TransactionError::InstructionError(idx, _) => Some(*idx),
            _ => None,
        },
        Ok(_) => None,
    }
}

fn user_bal(env: &Env, u: &Pubkey) -> (u64, u64) {
    let ua = env.user_account(u).expect("user account");
    (ua.balance, ua.reserved)
}

/// Every counter of the §6.3 delta table, plus the treasury and the subject user's wallets.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Snap {
    balance: i128,
    reserved: i128,
    total_user_balance: i128,
    vault: i128,
    reserve: i128,
    supply: i128,
    active_reserved: i128,
    total_burned: i128,
    total_released: i128,
    total_redeemed: i128,
    total_swept_usdc: i128,
    total_swept_credits: i128,
    treasury: i128,
    wallet_credits: i128,
    wallet_usdc: i128,
}

impl Snap {
    fn take(env: &Env, u: &User) -> Snap {
        let c = env.config();
        let (balance, reserved) = env.user_account(&u.key()).map_or((0, 0), |a| (a.balance, a.reserved));
        Snap {
            balance: i(balance),
            reserved: i(reserved),
            total_user_balance: i(c.total_user_balance),
            vault: i(env.token_balance(&vault_pda())),
            reserve: i(env.token_balance(&reserve_pda())),
            supply: i(env.credit_supply()),
            active_reserved: i(c.active_reserved),
            total_burned: i(c.total_burned),
            total_released: i(c.total_released),
            total_redeemed: i(c.total_redeemed),
            total_swept_usdc: i(c.total_swept_usdc),
            total_swept_credits: i(c.total_swept_credits),
            treasury: i(env.token_balance(&env.treasury)),
            wallet_credits: i(env.token_balance(&u.credits)),
            wallet_usdc: i(env.token_balance(&u.usdc)),
        }
    }

    fn zip(self, o: Snap, f: impl Fn(i128, i128) -> i128) -> Snap {
        Snap {
            balance: f(self.balance, o.balance),
            reserved: f(self.reserved, o.reserved),
            total_user_balance: f(self.total_user_balance, o.total_user_balance),
            vault: f(self.vault, o.vault),
            reserve: f(self.reserve, o.reserve),
            supply: f(self.supply, o.supply),
            active_reserved: f(self.active_reserved, o.active_reserved),
            total_burned: f(self.total_burned, o.total_burned),
            total_released: f(self.total_released, o.total_released),
            total_redeemed: f(self.total_redeemed, o.total_redeemed),
            total_swept_usdc: f(self.total_swept_usdc, o.total_swept_usdc),
            total_swept_credits: f(self.total_swept_credits, o.total_swept_credits),
            treasury: f(self.treasury, o.treasury),
            wallet_credits: f(self.wallet_credits, o.wallet_credits),
            wallet_usdc: f(self.wallet_usdc, o.wallet_usdc),
        }
    }

    /// after − self, field by field.
    fn delta(self, after: Snap) -> Snap {
        after.zip(self, |a, b| a - b)
    }
}

impl std::ops::Add for Snap {
    type Output = Snap;
    fn add(self, o: Snap) -> Snap {
        self.zip(o, |a, b| a + b)
    }
}

/// Expected settle(x ≤ a) row of the table.
fn settle_delta(a: u64, x: u64) -> Snap {
    Snap {
        balance: -i(x),
        reserved: -i(a),
        total_user_balance: -i(x),
        vault: -i(x),
        reserve: -i(x),
        supply: -i(x),
        active_reserved: -i(a),
        total_burned: i(x),
        total_released: i(x),
        treasury: i(x),
        ..Snap::default()
    }
}

/// Expected expire row of the table.
fn expire_delta(a: u64) -> Snap {
    Snap { reserved: -i(a), active_reserved: -i(a), ..Snap::default() }
}

/// Size in bytes of a legacy transaction carrying `ixs`, paid and signed by `payer` only.
fn legacy_tx_size(ixs: &[Instruction], payer: &Pubkey) -> usize {
    let msg = Message::new(ixs, Some(payer));
    1 + 64 * msg.header.num_required_signatures as usize + msg.serialize().len()
}

// ================================================================ buy_credits

#[test]
fn buy_minimum_is_exactly_one_credit() {
    let mut env = Env::ready();
    let u = env.user(10 * C);
    assert_err(env.buy(&u, 0), E::AmountTooSmall);
    assert_err(env.buy(&u, C - 1), E::AmountTooSmall);
    assert_eq!(env.credit_supply(), 0);
    let before = Snap::take(&env, &u);
    assert_ok(env.buy(&u, C));
    let d = before.delta(Snap::take(&env, &u));
    assert_eq!(d, Snap { reserve: i(C), supply: i(C), wallet_credits: i(C), wallet_usdc: -i(C), ..Snap::default() });
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn buy_maximum_is_max_buy_per_ix() {
    let mut env = Env::ready();
    let max = env.config().max_buy_per_ix;
    assert_eq!(max, 100_000 * C);
    let u = env.user(max + 20 * C);
    assert_err(env.buy(&u, max + 1), E::AmountTooLarge);
    assert_ok(env.buy(&u, max));
    assert_eq!(env.credit_supply(), max);

    // a lowered limit applies at once, with the same exact boundary
    set_limit(&mut env, ConfigField::MaxBuyPerIx, 10 * C);
    assert_err(env.buy(&u, 10 * C + 1), E::AmountTooLarge);
    assert_ok(env.buy(&u, 10 * C));
    assert_eq!(env.credit_supply(), max + 10 * C);
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn several_buys_in_one_transaction_against_supply_cap() {
    let mut env = Env::ready();
    set_limit(&mut env, ConfigField::SupplyCap, 10 * C);
    let u = env.user(20 * C);
    let buy = |env: &Env, amount: u64| env.ix_buy(&u.key(), u.usdc, u.credits, amount);

    // two buys in one transaction, below the cap
    let ixs = [buy(&env, 4 * C), buy(&env, 4 * C)];
    assert_ok(env.send(&ixs, &[&u.kp]));
    assert_eq!(env.credit_supply(), 8 * C);

    // the second buy crosses the cap (8 + 1 + 2 > 10): the whole transaction fails, the first buy is undone too
    let before = Snap::take(&env, &u);
    let ixs = [buy(&env, C), buy(&env, 2 * C)];
    let res = env.send(&ixs, &[&u.kp]);
    assert_eq!(failed_ix_index(&res), Some(1), "the second buy is the one that fails");
    assert_err(res, E::SupplyCapExceeded);
    assert_eq!(before.delta(Snap::take(&env, &u)), Snap::default(), "atomic: nothing moved");

    // landing exactly on the cap in one transaction works
    let ixs = [buy(&env, C), buy(&env, C)];
    assert_ok(env.send(&ixs, &[&u.kp]));
    assert_eq!(env.credit_supply(), 10 * C);
    assert_eq!(env.token_balance(&reserve_pda()), 10 * C);

    // at the cap nothing more can be bought
    assert_err(env.buy(&u, C), E::SupplyCapExceeded);
    env.check_invariants(&[u.key()], &[]);
}

// ================================================================ deposit

#[test]
fn deposit_zero_fails_and_first_deposit_creates_user_account() {
    let mut env = Env::ready();
    let u = env.user(10 * C);
    assert_ok(env.buy(&u, 10 * C));
    assert_err(env.deposit(&u, 0), E::ZeroAmount);
    assert!(env.user_account(&u.key()).is_none(), "failed deposit leaves no UserAccount");
    assert_fails(env.deposit(&u, 10 * C + 1)); // more than the wallet holds

    assert_ok(env.deposit(&u, 4 * C));
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.owner, ua.balance, ua.reserved, ua.reserve_cap), (u.key(), 4 * C, 0, 0));
    assert_ok(env.deposit(&u, 6 * C));
    assert_eq!(user_bal(&env, &u.key()), (10 * C, 0));
    env.check_invariants(&[u.key()], &[]);
}

// ================================================================ reserve

#[test]
fn reserve_exactly_available_and_one_microcredit_more() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 4 * C));
    // available = 10 - 4 = 6
    assert_err(env.reserve(rid(2), u.key(), 6 * C + 1), E::InsufficientAvailable);
    assert!(env.reservation(&rid(2)).is_none());
    let t = env.now();
    assert_ok(env.reserve(rid(2), u.key(), 6 * C));
    let r = env.reservation(&rid(2)).unwrap();
    assert_eq!(r.owner, u.key());
    assert_eq!(r.request_id, rid(2));
    assert_eq!(r.amount, 6 * C);
    assert_eq!(r.expires_at, t + 3_600);
    assert_eq!(r.payer, env.gateway.pubkey());
    assert_eq!(user_bal(&env, &u.key()), (10 * C, 10 * C));
    assert_err(env.reserve(rid(3), u.key(), 1), E::InsufficientAvailable);
    env.check_invariants(&[u.key()], &[rid(1), rid(2)]);
}

#[test]
fn reserve_zero_and_above_max_reservation_fail() {
    let mut env = Env::ready();
    let u = env.funded_user(60 * C);
    assert_err(env.reserve(rid(1), u.key(), 0), E::ZeroAmount);
    assert_err(env.reserve(rid(1), u.key(), 25 * C + 1), E::ReservationTooLarge);
    assert_ok(env.reserve(rid(1), u.key(), 25 * C));
    set_limit(&mut env, ConfigField::MaxReservation, 5 * C);
    assert_err(env.reserve(rid(2), u.key(), 5 * C + 1), E::ReservationTooLarge);
    assert_ok(env.reserve(rid(2), u.key(), 5 * C));
    env.check_invariants(&[u.key()], &[rid(1), rid(2)]);
}

#[test]
fn reserve_requires_gateway_and_existing_user_account() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = env.ix_reserve(&stranger.pubkey(), rid(1), u.key(), C);
    assert_err(env.send(&[ix], &[&stranger]), E::NotGateway);
    // owner who never deposited: no UserAccount
    let nobody = env.user(0);
    assert_anchor_err(env.reserve(rid(1), nobody.key(), C), AnchorError::AccountNotInitialized);
    assert!(env.reservation(&rid(1)).is_none());
}

#[test]
fn reserve_with_live_request_id_twice_fails() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let v = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), C));
    assert_fails(env.reserve(rid(1), u.key(), C));
    assert_fails(env.reserve(rid(1), v.key(), 2 * C)); // same id, other owner
    let r = env.reservation(&rid(1)).unwrap();
    assert_eq!((r.owner, r.amount), (u.key(), C), "original reservation untouched");
    assert_eq!(user_bal(&env, &u.key()), (10 * C, C));
    assert_eq!(user_bal(&env, &v.key()), (10 * C, 0));
    assert_eq!(env.config().active_reserved, C);
    env.check_invariants(&[u.key(), v.key()], &[rid(1)]);
}

#[test]
fn reserve_against_max_reserved_per_user() {
    let mut env = Env::ready();
    let u = env.funded_user(100 * C);
    assert_ok(env.reserve(rid(1), u.key(), 25 * C));
    assert_ok(env.reserve(rid(2), u.key(), 25 * C)); // reserved == 50 == max_reserved_per_user
    assert_err(env.reserve(rid(3), u.key(), 1), E::UserHoldLimitExceeded);
    // freeing room makes it possible again, up to the limit exactly
    assert_ok(env.settle(rid(1), u.key(), 0));
    assert_err(env.reserve(rid(3), u.key(), 25 * C + 1), E::ReservationTooLarge);
    assert_ok(env.reserve(rid(3), u.key(), 25 * C));
    assert_err(env.reserve(rid(4), u.key(), 1), E::UserHoldLimitExceeded);
    // lowering the global limit applies at once; live reservations stay
    set_limit(&mut env, ConfigField::MaxReservedPerUser, 30 * C);
    assert_err(env.reserve(rid(4), u.key(), 1), E::UserHoldLimitExceeded);
    assert_ok(env.settle(rid(2), u.key(), 0));
    assert_err(env.reserve(rid(4), u.key(), 5 * C + 1), E::UserHoldLimitExceeded);
    assert_ok(env.reserve(rid(4), u.key(), 5 * C));
    assert_eq!(user_bal(&env, &u.key()).1, 30 * C);
    env.check_invariants(&[u.key()], &[rid(3), rid(4)]);
}

#[test]
fn reserve_against_own_reserve_cap() {
    let mut env = Env::ready();
    let u = env.funded_user(100 * C);
    let v = env.funded_user(100 * C);
    assert_ok(set_cap(&mut env, &u, 10 * C));
    assert_eq!(env.user_account(&u.key()).unwrap().reserve_cap, 10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 6 * C));
    assert_ok(env.reserve(rid(2), u.key(), 4 * C)); // exactly the own cap
    assert_err(env.reserve(rid(3), u.key(), 1), E::UserHoldLimitExceeded);
    // another user's cap is unaffected
    assert_ok(env.reserve(rid(10), v.key(), 20 * C));

    // cap 0 = the global limit (50)
    assert_ok(set_cap(&mut env, &u, 0));
    assert_ok(env.reserve(rid(3), u.key(), 25 * C));
    assert_ok(env.reserve(rid(4), u.key(), 15 * C)); // 50
    assert_err(env.reserve(rid(5), u.key(), 1), E::UserHoldLimitExceeded);

    // a cap above the global limit does not raise it
    assert_ok(set_cap(&mut env, &u, 1_000 * C));
    assert_err(env.reserve(rid(5), u.key(), 1), E::UserHoldLimitExceeded);

    // lowering the cap below what is held keeps live reservations, blocks new ones until they close
    assert_ok(set_cap(&mut env, &u, 5 * C));
    assert_err(env.reserve(rid(5), u.key(), 1), E::UserHoldLimitExceeded);
    for id in [1, 2, 3, 4] {
        assert_ok(env.settle(rid(id), u.key(), 0));
    }
    assert_err(env.reserve(rid(5), u.key(), 5 * C + 1), E::UserHoldLimitExceeded);
    assert_ok(env.reserve(rid(5), u.key(), 5 * C));

    // set_my_reserve_cap needs the owner's own UserAccount and signature
    let nobody = env.user(0);
    assert_anchor_err(set_cap(&mut env, &nobody, C), AnchorError::AccountNotInitialized);
    env.check_invariants(&[u.key(), v.key()], &[rid(5), rid(10)]);
}

// ================================================================ settle

#[test]
fn settle_actual_zero_is_a_pure_release() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let g = env.gateway.pubkey();
    let rent = env.lamports(&res_pda(&rid(1)));
    let gw_before = env.lamports(&g);
    let before = Snap::take(&env, &u);
    let meta = assert_ok(env.settle(rid(1), u.key(), 0));
    assert_eq!(before.delta(Snap::take(&env, &u)), settle_delta(3 * C, 0));
    assert_eq!(before.delta(Snap::take(&env, &u)), expire_delta(3 * C), "nothing burned, treasury unchanged");
    assert!(!env.exists(&res_pda(&rid(1))), "reservation closed");
    assert_eq!(env.lamports(&g), gw_before - meta.fee + rent, "rent back to the gateway");
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_actual_equal_to_amount_burns_everything() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let before = Snap::take(&env, &u);
    assert_ok(env.settle(rid(1), u.key(), 3 * C));
    assert_eq!(before.delta(Snap::take(&env, &u)), settle_delta(3 * C, 3 * C));
    assert!(env.reservation(&rid(1)).is_none());
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_actual_above_amount_fails() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let before = Snap::take(&env, &u);
    assert_err(env.settle(rid(1), u.key(), 3 * C + 1), E::ActualExceedsReserved);
    assert_eq!(before.delta(Snap::take(&env, &u)), Snap::default());
    assert!(env.reservation(&rid(1)).is_some());
    env.check_invariants(&[u.key()], &[rid(1)]);
}

#[test]
fn settle_account_checks() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let v = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let g = gw(&env);
    // signer must be the gateway
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = env.ix_settle(&stranger.pubkey(), rid(1), u.key(), g.pubkey(), C);
    assert_err(env.send(&[ix], &[&stranger]), E::NotGateway);
    // rent must go to the payer
    let ix = env.ix_settle(&g.pubkey(), rid(1), u.key(), stranger.pubkey(), C);
    assert_err(env.send(&[ix], &[&g]), E::WrongPayer);
    // UserAccount must be the reservation owner's PDA
    let ix = env.ix_settle(&g.pubkey(), rid(1), v.key(), g.pubkey(), C);
    assert_anchor_err(env.send(&[ix], &[&g]), AnchorError::ConstraintSeeds);
    assert!(env.reservation(&rid(1)).is_some());
    assert_ok(env.settle(rid(1), u.key(), C));
    env.check_invariants(&[u.key(), v.key()], &[]);
}

#[test]
fn settle_beyond_burn_window_fails_until_the_window_resets() {
    let mut env = Env::ready();
    set_limit(&mut env, ConfigField::BurnCapPerWindow, 2 * C);
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 2 * C));
    assert_ok(env.settle(rid(1), u.key(), 2 * C));
    assert_err(env.settle(rid(2), u.key(), 1), E::BurnCapExceeded);
    env.warp(599);
    assert_err(env.settle(rid(2), u.key(), 1), E::BurnCapExceeded);
    env.warp(1);
    assert_ok(env.settle(rid(2), u.key(), 2 * C));
    assert_eq!(env.config().total_burned, 4 * C);
    env.check_invariants(&[u.key()], &[]);
}

// ================================================================ expire

#[test]
fn expire_exactly_at_expires_at_but_not_a_second_earlier() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let t0 = env.now();
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let expires_at = env.reservation(&rid(1)).unwrap().expires_at;
    assert_eq!(expires_at, t0 + 3_600);
    env.warp(3_599);
    assert_err(env.expire(rid(1), u.key()), E::NotExpired);
    assert!(env.reservation(&rid(1)).is_some());
    env.warp(1);
    assert_eq!(env.now(), expires_at);
    let before = Snap::take(&env, &u);
    assert_ok(env.expire(rid(1), u.key()));
    assert_eq!(before.delta(Snap::take(&env, &u)), expire_delta(3 * C));
    assert!(!env.exists(&res_pda(&rid(1))));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_after_expire_and_expire_after_settle_fail() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    assert_ok(env.reserve(rid(2), u.key(), 2 * C));
    assert_ok(env.settle(rid(2), u.key(), C));
    env.warp(3_600);
    assert_ok(env.expire(rid(1), u.key()));
    let before = Snap::take(&env, &u);
    assert_anchor_err(env.settle(rid(1), u.key(), C), AnchorError::AccountNotInitialized);
    assert_anchor_err(env.settle(rid(1), u.key(), 0), AnchorError::AccountNotInitialized);
    assert_anchor_err(env.expire(rid(1), u.key()), AnchorError::AccountNotInitialized);
    assert_anchor_err(env.expire(rid(2), u.key()), AnchorError::AccountNotInitialized);
    assert_eq!(before.delta(Snap::take(&env, &u)), Snap::default());
    assert_eq!(user_bal(&env, &u.key()), (9 * C, 0));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn expire_rent_goes_to_payer_not_caller() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let g = env.gateway.pubkey();
    let rent = env.lamports(&res_pda(&rid(1)));
    assert!(rent > 0);
    env.warp(3_600);
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    // the caller cannot redirect the rent to itself
    let ix = env.ix_expire(rid(1), u.key(), caller.pubkey());
    assert_err(env.send(&[ix], &[&caller]), E::WrongPayer);

    let (gw_before, caller_before) = (env.lamports(&g), env.lamports(&caller.pubkey()));
    let ix = env.ix_expire(rid(1), u.key(), g);
    let meta = assert_ok(env.send(&[ix], &[&caller]));
    assert_eq!(env.lamports(&g), gw_before + rent, "rent to the payer");
    assert_eq!(env.lamports(&caller.pubkey()), caller_before - meta.fee, "caller pays only the fee");
    assert_eq!(env.lamports(&res_pda(&rid(1))), 0);
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn request_id_can_be_reused_after_the_reservation_closes() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.settle(rid(1), u.key(), C));
    // closed by settle → can be created again
    env.warp(10);
    let t = env.now();
    assert_ok(env.reserve(rid(1), u.key(), 3 * C));
    let r = env.reservation(&rid(1)).unwrap();
    assert_eq!((r.amount, r.expires_at), (3 * C, t + 3_600));
    // closed by expire → can be created again
    env.warp(3_600);
    assert_ok(env.expire(rid(1), u.key()));
    assert_ok(env.reserve(rid(1), u.key(), 4 * C));
    assert_eq!(env.reservation(&rid(1)).unwrap().amount, 4 * C);
    assert_eq!(user_bal(&env, &u.key()), (9 * C, 4 * C));
    env.check_invariants(&[u.key()], &[rid(1)]);
}

// ================================================================ withdraw

#[test]
fn withdraw_with_active_reservations_takes_only_available() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 4 * C));
    assert_err(env.withdraw(&u, 0), E::ZeroAmount);
    assert_err(env.withdraw(&u, 6 * C + 1), E::InsufficientAvailable);
    assert_ok(env.withdraw(&u, 6 * C));
    assert_eq!(user_bal(&env, &u.key()), (4 * C, 4 * C));
    assert_err(env.withdraw(&u, 1), E::InsufficientAvailable);
    assert_ok(env.settle(rid(1), u.key(), C));
    assert_err(env.withdraw(&u, 3 * C + 1), E::InsufficientAvailable);
    assert_ok(env.withdraw(&u, 3 * C));
    assert_eq!(user_bal(&env, &u.key()), (0, 0));
    assert_eq!(env.token_balance(&u.credits), 9 * C);
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn withdraw_closes_expired_reservations_and_counts_the_freed_amount() {
    let mut env = Env::ready();
    let u = env.funded_user(20 * C);
    let g = env.gateway.pubkey();
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    assert_ok(env.reserve(rid(2), u.key(), 3 * C));
    env.warp(1_800);
    assert_ok(env.reserve(rid(3), u.key(), 2 * C)); // still live at withdraw time
    env.warp(1_800);
    let pairs = [(rid(1), g), (rid(2), g)];
    let rent = env.lamports(&res_pda(&rid(1))) + env.lamports(&res_pda(&rid(2)));

    // available after closing the expired ones = 20 - 2 = 18; one μcr more fails and closes nothing
    assert_err(withdraw_with(&mut env, &u, 18 * C + 1, &pairs), E::InsufficientAvailable);
    assert!(env.reservation(&rid(1)).is_some() && env.reservation(&rid(2)).is_some());

    let gw_before = env.lamports(&g);
    let before = Snap::take(&env, &u);
    assert_ok(withdraw_with(&mut env, &u, 18 * C, &pairs));
    let want = Snap {
        balance: -i(18 * C),
        reserved: -i(8 * C),
        total_user_balance: -i(18 * C),
        vault: -i(18 * C),
        active_reserved: -i(8 * C),
        wallet_credits: i(18 * C),
        ..Snap::default()
    };
    assert_eq!(before.delta(Snap::take(&env, &u)), want);
    assert!(!env.exists(&res_pda(&rid(1))) && !env.exists(&res_pda(&rid(2))));
    assert_eq!(env.lamports(&g), gw_before + rent, "rent of both reservations back to the payer");
    assert_eq!(user_bal(&env, &u.key()), (2 * C, 2 * C));
    env.check_invariants(&[u.key()], &[rid(3)]);
}

#[test]
fn withdraw_rejects_foreign_live_or_misdirected_reservations() {
    let mut env = Env::ready();
    let a = env.funded_user(10 * C);
    let b = env.funded_user(10 * C);
    let g = env.gateway.pubkey();
    assert_ok(env.reserve(rid(1), a.key(), 2 * C));
    assert_ok(env.reserve(rid(2), b.key(), 2 * C));
    env.warp(3_600);
    assert_ok(env.reserve(rid(3), a.key(), 2 * C)); // live

    // another user's expired reservation
    assert_err(withdraw_with(&mut env, &a, C, &[(rid(2), g)]), E::WrongOwner);
    // a not yet expired one, after a valid one: the whole withdraw fails, the valid one stays open
    assert_err(withdraw_with(&mut env, &a, C, &[(rid(1), g), (rid(3), g)]), E::NotExpired);
    assert!(env.reservation(&rid(1)).is_some());
    // rent must go to the reservation's payer
    let a_key = a.key();
    assert_err(withdraw_with(&mut env, &a, C, &[(rid(1), a_key)]), E::WrongPayer);
    // the same reservation twice
    assert_err(withdraw_with(&mut env, &a, C, &[(rid(1), g), (rid(1), g)]), E::InvalidReservation);
    // not a reservation at all
    assert_err(withdraw_with(&mut env, &a, C, &[(rid(99), g)]), E::InvalidReservation);
    // odd number of remaining accounts
    let mut ix = env.ix_withdraw(&a.key(), a.credits, C, &[(rid(1), g)]);
    ix.accounts.pop();
    assert_err(env.send(&[ix], &[&a.kp]), E::InvalidRemainingAccounts);

    assert_eq!(user_bal(&env, &a.key()), (10 * C, 4 * C));
    assert_eq!(user_bal(&env, &b.key()), (10 * C, 2 * C));
    assert_ok(withdraw_with(&mut env, &a, 8 * C, &[(rid(1), g)]));
    env.check_invariants(&[a.key(), b.key()], &[rid(2), rid(3)]);
}

// ================================================================ pauses and shutdown

#[test]
fn buy_pause_blocks_only_buying() {
    let mut env = Env::ready();
    let u = env.user(20 * C);
    assert_ok(env.buy(&u, 10 * C));
    set_pause(&mut env, PauseTarget::Buy, true);
    assert!(env.config().buy_paused);
    assert_err(env.buy(&u, C), E::BuyPaused);
    assert_ok(env.deposit(&u, 6 * C));
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.settle(rid(1), u.key(), C));
    assert_ok(env.reserve(rid(2), u.key(), C));
    assert_ok(env.settle_many(&[(rid(2), u.key(), C)]));
    assert_ok(env.reserve(rid(3), u.key(), C));
    env.warp(3_600);
    assert_ok(env.expire(rid(3), u.key()));
    assert_ok(env.withdraw(&u, C));
    set_pause(&mut env, PauseTarget::Buy, false);
    assert_ok(env.buy(&u, C));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn deposit_pause_blocks_only_deposits() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let v = env.user(10 * C);
    assert_ok(env.buy(&v, 5 * C));
    set_pause(&mut env, PauseTarget::Deposit, true);
    assert!(env.config().deposit_paused);
    assert_err(env.deposit(&u, C), E::DepositPaused);
    assert_err(env.deposit(&v, C), E::DepositPaused); // first deposit, would create the account
    assert!(env.user_account(&v.key()).is_none());
    assert_ok(env.buy(&v, C));
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.settle(rid(1), u.key(), C));
    assert_ok(env.withdraw(&u, C));
    set_pause(&mut env, PauseTarget::Deposit, false);
    assert_ok(env.deposit(&v, C));
    env.check_invariants(&[u.key(), v.key()], &[]);
}

#[test]
fn gateway_pause_blocks_only_new_reservations() {
    let mut env = Env::ready();
    let u = env.funded_user(20 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 2 * C));
    assert_ok(env.reserve(rid(3), u.key(), 2 * C));
    set_pause(&mut env, PauseTarget::Gateway, true);
    assert!(env.config().gateway_paused);
    assert_err(env.reserve(rid(4), u.key(), C), E::GatewayPaused);
    assert_ok(env.settle(rid(1), u.key(), C));
    assert_ok(env.settle_many(&[(rid(2), u.key(), 0)]));
    env.warp(3_600);
    assert_ok(env.expire(rid(3), u.key()));
    let v = env.user(2 * C);
    assert_ok(env.buy(&v, 2 * C));
    assert_ok(env.deposit(&v, 2 * C));
    assert_ok(env.withdraw(&u, 2 * C));
    set_pause(&mut env, PauseTarget::Gateway, false);
    assert_ok(env.reserve(rid(4), u.key(), C));
    env.check_invariants(&[u.key(), v.key()], &[rid(4)]);
}

#[test]
fn withdraw_settle_expire_work_with_every_pause_on() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let g = env.gateway.pubkey();
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 2 * C));
    assert_ok(env.reserve(rid(3), u.key(), 2 * C));
    for t in [PauseTarget::Buy, PauseTarget::Deposit, PauseTarget::Gateway] {
        set_pause(&mut env, t, true);
    }
    assert_ok(env.withdraw(&u, C));
    assert_ok(env.settle(rid(1), u.key(), C));
    env.warp(3_600);
    assert_ok(env.expire(rid(2), u.key()));
    assert_ok(withdraw_with(&mut env, &u, 8 * C, &[(rid(3), g)]));
    assert_eq!(user_bal(&env, &u.key()), (0, 0));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn after_shutdown_withdraw_settle_expire_work_buy_deposit_reserve_fail() {
    let mut env = Env::ready();
    let u = env.funded_user(20 * C);
    let w = env.user(5 * C);
    assert_ok(env.buy(&w, 5 * C));
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 3 * C));
    assert_ok(env.reserve(rid(3), u.key(), 4 * C));
    shutdown(&mut env);
    let ix = env.ix_shutdown(&env.admin.pubkey());
    assert_err(env.as_admin(ix), E::ShutDown); // irreversible, only once

    assert_err(env.buy(&w, C), E::ShutDown);
    assert_err(env.deposit(&w, C), E::ShutDown);
    assert_err(env.reserve(rid(4), u.key(), C), E::ShutDown);

    assert_ok(env.settle(rid(1), u.key(), C));
    assert_ok(env.settle_many(&[(rid(2), u.key(), C)]));
    env.warp(3_600);
    assert_ok(env.expire(rid(3), u.key()));
    assert_ok(set_cap(&mut env, &u, C));
    let (bal, reserved) = user_bal(&env, &u.key());
    assert_eq!((bal, reserved), (18 * C, 0));
    assert_ok(env.withdraw(&u, bal));
    assert_eq!(user_bal(&env, &u.key()), (0, 0));
    env.check_invariants(&[u.key(), w.key()], &[]);
}

#[test]
fn redeem_fails_before_shutdown_and_pays_one_to_one_after() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let h = env.user(10 * C);
    assert_ok(env.buy(&h, 10 * C));
    assert_err(env.redeem(&h, C), E::NotShutDown);
    shutdown(&mut env);
    assert_err(env.redeem(&h, 0), E::ZeroAmount);
    assert_fails(env.redeem(&h, 10 * C + 1)); // more than the wallet holds

    let before = Snap::take(&env, &h);
    assert_ok(env.redeem(&h, 4 * C));
    let want = Snap {
        reserve: -i(4 * C),
        supply: -i(4 * C),
        total_redeemed: i(4 * C),
        wallet_credits: -i(4 * C),
        wallet_usdc: i(4 * C),
        ..Snap::default()
    };
    assert_eq!(before.delta(Snap::take(&env, &h)), want);
    assert_ok(env.redeem(&h, 6 * C));
    assert_eq!(env.token_balance(&h.usdc), 10 * C);

    // credits on the API balance are withdrawn first, then redeemed
    assert_fails(env.redeem(&u, C));
    assert_ok(env.withdraw(&u, 10 * C));
    assert_ok(env.redeem(&u, 10 * C));
    assert_eq!(env.token_balance(&u.usdc), 10 * C);
    assert_eq!(env.credit_supply(), 0);
    assert_eq!(env.token_balance(&reserve_pda()), 0);
    assert_eq!(env.config().total_redeemed, 20 * C);
    env.check_invariants(&[u.key(), h.key()], &[]);
}

// ================================================================ counter-delta table (§6.3)

#[test]
fn counters_buy_credits() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C); // some prior state
    assert_ok(env.reserve(rid(1), u.key(), C));
    let a = 7 * C + 123;
    env.mint_usdc(&u.usdc, a);
    let before = Snap::take(&env, &u);
    assert_ok(env.buy(&u, a));
    let want = Snap { reserve: i(a), supply: i(a), wallet_credits: i(a), wallet_usdc: -i(a), ..Snap::default() };
    assert_eq!(before.delta(Snap::take(&env, &u)), want);
    env.check_invariants(&[u.key()], &[rid(1)]);
}

#[test]
fn counters_deposit() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), C));
    let a = 3 * C + 7;
    env.mint_usdc(&u.usdc, a);
    assert_ok(env.buy(&u, a));
    let before = Snap::take(&env, &u);
    assert_ok(env.deposit(&u, a));
    let want = Snap {
        balance: i(a),
        total_user_balance: i(a),
        vault: i(a),
        wallet_credits: -i(a),
        ..Snap::default()
    };
    assert_eq!(before.delta(Snap::take(&env, &u)), want);
    env.check_invariants(&[u.key()], &[rid(1)]);
}

#[test]
fn counters_withdraw() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), C));
    let a = 4 * C + 1;
    let before = Snap::take(&env, &u);
    assert_ok(env.withdraw(&u, a));
    let want = Snap {
        balance: -i(a),
        total_user_balance: -i(a),
        vault: -i(a),
        wallet_credits: i(a),
        ..Snap::default()
    };
    assert_eq!(before.delta(Snap::take(&env, &u)), want);

    // withdraw + expired reservations = withdraw row plus the expire row per reservation
    env.warp(3_600);
    let g = env.gateway.pubkey();
    let before = Snap::take(&env, &u);
    assert_ok(withdraw_with(&mut env, &u, a, &[(rid(1), g)]));
    let mut want = want;
    want.reserved = -i(C);
    want.active_reserved = -i(C);
    assert_eq!(before.delta(Snap::take(&env, &u)), want);
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn counters_reserve() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let a = 2 * C + 9;
    let before = Snap::take(&env, &u);
    assert_ok(env.reserve(rid(1), u.key(), a));
    assert_eq!(before.delta(Snap::take(&env, &u)), Snap { reserved: i(a), active_reserved: i(a), ..Snap::default() });
    env.check_invariants(&[u.key()], &[rid(1)]);
}

#[test]
fn counters_settle_partial() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let (a, x) = (5 * C, 2 * C + 7);
    assert_ok(env.reserve(rid(1), u.key(), a));
    assert_ok(env.reserve(rid(2), u.key(), C)); // another live reservation, untouched
    let before = Snap::take(&env, &u);
    assert_ok(env.settle(rid(1), u.key(), x));
    assert_eq!(before.delta(Snap::take(&env, &u)), settle_delta(a, x));
    assert!(env.reservation(&rid(2)).is_some());
    env.check_invariants(&[u.key()], &[rid(2)]);
}

#[test]
fn counters_expire() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let a = 3 * C + 5;
    assert_ok(env.reserve(rid(1), u.key(), a));
    env.warp(3_600);
    let before = Snap::take(&env, &u);
    assert_ok(env.expire(rid(1), u.key()));
    assert_eq!(before.delta(Snap::take(&env, &u)), expire_delta(a));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn counters_redeem() {
    let mut env = Env::ready();
    let u = env.user(10 * C);
    assert_ok(env.buy(&u, 10 * C));
    shutdown(&mut env);
    let a = 3 * C + 11;
    let before = Snap::take(&env, &u);
    assert_ok(env.redeem(&u, a));
    let want = Snap {
        reserve: -i(a),
        supply: -i(a),
        total_redeemed: i(a),
        wallet_credits: -i(a),
        wallet_usdc: i(a),
        ..Snap::default()
    };
    assert_eq!(before.delta(Snap::take(&env, &u)), want);
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn counters_sweep_surplus_with_live_reservations() {
    let mut env = Env::ready();
    let a = env.funded_user(20 * C);
    assert_ok(env.reserve(rid(1), a.key(), 5 * C));
    let b = env.user(10 * C);
    assert_ok(env.buy(&b, 10 * C));
    // b sends 3 credits straight to the vault (around deposit) and burns 2 of its own
    let ix = spl_token::instruction::transfer(&spl_token::ID, &b.credits, &vault_pda(), &b.key(), &[], 3 * C).unwrap();
    assert_ok(env.send(&[ix], &[&b.kp]));
    let ix =
        spl_token::instruction::burn(&spl_token::ID, &b.credits, &env.credit_mint, &b.key(), &[], 2 * C).unwrap();
    assert_ok(env.send(&[ix], &[&b.kp]));
    // somebody sends 1.5 USDC straight to the reserve
    env.mint_usdc(&reserve_pda(), 1_500_000);

    // supply 30 - 2 = 28, vault 23, total_user_balance 20, reserve 31.5
    // c = 23 - 20 = 3; after burning c supply = 25; u = 31.5 - 25 = 6.5
    let (c, u) = (3 * C, 6_500_000);
    let before = Snap::take(&env, &a);
    let ix = env.ix_sweep_surplus(&env.admin.pubkey());
    assert_ok(env.as_admin(ix));
    let want = Snap {
        vault: -i(c),
        reserve: -i(u),
        supply: -i(c),
        total_swept_credits: i(c),
        total_swept_usdc: i(u),
        treasury: i(u),
        ..Snap::default()
    };
    assert_eq!(before.delta(Snap::take(&env, &a)), want);
    assert_eq!(env.token_balance(&reserve_pda()), env.credit_supply());
    assert_eq!(env.token_balance(&vault_pda()), env.config().total_user_balance);
    assert!(env.reservation(&rid(1)).is_some(), "live reservation untouched");

    // a second sweep finds nothing
    let before = Snap::take(&env, &a);
    let ix = env.ix_sweep_surplus(&env.admin.pubkey());
    assert_ok(env.as_admin(ix));
    assert_eq!(before.delta(Snap::take(&env, &a)), Snap::default());

    // the held credits are still fully spendable and withdrawable
    assert_ok(env.settle(rid(1), a.key(), 5 * C));
    assert_ok(env.withdraw(&a, 15 * C));
    env.check_invariants(&[a.key(), b.key()], &[]);
}

// ================================================================ settle_many

#[test]
fn settle_many_rejects_a_duplicate_reservation() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), C));
    let before = Snap::take(&env, &u);
    let res = env.settle_many(&[(rid(1), u.key(), C), (rid(2), u.key(), 0), (rid(1), u.key(), C)]);
    assert_err(res, E::DuplicateReservation);
    assert_eq!(before.delta(Snap::take(&env, &u)), Snap::default());
    assert!(env.reservation(&rid(1)).is_some() && env.reservation(&rid(2)).is_some());
    env.check_invariants(&[u.key()], &[rid(1), rid(2)]);
}

#[test]
fn settle_many_rejects_a_user_account_that_is_not_the_owners() {
    let mut env = Env::ready();
    let a = env.funded_user(10 * C);
    let b = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), a.key(), 2 * C));
    // b's real UserAccount
    assert_err(env.settle_many(&[(rid(1), b.key(), C)]), E::InvalidUserAccount);
    let g = gw(&env);
    // a wallet, the config, a reservation instead of a UserAccount
    for fake in [a.key(), config_pda(), res_pda(&rid(1))] {
        let mut ix = env.ix_settle_many(&g.pubkey(), g.pubkey(), &[(rid(1), a.key(), C)]);
        ix.accounts[9] = AccountMeta::new(fake, false);
        assert_err(env.send(&[ix], &[&g]), E::InvalidUserAccount);
    }
    assert_eq!(user_bal(&env, &a.key()), (10 * C, 2 * C));
    assert_eq!(user_bal(&env, &b.key()), (10 * C, 0));
    assert_ok(env.settle_many(&[(rid(1), a.key(), C)]));
    env.check_invariants(&[a.key(), b.key()], &[]);
}

#[test]
fn settle_many_skips_closed_reservations() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 3 * C));
    assert_ok(env.reserve(rid(3), u.key(), 3 * C));
    assert_ok(env.settle(rid(1), u.key(), C)); // already closed by settle
    env.warp(3_600);
    assert_ok(env.expire(rid(3), u.key())); // already closed by expire
    assert_ok(env.reserve(rid(4), u.key(), 2 * C));
    let before = Snap::take(&env, &u);
    // rid(99) never existed
    let entries = [(rid(1), u.key(), 2 * C), (rid(2), u.key(), C), (rid(3), u.key(), 3 * C), (rid(99), u.key(), C), (rid(4), u.key(), 2 * C)];
    assert_ok(env.settle_many(&entries));
    assert_eq!(before.delta(Snap::take(&env, &u)), settle_delta(3 * C, C) + settle_delta(2 * C, 2 * C));
    assert!(env.reservation(&rid(2)).is_none() && env.reservation(&rid(4)).is_none());
    assert_eq!(user_bal(&env, &u.key()), (10 * C - 4 * C, 0));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_many_skips_entries_beyond_the_burn_window() {
    let mut env = Env::ready();
    set_limit(&mut env, ConfigField::BurnCapPerWindow, 3 * C);
    let u = env.funded_user(20 * C);
    for (n, amt) in [(1, C), (2, C), (3, 2 * C), (4, C), (5, 2 * C)] {
        assert_ok(env.reserve(rid(n), u.key(), amt));
    }
    let before = Snap::take(&env, &u);
    // burned so far: 1, 2, then 3rd (2) would make 4 > 3 → skipped; 4th (1) fits exactly; 5th releases (0)
    let entries =
        [(rid(1), u.key(), C), (rid(2), u.key(), C), (rid(3), u.key(), 2 * C), (rid(4), u.key(), C), (rid(5), u.key(), 0)];
    assert_ok(env.settle_many(&entries));
    for n in [1, 2, 4, 5] {
        assert!(env.reservation(&rid(n)).is_none(), "entry {n} settled");
    }
    let r3 = env.reservation(&rid(3)).expect("skipped entry stays open");
    assert_eq!(r3.amount, 2 * C);
    let d = before.delta(Snap::take(&env, &u));
    assert_eq!(d.total_burned, i(3 * C));
    assert_eq!(d.treasury, i(3 * C));
    assert_eq!(d.supply, -i(3 * C));
    assert_eq!(d.balance, -i(3 * C));
    assert_eq!(d.reserved, -i(5 * C));
    assert_eq!(d.active_reserved, -i(5 * C));
    assert_eq!(user_bal(&env, &u.key()), (17 * C, 2 * C));
    assert_eq!(env.config().window_burned, 3 * C);
    env.check_invariants(&[u.key()], &[rid(3)]);

    // still skipped in the same window, settled in the next one
    assert_ok(env.settle_many(&[(rid(3), u.key(), 2 * C)]));
    assert!(env.reservation(&rid(3)).is_some());
    env.warp(600);
    assert_ok(env.settle_many(&[(rid(3), u.key(), 2 * C)]));
    assert!(env.reservation(&rid(3)).is_none());
    assert_eq!(user_bal(&env, &u.key()), (15 * C, 0));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_many_actual_zero_releases_without_burning() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let g = env.gateway.pubkey();
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 3 * C));
    let rent = env.lamports(&res_pda(&rid(1))) + env.lamports(&res_pda(&rid(2)));
    let gw_before = env.lamports(&g);
    let before = Snap::take(&env, &u);
    let meta = assert_ok(env.settle_many(&[(rid(1), u.key(), 0), (rid(2), u.key(), 0)]));
    assert_eq!(before.delta(Snap::take(&env, &u)), expire_delta(5 * C));
    assert!(env.reservation(&rid(1)).is_none() && env.reservation(&rid(2)).is_none());
    assert_eq!(env.lamports(&g), gw_before - meta.fee + rent);
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_many_same_user_in_several_entries() {
    let mut env = Env::ready();
    let a = env.funded_user(20 * C);
    let b = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), a.key(), 2 * C));
    assert_ok(env.reserve(rid(2), a.key(), 3 * C));
    assert_ok(env.reserve(rid(3), a.key(), 4 * C));
    assert_ok(env.reserve(rid(4), b.key(), 5 * C));
    assert_ok(env.reserve(rid(5), a.key(), C)); // stays live
    let before_a = Snap::take(&env, &a);
    let before_b = Snap::take(&env, &b);
    let entries = [
        (rid(1), a.key(), C + 1),
        (rid(4), b.key(), 5 * C),
        (rid(2), a.key(), 0),
        (rid(3), a.key(), 4 * C),
    ];
    assert_ok(env.settle_many(&entries));
    let burned = C + 1 + 5 * C + 4 * C;
    assert_eq!(user_bal(&env, &a.key()), (20 * C - (C + 1) - 4 * C, C));
    assert_eq!(user_bal(&env, &b.key()), (5 * C, 0));
    let da = before_a.delta(Snap::take(&env, &a));
    let db = before_b.delta(Snap::take(&env, &b));
    assert_eq!((da.balance, da.reserved), (-i(5 * C + 1), -i(9 * C)));
    assert_eq!((db.balance, db.reserved), (-i(5 * C), -i(5 * C)));
    assert_eq!(da.total_user_balance, -i(burned));
    assert_eq!(da.active_reserved, -i(14 * C));
    assert_eq!((da.total_burned, da.total_released, da.treasury), (i(burned), i(burned), i(burned)));
    assert_eq!((da.vault, da.supply, da.reserve), (-i(burned), -i(burned), -i(burned)));
    env.check_invariants(&[a.key(), b.key()], &[rid(5)]);
}

#[test]
fn settle_many_skips_entries_paid_by_another_rent_payer() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    let old = env.gateway.pubkey();
    let new = Keypair::new();
    env.svm.airdrop(&new.pubkey(), 10_000_000_000).unwrap();
    // pre-approve a backup gateway (admin_delay), then reserve with the old key and switch
    let ix = env.ix_propose_gateway_backup(&env.admin.pubkey(), new.pubkey());
    assert_ok(env.as_admin(ix));
    env.warp(48 * 3_600);
    let ix = env.ix_apply_pending(ConfigField::GatewayBackup);
    assert_ok(env.as_anyone(ix));
    assert_ok(env.reserve(rid(1), u.key(), 2 * C)); // payer = old gateway
    let ix = env.ix_activate_backup_gateway(&env.admin.pubkey());
    assert_ok(env.as_admin(ix));
    assert_eq!(env.config().gateway, Some(new.pubkey()));
    let ix = env.ix_reserve(&new.pubkey(), rid(2), u.key(), 3 * C); // payer = new gateway
    assert_ok(env.send(&[ix], &[&new]));
    assert_eq!(env.reservation(&rid(2)).unwrap().payer, new.pubkey());
    assert_err(env.settle_many(&[(rid(1), u.key(), C)]), E::NotGateway); // old key no longer works

    // a rent payer that paid for nothing: everything skipped, nothing moves, the burn window is not used up
    let before = Snap::take(&env, &u);
    let window_before = env.config().window_burned;
    let ix = env.ix_settle_many(&new.pubkey(), Pubkey::new_unique(), &[(rid(1), u.key(), C), (rid(2), u.key(), C)]);
    assert_ok(env.send(&[ix], &[&new]));
    assert_eq!(before.delta(Snap::take(&env, &u)), Snap::default());
    assert_eq!(env.config().window_burned, window_before);

    // rent_payer = new: the entry paid by the old key is skipped and stays open
    let rent2 = env.lamports(&res_pda(&rid(2)));
    let new_before = env.lamports(&new.pubkey());
    let ix = env.ix_settle_many(&new.pubkey(), new.pubkey(), &[(rid(1), u.key(), C), (rid(2), u.key(), C)]);
    let meta = assert_ok(env.send(&[ix], &[&new]));
    assert!(env.reservation(&rid(1)).is_some(), "paid by another key: skipped");
    assert!(env.reservation(&rid(2)).is_none());
    assert_eq!(env.lamports(&new.pubkey()), new_before - meta.fee + rent2);
    assert_eq!(user_bal(&env, &u.key()), (9 * C, 2 * C));

    // and it settles once the batch names its own payer, who gets the rent
    let rent1 = env.lamports(&res_pda(&rid(1)));
    let old_before = env.lamports(&old);
    let ix = env.ix_settle_many(&new.pubkey(), old, &[(rid(1), u.key(), C), (rid(2), u.key(), C)]);
    assert_ok(env.send(&[ix], &[&new]));
    assert!(env.reservation(&rid(1)).is_none());
    assert_eq!(env.lamports(&old), old_before + rent1);
    assert_eq!(user_bal(&env, &u.key()), (8 * C, 0));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn settle_many_malformed_batches_fail() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), 2 * C));
    let g = gw(&env);
    // actual above the reservation fails the whole batch
    assert_err(env.settle_many(&[(rid(1), u.key(), C), (rid(2), u.key(), 2 * C + 1)]), E::ActualExceedsReserved);
    // fewer actuals than pairs
    let mut ix = env.ix_settle_many(&g.pubkey(), g.pubkey(), &[(rid(1), u.key(), C), (rid(2), u.key(), C)]);
    ix.data = unspent::instruction::SettleMany { actuals: vec![C] }.data();
    assert_err(env.send(&[ix], &[&g]), E::BatchLengthMismatch);
    // odd remaining accounts
    let mut ix = env.ix_settle_many(&g.pubkey(), g.pubkey(), &[(rid(1), u.key(), C)]);
    ix.accounts.pop();
    assert_err(env.send(&[ix], &[&g]), E::InvalidRemainingAccounts);
    // read-only pair
    let mut ix = env.ix_settle_many(&g.pubkey(), g.pubkey(), &[(rid(1), u.key(), C)]);
    ix.accounts[8].is_writable = false;
    assert_err(env.send(&[ix], &[&g]), E::InvalidRemainingAccounts);
    // not the gateway
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = env.ix_settle_many(&stranger.pubkey(), g.pubkey(), &[(rid(1), u.key(), C)]);
    assert_err(env.send(&[ix], &[&stranger]), E::NotGateway);
    assert_eq!(user_bal(&env, &u.key()), (10 * C, 4 * C));
    // an empty batch is a no-op
    assert_ok(env.settle_many(&[]));
    env.check_invariants(&[u.key()], &[rid(1), rid(2)]);
}

#[test]
fn settle_many_ten_entries_fit_one_legacy_transaction() {
    let mut env = Env::ready();
    // ten different owners: the worst case for the account list (20 distinct remaining accounts)
    let users: Vec<User> = (0..10).map(|_| env.funded_user(5 * C)).collect();
    let mut entries = Vec::new();
    for (n, u) in users.iter().enumerate() {
        let id = rid(100 + n as u64);
        assert_ok(env.reserve(id, u.key(), 3 * C));
        entries.push((id, u.key(), (n as u64 + 1) * 100_000 + 1));
    }
    let g = gw(&env);
    let ix = env.ix_settle_many(&g.pubkey(), g.pubkey(), &entries);
    let size = legacy_tx_size(std::slice::from_ref(&ix), &g.pubkey());
    assert!(size <= 1_232, "legacy transaction is {size} bytes, limit 1232");
    let before = Snap::take(&env, &users[0]);
    let meta = assert_ok(env.send(&[ix], &[&g]));
    println!("settle_many x10 (10 owners): {} compute units, {size} bytes", meta.compute_units_consumed);
    let burned: u64 = entries.iter().map(|e| e.2).sum();
    for (n, u) in users.iter().enumerate() {
        assert!(env.reservation(&entries[n].0).is_none());
        assert_eq!(user_bal(&env, &u.key()), (5 * C - entries[n].2, 0));
    }
    let d = before.delta(Snap::take(&env, &users[0]));
    assert_eq!((d.total_burned, d.treasury, d.supply, d.active_reserved), (i(burned), i(burned), -i(burned), -i(30 * C)));

    // the same with one owner for all ten entries (fewer accounts)
    let u = env.funded_user(40 * C);
    let mut entries = Vec::new();
    for n in 0..10u64 {
        assert_ok(env.reserve(rid(200 + n), u.key(), 3 * C));
        entries.push((rid(200 + n), u.key(), 3 * C));
    }
    let ix = env.ix_settle_many(&g.pubkey(), g.pubkey(), &entries);
    let size1 = legacy_tx_size(std::slice::from_ref(&ix), &g.pubkey());
    let meta = assert_ok(env.send(&[ix], &[&g]));
    println!("settle_many x10 (1 owner): {} compute units, {size1} bytes", meta.compute_units_consumed);
    assert_eq!(user_bal(&env, &u.key()), (10 * C, 0));
    let mut all: Vec<_> = users.iter().map(|u| u.key()).collect();
    all.push(u.key());
    env.check_invariants(&all, &[]);
}
