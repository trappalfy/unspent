//! Brief 13, attackers and admin powers: per-field delayed admin changes, `initialize` front-running and bad mints,
//! a compromised gateway, a greedy admin, forged accounts, direct transfers into the vault and reserve, overflows,
//! and a frozen USDC reserve or treasury (brief 4.1 item 2).
// TxResult (from the harness) carries LiteSVM's large failure metadata; the case tables are plain tuples.
#![allow(clippy::result_large_err, clippy::type_complexity)]

mod common;
use common::*;

use anchor_lang::{
    error::ErrorCode as AE,
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountSerialize, InstructionData,
};
use anchor_spl::token::spl_token;
use solana_account::Account;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;
use unspent::{constants::*, error::UnspentError as E, ConfigField as F, PauseTarget, PendingChange, Reservation, UserAccount};

/// Default admin_delay and reservation_ttl of `default_params`.
const DELAY: i64 = 48 * 3_600;
const TTL: i64 = 3_600;
/// SPL Token errors that surface through the program's CPIs.
const TOKEN_FROZEN: u32 = 17;
const TOKEN_INSUFFICIENT_FUNDS: u32 = 1;

const LIMITS: [F; 7] = [
    F::MaxBuyPerIx,
    F::SupplyCap,
    F::MaxReservation,
    F::MaxReservedPerUser,
    F::BurnCapPerWindow,
    F::ReservationTtl,
    F::AdminDelay,
];

// ---------------------------------------------------------------- helpers

fn funded_kp(env: &mut Env) -> Keypair {
    let k = Keypair::new();
    env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

fn send_as(env: &mut Env, ix: Instruction, kp: &Keypair) -> TxResult {
    env.send(&[ix], &[kp])
}

fn set_limit(env: &mut Env, f: F, v: u64) -> TxResult {
    let ix = env.ix_set_limit(&env.admin.pubkey(), f, v);
    env.as_admin(ix)
}

fn set_pause(env: &mut Env, t: PauseTarget, paused: bool) -> TxResult {
    let ix = env.ix_set_pause(&env.admin.pubkey(), t, paused);
    env.as_admin(ix)
}

fn apply(env: &mut Env, f: F) -> TxResult {
    let ix = env.ix_apply_pending(f);
    env.as_anyone(ix)
}

fn cancel(env: &mut Env, f: F) -> TxResult {
    let ix = env.ix_cancel_pending(&env.admin.pubkey(), f);
    env.as_admin(ix)
}

fn propose_backup(env: &mut Env, key: Pubkey) -> TxResult {
    let ix = env.ix_propose_gateway_backup(&env.admin.pubkey(), key);
    env.as_admin(ix)
}

fn propose_treasury(env: &mut Env, t: Pubkey) -> TxResult {
    let ix = env.ix_propose_treasury(&env.admin.pubkey(), t);
    env.as_admin(ix)
}

fn activate_backup(env: &mut Env) -> TxResult {
    let ix = env.ix_activate_backup_gateway(&env.admin.pubkey());
    env.as_admin(ix)
}

fn revoke(env: &mut Env) -> TxResult {
    let ix = env.ix_revoke_gateway(&env.admin.pubkey());
    env.as_admin(ix)
}

fn shutdown(env: &mut Env) -> TxResult {
    let ix = env.ix_shutdown(&env.admin.pubkey());
    env.as_admin(ix)
}

fn sweep(env: &mut Env) -> TxResult {
    let ix = env.ix_sweep_surplus(&env.admin.pubkey());
    env.as_admin(ix)
}

fn pending(env: &Env, f: F) -> PendingChange {
    env.config().pending[f.index()]
}

fn limit(env: &Env, f: F) -> u64 {
    env.config().limit(f).unwrap()
}

/// Backup gateway proposed, waited out and applied (not yet active).
fn install_backup(env: &mut Env, key: Pubkey) {
    assert_ok(propose_backup(env, key));
    env.warp(env.config().admin_delay as i64);
    assert_ok(apply(env, F::GatewayBackup));
    assert_eq!(env.config().gateway_backup, Some(key));
}

/// Replaces every account meta with key `from` by `to`.
fn swap_account(ix: &mut Instruction, from: Pubkey, to: Pubkey) {
    let mut n = 0;
    for m in ix.accounts.iter_mut().filter(|m| m.pubkey == from) {
        m.pubkey = to;
        n += 1;
    }
    assert!(n > 0, "account {from} is not in the instruction");
}

fn new_token_account(env: &mut Env, mint: Pubkey, owner: Pubkey) -> Pubkey {
    let at = Pubkey::new_unique();
    env.put_token_account(at, mint, owner, 0);
    at
}

fn spl_transfer(env: &mut Env, from: Pubkey, to: Pubkey, auth: &Keypair, amount: u64) -> TxResult {
    let ix = spl_token::instruction::transfer(&spl_token::ID, &from, &to, &auth.pubkey(), &[], amount).unwrap();
    env.send(&[ix], &[auth])
}

/// Writes an Anchor account (discriminator + data) owned by `owner` at `at`: a forgery when `owner` isn't the program.
fn put_anchor_account<T: AccountSerialize>(env: &mut Env, at: Pubkey, owner: Pubkey, v: &T) {
    let mut data = Vec::new();
    v.try_serialize(&mut data).unwrap();
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(at, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
}

fn config_bytes(env: &Env) -> Vec<u8> {
    env.svm.get_account(&config_pda()).unwrap().data
}

#[track_caller]
fn assert_code(res: TxResult, want: u32, what: &str) {
    match &res {
        Ok(_) => panic!("{what}: expected error {want}, transaction succeeded"),
        Err(f) => assert_eq!(custom_code(&res), Some(want), "{what}: got {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

/// settle_many from the real gateway with raw remaining accounts: (key, writable) per account.
fn ix_settle_many_raw(env: &Env, rem: &[(Pubkey, bool)], actuals: Vec<u64>) -> Instruction {
    let g = env.gateway.pubkey();
    let mut ix = env.ix_settle_many(&g, g, &[]);
    for (k, w) in rem {
        ix.accounts.push(if *w { AccountMeta::new(*k, false) } else { AccountMeta::new_readonly(*k, false) });
    }
    ix.data = unspent::instruction::SettleMany { actuals }.data();
    ix
}

fn gw(env: &mut Env, ix: Instruction) -> TxResult {
    let kp = env.gateway.insecure_clone();
    env.send(&[ix], &[&kp])
}

// ================================================================ A. admin and delays

/// Brief 13: apply_pending of one field doesn't roll back a lowering of another, and applies only that field.
#[test]
fn pending_changes_are_per_field() {
    let mut env = Env::ready();
    let t0 = env.now();
    assert_ok(set_limit(&mut env, F::MaxBuyPerIx, 200_000 * C));
    assert_ok(set_limit(&mut env, F::MaxReservation, 40 * C));
    assert_eq!(limit(&env, F::MaxBuyPerIx), 100_000 * C);
    assert_eq!(limit(&env, F::MaxReservation), 25 * C);
    assert_eq!(pending(&env, F::MaxBuyPerIx), PendingChange { value: 200_000 * C, key: Pubkey::default(), effective_at: t0 + DELAY });

    // other fields are lowered while the raises wait
    env.warp(3_600);
    assert_ok(set_limit(&mut env, F::SupplyCap, 1_000 * C));
    assert_ok(set_limit(&mut env, F::BurnCapPerWindow, 100 * C));
    assert_eq!(limit(&env, F::SupplyCap), 1_000 * C, "lowering is immediate");

    env.warp(DELAY);
    assert_ok(apply(&mut env, F::MaxBuyPerIx));
    let c = env.config();
    assert_eq!(c.max_buy_per_ix, 200_000 * C);
    assert_eq!(c.supply_cap, 1_000 * C, "applying one field must not roll back the lowering of another");
    assert_eq!(c.burn_cap_per_window, 100 * C);
    assert_eq!(c.max_reservation, 25 * C, "the other pending raise is not applied with it");
    assert_eq!(c.pending[F::MaxBuyPerIx.index()], PendingChange::default());
    assert_eq!(c.pending[F::MaxReservation.index()].value, 40 * C);

    assert_ok(apply(&mut env, F::MaxReservation));
    let c = env.config();
    assert_eq!(c.max_reservation, 40 * C);
    assert_eq!((c.max_buy_per_ix, c.supply_cap, c.burn_cap_per_window), (200_000 * C, 1_000 * C, 100 * C));
    assert_eq!((c.max_reserved_per_user, c.reservation_ttl, c.admin_delay), (50 * C, 3_600, DELAY as u64));
    assert!(c.pending.iter().all(|p| *p == PendingChange::default()));

    // the lowered supply cap still binds after the other field was applied
    let u = env.user(1_001 * C);
    assert_err(env.buy(&u, 1_001 * C), E::SupplyCapExceeded);
    assert_ok(env.buy(&u, 1_000 * C));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn cancel_pending_drops_only_that_change() {
    let mut env = Env::ready();
    let backup = Keypair::new().pubkey();
    let t2 = new_token_account(&mut env, USDC_MINT, Keypair::new().pubkey());
    assert_ok(set_limit(&mut env, F::MaxReservedPerUser, 100 * C));
    assert_ok(set_limit(&mut env, F::ReservationTtl, 7_200));
    assert_ok(propose_backup(&mut env, backup));
    assert_ok(propose_treasury(&mut env, t2));

    assert_ok(cancel(&mut env, F::MaxReservedPerUser));
    assert_eq!(pending(&env, F::MaxReservedPerUser), PendingChange::default());
    assert_ne!(pending(&env, F::ReservationTtl).effective_at, 0, "other pending changes stay");
    assert_err(cancel(&mut env, F::MaxReservedPerUser), E::NoPendingChange);
    assert_err(cancel(&mut env, F::SupplyCap), E::NoPendingChange);
    assert_ok(cancel(&mut env, F::GatewayBackup));
    assert_eq!(pending(&env, F::GatewayBackup), PendingChange::default());

    env.warp(DELAY);
    assert_err(apply(&mut env, F::MaxReservedPerUser), E::NoPendingChange);
    assert_err(apply(&mut env, F::GatewayBackup), E::NoPendingChange);
    assert_eq!(env.config().max_reserved_per_user, 50 * C);
    assert_eq!(env.config().gateway_backup, None);
    assert_ok(apply(&mut env, F::ReservationTtl));
    assert_ok(apply(&mut env, F::Treasury));
    let c = env.config();
    assert_eq!((c.reservation_ttl, c.treasury), (7_200, t2));
}

#[test]
fn apply_pending_waits_for_effective_at_and_anyone_can_apply() {
    let mut env = Env::ready();
    let t0 = env.now();
    assert_err(apply(&mut env, F::SupplyCap), E::NoPendingChange);
    assert_ok(set_limit(&mut env, F::SupplyCap, 300_000 * C));
    assert_eq!(pending(&env, F::SupplyCap).effective_at, t0 + DELAY);
    assert_err(apply(&mut env, F::SupplyCap), E::PendingNotReady);
    env.warp(DELAY - 1);
    assert_err(apply(&mut env, F::SupplyCap), E::PendingNotReady);
    // the admin can't apply it early either
    let ix = env.ix_apply_pending(F::SupplyCap);
    assert_err(env.as_admin(ix), E::PendingNotReady);
    assert_eq!(limit(&env, F::SupplyCap), 250_000 * C);

    env.warp(1); // now == effective_at
    let u = env.user(0);
    let ix = env.ix_apply_pending(F::SupplyCap);
    assert_ok(send_as(&mut env, ix, &u.kp)); // a random user applies it
    assert_eq!(limit(&env, F::SupplyCap), 300_000 * C);
    assert_err(apply(&mut env, F::SupplyCap), E::NoPendingChange);
}

/// Raising any limit only goes through admin_delay; the raised value has no effect before it is applied.
#[test]
fn raising_any_limit_waits_for_admin_delay() {
    let mut env = Env::ready();
    let u = env.funded_user(60 * C);
    let t0 = env.now();
    let raises = [
        (F::MaxBuyPerIx, 200_000 * C),
        (F::SupplyCap, 500_000 * C),
        (F::MaxReservation, 50 * C),
        (F::MaxReservedPerUser, 100 * C),
        (F::BurnCapPerWindow, 6_000 * C),
        (F::ReservationTtl, 7_200),
    ];
    for (f, v) in raises {
        let before = limit(&env, f);
        assert_ok(set_limit(&mut env, f, v));
        assert_eq!(limit(&env, f), before, "{f:?}: a raise must not apply at once");
        assert_eq!(pending(&env, f), PendingChange { value: v, key: Pubkey::default(), effective_at: t0 + DELAY }, "{f:?}");
        assert_err(apply(&mut env, f), E::PendingNotReady);
    }
    assert_err(env.reserve(rid(1), u.key(), 30 * C), E::ReservationTooLarge);

    env.warp(DELAY - 1);
    for (f, _) in raises {
        assert_err(apply(&mut env, f), E::PendingNotReady);
    }
    assert_err(env.reserve(rid(1), u.key(), 30 * C), E::ReservationTooLarge);
    env.warp(1);
    for (f, v) in raises {
        assert_ok(apply(&mut env, f));
        assert_eq!(limit(&env, f), v, "{f:?}");
    }
    assert_ok(env.reserve(rid(1), u.key(), 30 * C));
    assert_eq!(env.reservation(&rid(1)).unwrap().expires_at, env.now() + 7_200, "new ttl in force");
    env.check_invariants(&[u.key()], &[rid(1)]);
}

/// Any change of admin_delay, down or up, waits for the current admin_delay.
#[test]
fn admin_delay_changes_only_through_delay_both_directions() {
    let mut env = Env::ready();
    let day = 24 * 3_600i64;
    let t0 = env.now();
    // lowering 48h → 24h is still delayed
    assert_ok(set_limit(&mut env, F::AdminDelay, day as u64));
    assert_eq!(env.config().admin_delay, DELAY as u64, "lowering admin_delay is not immediate");
    assert_eq!(pending(&env, F::AdminDelay).effective_at, t0 + DELAY);
    // a raise of another field proposed meanwhile keeps the current delay
    assert_ok(set_limit(&mut env, F::MaxReservation, 30 * C));
    assert_eq!(pending(&env, F::MaxReservation).effective_at, t0 + DELAY);
    env.warp(DELAY - 1);
    assert_err(apply(&mut env, F::AdminDelay), E::PendingNotReady);
    env.warp(1);
    assert_ok(apply(&mut env, F::AdminDelay));
    assert_eq!(env.config().admin_delay, day as u64);
    assert_eq!(pending(&env, F::MaxReservation).effective_at, t0 + DELAY, "earlier proposals keep their time");

    // raising 24h → 14d waits the current 24h
    let t1 = env.now();
    assert_ok(set_limit(&mut env, F::AdminDelay, ADMIN_DELAY_MAX));
    assert_eq!(env.config().admin_delay, day as u64, "raising admin_delay is not immediate");
    assert_eq!(pending(&env, F::AdminDelay).effective_at, t1 + day);
    // setting the same value is also a delayed change
    assert_ok(set_limit(&mut env, F::AdminDelay, day as u64));
    assert_eq!(env.config().admin_delay, day as u64);
    assert_eq!(pending(&env, F::AdminDelay).value, day as u64);
    assert_ok(set_limit(&mut env, F::AdminDelay, ADMIN_DELAY_MAX));
    env.warp(day - 1);
    assert_err(apply(&mut env, F::AdminDelay), E::PendingNotReady);
    env.warp(1);
    assert_ok(apply(&mut env, F::AdminDelay));
    assert_eq!(env.config().admin_delay, ADMIN_DELAY_MAX);
    let t2 = env.now();
    assert_ok(set_limit(&mut env, F::SupplyCap, 260_000 * C));
    assert_eq!(pending(&env, F::SupplyCap).effective_at, t2 + ADMIN_DELAY_MAX as i64);
}

/// Lowering a limit is immediate and drops a pending raise of the same field.
#[test]
fn lowering_is_immediate_and_clears_pending_raise() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    let cases = [
        (F::MaxBuyPerIx, 200_000 * C, 50_000 * C),
        (F::SupplyCap, 500_000 * C, 100_000 * C),
        (F::MaxReservation, 50 * C, 10 * C),
        (F::MaxReservedPerUser, 100 * C, 20 * C),
        (F::BurnCapPerWindow, 6_000 * C, 1_000 * C),
        (F::ReservationTtl, 7_200, 1_800),
    ];
    for (f, raise, lower) in cases {
        assert_ok(set_limit(&mut env, f, raise));
        assert_ne!(pending(&env, f).effective_at, 0);
        assert_ok(set_limit(&mut env, f, lower));
        assert_eq!(limit(&env, f), lower, "{f:?}: lowering is immediate");
        assert_eq!(pending(&env, f), PendingChange::default(), "{f:?}: lowering clears the pending raise");
    }
    // lowered limits bind at once
    assert_err(env.reserve(rid(1), u.key(), 10 * C + 1), E::ReservationTooLarge);
    assert_ok(env.reserve(rid(1), u.key(), 10 * C));
    assert_eq!(env.reservation(&rid(1)).unwrap().expires_at, env.now() + 1_800);

    env.warp(DELAY);
    for (f, _, lower) in cases {
        assert_err(apply(&mut env, f), E::NoPendingChange);
        assert_eq!(limit(&env, f), lower, "{f:?}: the cleared raise never comes back");
    }
    env.check_invariants(&[u.key()], &[rid(1)]);
}

/// A new raise of the same field restarts its delay: a pending value can't be swapped late in the wait.
#[test]
fn reproposing_a_raise_restarts_the_delay() {
    let mut env = Env::ready();
    let t0 = env.now();
    assert_ok(set_limit(&mut env, F::MaxReservation, 100 * C));
    env.warp(DELAY - 3_600);
    assert_ok(set_limit(&mut env, F::MaxReservation, 60 * C));
    assert_eq!(pending(&env, F::MaxReservation).effective_at, t0 + 2 * DELAY - 3_600);
    env.warp(3_600); // t0 + DELAY
    assert_err(apply(&mut env, F::MaxReservation), E::PendingNotReady);
    assert_eq!(limit(&env, F::MaxReservation), 25 * C);
    env.warp(DELAY - 3_600);
    assert_ok(apply(&mut env, F::MaxReservation));
    assert_eq!(limit(&env, F::MaxReservation), 60 * C);
}

#[test]
fn pause_and_unpause_are_immediate() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    let b = env.user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));

    assert_ok(set_pause(&mut env, PauseTarget::Buy, true));
    assert!(env.config().buy_paused);
    assert_err(env.buy(&b, C), E::BuyPaused);
    assert_ok(set_pause(&mut env, PauseTarget::Deposit, true));
    assert_ok(env.withdraw(&u, C));
    assert_err(env.deposit(&u, C), E::DepositPaused);
    assert_ok(set_pause(&mut env, PauseTarget::Gateway, true));
    assert_err(env.reserve(rid(2), u.key(), C), E::GatewayPaused);
    // closing paths and withdraw keep working under every pause
    assert_ok(env.settle(rid(1), u.key(), C));
    assert_ok(env.withdraw(&u, C));

    assert_ok(set_pause(&mut env, PauseTarget::Buy, false));
    assert_ok(env.buy(&b, C));
    assert_ok(set_pause(&mut env, PauseTarget::Deposit, false));
    assert_ok(env.deposit(&u, 2 * C));
    assert_ok(set_pause(&mut env, PauseTarget::Gateway, false));
    assert_ok(env.reserve(rid(2), u.key(), C));
    let c = env.config();
    assert!(!c.buy_paused && !c.deposit_paused && !c.gateway_paused);
    env.check_invariants(&[u.key(), b.key()], &[rid(2)]);
}

#[test]
fn revoke_gateway_is_immediate() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    assert_ok(revoke(&mut env));
    assert_eq!(env.config().gateway, None);
    assert_err(env.reserve(rid(2), u.key(), C), E::NotGateway);
    assert_err(env.settle(rid(1), u.key(), C), E::NotGateway);
    assert_err(env.settle_many(&[(rid(1), u.key(), C)]), E::NotGateway);
    // the held amount is released by expiry, rent goes to the old gateway, the rest was always withdrawable
    assert_ok(env.withdraw(&u, 45 * C));
    env.warp(TTL);
    let g = env.gateway.pubkey();
    let before = env.lamports(&g);
    assert_ok(env.expire(rid(1), u.key()));
    assert!(env.lamports(&g) > before);
    assert_ok(env.withdraw(&u, 5 * C));
    assert_ok(revoke(&mut env)); // idempotent
    env.check_invariants(&[u.key()], &[]);
}

/// The backup key waits for admin_delay; activating it is immediate and clears the backup slot.
#[test]
fn backup_gateway_waits_for_delay_activation_is_immediate() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    let backup = funded_kp(&mut env);
    let old = env.gateway.insecure_clone();

    assert_ok(propose_backup(&mut env, backup.pubkey()));
    assert_eq!(env.config().gateway_backup, None);
    assert_eq!(pending(&env, F::GatewayBackup).key, backup.pubkey());
    assert_err(activate_backup(&mut env), E::NoBackupGateway);
    assert_err(apply(&mut env, F::GatewayBackup), E::PendingNotReady);
    env.warp(DELAY - 1);
    assert_err(apply(&mut env, F::GatewayBackup), E::PendingNotReady);
    env.warp(1);
    assert_ok(apply(&mut env, F::GatewayBackup));
    assert_eq!(env.config().gateway_backup, Some(backup.pubkey()));
    assert_eq!(env.config().gateway, Some(old.pubkey()));

    // an approved but inactive backup can't act
    let ix = env.ix_reserve(&backup.pubkey(), rid(9), u.key(), C);
    assert_err(send_as(&mut env, ix, &backup), E::NotGateway);

    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    assert_ok(activate_backup(&mut env));
    let c = env.config();
    assert_eq!((c.gateway, c.gateway_backup), (Some(backup.pubkey()), None));
    // old key is out at once
    assert_err(env.reserve(rid(2), u.key(), C), E::NotGateway);
    assert_err(env.settle(rid(1), u.key(), C), E::NotGateway);
    // the new key settles the old key's reservation (rent back to the old key) and makes new ones
    let ix = env.ix_settle(&backup.pubkey(), rid(1), u.key(), old.pubkey(), 2 * C);
    assert_ok(send_as(&mut env, ix, &backup));
    let ix = env.ix_reserve(&backup.pubkey(), rid(2), u.key(), C);
    assert_ok(send_as(&mut env, ix, &backup));
    let ix = env.ix_settle_many(&backup.pubkey(), backup.pubkey(), &[(rid(2), u.key(), C)]);
    assert_ok(send_as(&mut env, ix, &backup));
    assert_err(activate_backup(&mut env), E::NoBackupGateway);

    // revoke first, then switch to another pre-approved key: no downtime beyond the switch
    let backup2 = funded_kp(&mut env);
    install_backup(&mut env, backup2.pubkey());
    assert_ok(revoke(&mut env));
    assert_eq!(env.config().gateway, None);
    assert_ok(activate_backup(&mut env));
    assert_eq!(env.config().gateway, Some(backup2.pubkey()));
    let ix = env.ix_reserve(&backup2.pubkey(), rid(3), u.key(), C);
    assert_ok(send_as(&mut env, ix, &backup2));
    let ix = env.ix_reserve(&backup.pubkey(), rid(4), u.key(), C);
    assert_err(send_as(&mut env, ix, &backup), E::NotGateway);
    env.check_invariants(&[u.key()], &[rid(3)]);
}

/// A new treasury applies only after admin_delay; until then USDC keeps going to the old one.
#[test]
fn new_treasury_waits_for_delay() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    let t_owner = Keypair::new().pubkey();
    let t2 = new_token_account(&mut env, USDC_MINT, t_owner);
    let old = env.treasury;

    assert_ok(propose_treasury(&mut env, t2));
    assert_eq!(env.config().treasury, old);
    assert_eq!(pending(&env, F::Treasury).key, t2);
    // invalid proposals don't replace the pending one
    let cm = env.credit_mint;
    let credit_acc = new_token_account(&mut env, cm, t_owner);
    assert_err(propose_treasury(&mut env, credit_acc), E::InvalidTreasury);
    assert_err(propose_treasury(&mut env, reserve_pda()), E::InvalidTreasury);
    assert_err(propose_treasury(&mut env, vault_pda()), E::InvalidTreasury);
    assert_eq!(pending(&env, F::Treasury).key, t2);

    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    let g = env.gateway.pubkey();
    let mut ix = env.ix_settle(&g, rid(1), u.key(), g, 2 * C);
    swap_account(&mut ix, old, t2);
    assert_err(gw(&mut env, ix), E::InvalidTreasury);
    assert_ok(env.settle(rid(1), u.key(), 2 * C));
    assert_eq!((env.token_balance(&old), env.token_balance(&t2)), (2 * C, 0));

    env.warp(DELAY - 1);
    assert_err(apply(&mut env, F::Treasury), E::PendingNotReady);
    env.warp(1);
    assert_ok(apply(&mut env, F::Treasury));
    assert_eq!(env.config().treasury, t2);
    assert_ok(env.reserve(rid(2), u.key(), 5 * C));
    let mut ix = env.ix_settle(&g, rid(2), u.key(), g, C);
    swap_account(&mut ix, t2, old);
    assert_err(gw(&mut env, ix), E::InvalidTreasury);
    assert_ok(env.settle(rid(2), u.key(), C));
    assert_eq!((env.token_balance(&old), env.token_balance(&t2)), (2 * C, C));
    env.check_invariants(&[u.key()], &[]);
}

#[test]
fn limit_bounds_and_not_a_limit() {
    let mut env = Env::ready();
    let bounds = [
        (F::MaxBuyPerIx, 0, MAX_BUY_PER_IX_BOUND),
        (F::SupplyCap, 0, SUPPLY_CAP_BOUND),
        (F::MaxReservation, 0, MAX_RESERVATION_BOUND),
        (F::MaxReservedPerUser, 0, MAX_RESERVED_PER_USER_BOUND),
        (F::BurnCapPerWindow, 0, BURN_CAP_BOUND),
        (F::ReservationTtl, RESERVATION_TTL_MIN, RESERVATION_TTL_MAX),
        (F::AdminDelay, ADMIN_DELAY_MIN, ADMIN_DELAY_MAX),
    ];
    for (f, lo, hi) in bounds {
        assert_err(set_limit(&mut env, f, hi + 1), E::OutOfBounds);
        assert_err(set_limit(&mut env, f, u64::MAX), E::OutOfBounds);
        if lo > 0 {
            assert_err(set_limit(&mut env, f, lo - 1), E::OutOfBounds);
        }
        assert_ok(set_limit(&mut env, f, hi)); // a raise → pending
        assert_eq!(pending(&env, f).value, hi, "{f:?}");
        if f != F::AdminDelay {
            assert_ok(set_limit(&mut env, f, lo)); // a lowering → immediate
            assert_eq!(limit(&env, f), lo, "{f:?}");
        }
    }
    for f in [F::GatewayBackup, F::Treasury] {
        assert_err(set_limit(&mut env, f, 0), E::NotALimit);
        assert_err(set_limit(&mut env, f, 1), E::NotALimit);
    }
    // the bounds hold when the pending values are applied, too
    env.warp(DELAY);
    assert_ok(apply(&mut env, F::AdminDelay));
    assert_eq!(env.config().admin_delay, ADMIN_DELAY_MAX);
    for f in LIMITS {
        let v = limit(&env, f);
        let (lo, hi) = f.bounds().unwrap();
        assert!(v >= lo && v <= hi, "{f:?} = {v} out of bounds");
    }
}

/// Every admin instruction rejects any signer other than Config.admin (has_one → ConstraintHasOne).
#[test]
fn non_admin_signer_fails_every_admin_instruction() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    install_backup(&mut env, Keypair::new().pubkey());
    assert_ok(set_limit(&mut env, F::MaxReservation, 30 * C)); // something to cancel
    let reserve_now = env.token_balance(&reserve_pda());
    env.put_token_account(reserve_pda(), USDC_MINT, config_pda(), reserve_now + C); // surplus to sweep
    let t2 = new_token_account(&mut env, USDC_MINT, Keypair::new().pubkey());

    let attackers = [
        funded_kp(&mut env),
        env.gateway.insecure_clone(),
        env.deployer.insecure_clone(),
        env.treasury_owner.insecure_clone(),
        u.kp.insecure_clone(),
    ];
    let before = config_bytes(&env);
    let treasury_before = env.token_balance(&env.treasury);
    for k in &attackers {
        let a = k.pubkey();
        let ixs = [
            ("set_limit", env.ix_set_limit(&a, F::MaxReservation, C)),
            ("set_limit raise", env.ix_set_limit(&a, F::MaxReservation, 1_000 * C)),
            ("set_pause", env.ix_set_pause(&a, PauseTarget::Buy, true)),
            ("set_pause off", env.ix_set_pause(&a, PauseTarget::Deposit, false)),
            ("propose_gateway_backup", env.ix_propose_gateway_backup(&a, a)),
            ("propose_treasury", env.ix_propose_treasury(&a, t2)),
            ("cancel_pending", env.ix_cancel_pending(&a, F::MaxReservation)),
            ("revoke_gateway", env.ix_revoke_gateway(&a)),
            ("activate_backup_gateway", env.ix_activate_backup_gateway(&a)),
            ("shutdown", env.ix_shutdown(&a)),
            ("sweep_surplus", env.ix_sweep_surplus(&a)),
        ];
        for (name, ix) in ixs {
            assert_code(send_as(&mut env, ix, k), u32::from(AE::ConstraintHasOne), name);
        }
    }
    // the admin's key without the admin's signature
    let attacker = funded_kp(&mut env);
    let mut ix = env.ix_shutdown(&env.admin.pubkey());
    ix.accounts[0].is_signer = false;
    assert_anchor_err(send_as(&mut env, ix, &attacker), AE::AccountNotSigner);
    let mut ix = env.ix_sweep_surplus(&env.admin.pubkey());
    ix.accounts[0].is_signer = false;
    assert_anchor_err(send_as(&mut env, ix, &attacker), AE::AccountNotSigner);

    assert_eq!(config_bytes(&env), before, "config untouched");
    assert_eq!(env.token_balance(&env.treasury), treasury_before);
    // the real admin can still do all of it
    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), treasury_before + C);
}

#[test]
fn shutdown_is_immediate_and_only_once() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    let b = env.user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    assert_ok(shutdown(&mut env));
    assert!(env.config().shut_down);
    assert_err(env.buy(&b, C), E::ShutDown);
    assert_ok(env.withdraw(&u, C));
    assert_err(env.deposit(&u, C), E::ShutDown);
    assert_err(env.reserve(rid(2), u.key(), C), E::ShutDown);
    assert_err(shutdown(&mut env), E::ShutDown);
    assert!(env.config().shut_down);
    // unpausing doesn't reopen anything
    assert_ok(set_pause(&mut env, PauseTarget::Buy, false));
    assert_err(env.buy(&b, C), E::ShutDown);
    // live reservations still close, withdraw and redeem work
    assert_ok(env.settle(rid(1), u.key(), C));
    assert_ok(env.withdraw(&u, 48 * C));
    let held = env.token_balance(&u.credits);
    assert_ok(env.redeem(&u, held));
    env.check_invariants(&[u.key()], &[]);
}

// ================================================================ B. initialize

fn init_as(env: &mut Env, kp: &Keypair, params: unspent::InitializeParams) -> TxResult {
    let ix = env.ix_initialize(&kp.pubkey(), params);
    send_as(env, ix, kp)
}

#[test]
fn initialize_requires_upgrade_authority() {
    let mut env = Env::new();
    let attacker = funded_kp(&mut env);
    let params = default_params(attacker.pubkey(), Some(attacker.pubkey()));
    for k in [attacker.insecure_clone(), env.admin.insecure_clone(), env.gateway.insecure_clone()] {
        assert_err(init_as(&mut env, &k, params.clone()), E::NotUpgradeAuthority);
    }
    // the attacker's own ProgramData (as for a program they deployed) with them as upgrade authority
    let mut pd = env.svm.get_account(&program_data_pda()).unwrap();
    pd.data[13..45].copy_from_slice(attacker.pubkey().as_ref());
    let fake_pd = Pubkey::new_unique();
    env.svm.set_account(fake_pd, pd).unwrap();
    let mut ix = env.ix_initialize(&attacker.pubkey(), params.clone());
    swap_account(&mut ix, program_data_pda(), fake_pd);
    assert_err(send_as(&mut env, ix, &attacker), E::NotUpgradeAuthority);
    // not a ProgramData at all
    let mut ix = env.ix_initialize(&attacker.pubkey(), params);
    swap_account(&mut ix, program_data_pda(), attacker.pubkey());
    assert_anchor_err(send_as(&mut env, ix, &attacker), AE::AccountOwnedByWrongProgram);
    assert!(!env.exists(&config_pda()), "nothing was created");

    assert_ok(env.initialize(default_params(env.admin.pubkey(), Some(env.gateway.pubkey()))));
    assert_eq!(env.config().admin, env.admin.pubkey());
}

#[test]
fn initialize_rejects_bad_credit_mints() {
    let mut env = Env::new();
    let cfg = config_pda();
    let other = Keypair::new().pubkey();
    let deployer = env.deployer.pubkey();
    let params = default_params(env.admin.pubkey(), Some(env.gateway.pubkey()));
    let bad: [(&str, Option<Pubkey>, Option<Pubkey>, u8, u64); 8] = [
        ("non-zero supply", Some(cfg), None, 6, 1),
        ("large supply", Some(cfg), None, 6, 1_000 * C),
        ("freeze authority = Config", Some(cfg), Some(cfg), 6, 0),
        ("freeze authority = other", Some(cfg), Some(other), 6, 0),
        ("decimals 9", Some(cfg), None, 9, 0),
        ("decimals 0", Some(cfg), None, 0, 0),
        ("mint authority = deployer", Some(deployer), None, 6, 0),
        ("no mint authority", None, None, 6, 0),
    ];
    let cm = env.credit_mint;
    for (what, auth, freeze, decimals, supply) in bad {
        env.put_mint(cm, auth, freeze, decimals, supply);
        assert_code(env.initialize(params.clone()), code(E::InvalidMint), what);
        assert!(!env.exists(&config_pda()), "{what}");
    }
    // USDC itself as the credit mint
    env.put_mint(cm, Some(cfg), None, CREDIT_DECIMALS, 0);
    let mut ix = env.ix_initialize(&deployer, params.clone());
    ix.accounts[4].pubkey = USDC_MINT; // credit_mint
    let kp = env.deployer.insecure_clone();
    assert_code(send_as(&mut env, ix, &kp), code(E::InvalidMint), "credit mint = USDC");
    // a valid mint owned by Token-2022 instead of SPL Token
    let mut acc = env.svm.get_account(&cm).unwrap();
    acc.owner = anchor_spl::token_2022::ID;
    env.svm.set_account(cm, acc).unwrap();
    assert_anchor_err(env.initialize(params.clone()), AE::AccountOwnedByWrongProgram);

    env.put_mint(cm, Some(cfg), None, CREDIT_DECIMALS, 0);
    assert_ok(env.initialize(params));
    assert_eq!(env.config().credit_mint, cm);
}

#[test]
fn initialize_rejects_wrong_usdc_mint() {
    let mut env = Env::new();
    let attacker = Keypair::new().pubkey();
    let fake_usdc = Pubkey::new_unique();
    env.put_mint(fake_usdc, Some(attacker), None, 6, 0);
    let fake_treasury = new_token_account(&mut env, fake_usdc, attacker);
    let params = default_params(env.admin.pubkey(), Some(env.gateway.pubkey()));
    let deployer = env.deployer.insecure_clone();

    let mut ix = env.ix_initialize(&deployer.pubkey(), params.clone());
    swap_account(&mut ix, USDC_MINT, fake_usdc);
    swap_account(&mut ix, env.treasury, fake_treasury);
    assert_err(send_as(&mut env, ix, &deployer), E::InvalidMint);
    let mut ix = env.ix_initialize(&deployer.pubkey(), params.clone());
    swap_account(&mut ix, USDC_MINT, fake_usdc);
    assert_err(send_as(&mut env, ix, &deployer), E::InvalidMint);
    assert!(!env.exists(&config_pda()));
    assert_ok(env.initialize(params));
    assert_eq!(env.config().usdc_mint, USDC_MINT);
}

#[test]
fn initialize_rejects_non_usdc_treasury() {
    let mut env = Env::new();
    let params = default_params(env.admin.pubkey(), Some(env.gateway.pubkey()));
    let owner = env.treasury_owner.pubkey();
    let other_mint = Pubkey::new_unique();
    env.put_mint(other_mint, Some(owner), None, 6, 0);
    let t = env.treasury;
    for (what, mint) in [("other mint", other_mint), ("credit mint", env.credit_mint)] {
        env.put_token_account(t, mint, owner, 0);
        assert_code(env.initialize(params.clone()), code(E::InvalidTreasury), what);
    }
    // not a token account
    env.svm.set_account(t, Account { lamports: 1_000_000_000, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 }).unwrap();
    assert_anchor_err(env.initialize(params.clone()), AE::AccountOwnedByWrongProgram);
    assert!(!env.exists(&config_pda()));
    env.put_token_account(t, USDC_MINT, owner, 0);
    assert_ok(env.initialize(params));
    assert_eq!(env.config().treasury, t);
}

/// initialize can't be used to skip the bounds (e.g. a zero admin_delay).
#[test]
fn initialize_rejects_out_of_bounds_params() {
    let mut env = Env::new();
    let base = default_params(env.admin.pubkey(), Some(env.gateway.pubkey()));
    let cases: Vec<(&str, unspent::InitializeParams)> = vec![
        ("admin_delay 0", unspent::InitializeParams { admin_delay: 0, ..base.clone() }),
        ("admin_delay < 24h", unspent::InitializeParams { admin_delay: ADMIN_DELAY_MIN - 1, ..base.clone() }),
        ("admin_delay > 14d", unspent::InitializeParams { admin_delay: ADMIN_DELAY_MAX + 1, ..base.clone() }),
        ("ttl < 30m", unspent::InitializeParams { reservation_ttl: RESERVATION_TTL_MIN - 1, ..base.clone() }),
        ("ttl > 24h", unspent::InitializeParams { reservation_ttl: RESERVATION_TTL_MAX + 1, ..base.clone() }),
        ("max_buy", unspent::InitializeParams { max_buy_per_ix: MAX_BUY_PER_IX_BOUND + 1, ..base.clone() }),
        ("supply_cap", unspent::InitializeParams { supply_cap: u64::MAX, ..base.clone() }),
        ("max_reservation", unspent::InitializeParams { max_reservation: MAX_RESERVATION_BOUND + 1, ..base.clone() }),
        ("max_reserved_per_user", unspent::InitializeParams { max_reserved_per_user: MAX_RESERVED_PER_USER_BOUND + 1, ..base.clone() }),
        ("burn_cap", unspent::InitializeParams { burn_cap_per_window: BURN_CAP_BOUND + 1, ..base.clone() }),
    ];
    for (what, p) in cases {
        assert_code(env.initialize(p), code(E::OutOfBounds), what);
    }
    assert_ok(env.initialize(base));
}

#[test]
fn second_initialize_fails() {
    let mut env = Env::ready();
    let before = config_bytes(&env);
    let attacker = funded_kp(&mut env);
    // Config already exists: its `init` fails in the system program ("already in use", custom 0)
    assert_code(env.initialize(default_params(attacker.pubkey(), Some(attacker.pubkey()))), 0, "by the deployer");
    assert_code(init_as(&mut env, &attacker, default_params(attacker.pubkey(), Some(attacker.pubkey()))), 0, "by an attacker");
    assert_eq!(config_bytes(&env), before);
    assert_eq!(env.config().admin, env.admin.pubkey());
}

// ================================================================ C. attackers

/// A (compromised) gateway can hold at most min(available, max_reservation per request, hold limit per user).
#[test]
fn gateway_cannot_hold_more_than_allowed() {
    let mut env = Env::ready();
    // more than available
    let a = env.funded_user(30 * C);
    assert_ok(env.reserve(rid(1), a.key(), 20 * C));
    assert_err(env.reserve(rid(2), a.key(), 10 * C + 1), E::InsufficientAvailable);
    assert_ok(env.reserve(rid(2), a.key(), 10 * C));
    assert_err(env.reserve(rid(3), a.key(), 1), E::InsufficientAvailable);
    assert_err(env.reserve(rid(3), a.key(), 0), E::ZeroAmount);

    // more than max_reservation per request
    let b = env.funded_user(100 * C);
    assert_err(env.reserve(rid(10), b.key(), 25 * C + 1), E::ReservationTooLarge);
    // more than max_reserved_per_user: the rest stays withdrawable
    assert_ok(env.reserve(rid(10), b.key(), 25 * C));
    assert_ok(env.reserve(rid(11), b.key(), 25 * C));
    assert_err(env.reserve(rid(12), b.key(), 1), E::UserHoldLimitExceeded);
    assert_ok(env.withdraw(&b, 50 * C));
    assert_eq!(env.token_balance(&b.credits), 50 * C);

    // user's own lower cap
    let c = env.funded_user(20 * C);
    let ix = env.ix_set_my_reserve_cap(&c.key(), 5 * C);
    assert_ok(send_as(&mut env, ix, &c.kp));
    assert_err(env.reserve(rid(20), c.key(), 5 * C + 1), E::UserHoldLimitExceeded);
    assert_ok(env.reserve(rid(20), c.key(), 5 * C));

    // a wallet with credits but no UserAccount, and one whose balance is zero
    let d = env.user(10 * C);
    assert_ok(env.buy(&d, 10 * C));
    assert_anchor_err(env.reserve(rid(30), d.key(), C), AE::AccountNotInitialized);
    let e = env.funded_user(C);
    assert_ok(env.withdraw(&e, C));
    assert_err(env.reserve(rid(31), e.key(), 1), E::InsufficientAvailable);
    // owner argument of one user with another user's account
    let ix = {
        let mut ix = env.ix_reserve(&env.gateway.pubkey(), rid(32), d.key(), C);
        swap_account(&mut ix, user_pda(&d.key()), user_pda(&b.key()));
        ix
    };
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintSeeds);
    assert!(env.reservation(&rid(32)).is_none());

    let users = [a.key(), b.key(), c.key(), d.key(), e.key()];
    env.check_invariants(&users, &[rid(1), rid(2), rid(10), rid(11), rid(20)]);
}

#[test]
fn non_gateway_keys_cannot_reserve_or_settle() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    let g = env.gateway.pubkey();
    let attackers =
        [funded_kp(&mut env), env.admin.insecure_clone(), env.deployer.insecure_clone(), env.treasury_owner.insecure_clone(), u.kp.insecure_clone()];
    for (i, k) in attackers.iter().enumerate() {
        let a = k.pubkey();
        let ix = env.ix_reserve(&a, rid(100 + i as u64), u.key(), C);
        assert_err(send_as(&mut env, ix, k), E::NotGateway);
        let ix = env.ix_settle(&a, rid(1), u.key(), g, 5 * C);
        assert_err(send_as(&mut env, ix, k), E::NotGateway);
        let ix = env.ix_settle_many(&a, g, &[(rid(1), u.key(), 5 * C)]);
        assert_err(send_as(&mut env, ix, k), E::NotGateway);
        let ix = env.ix_settle_many(&a, a, &[(rid(1), u.key(), 0)]);
        assert_err(send_as(&mut env, ix, k), E::NotGateway);
    }
    // the gateway's key without its signature
    let attacker = funded_kp(&mut env);
    let mut ix = env.ix_settle(&g, rid(1), u.key(), g, 5 * C);
    ix.accounts[0].is_signer = false;
    assert_anchor_err(send_as(&mut env, ix, &attacker), AE::AccountNotSigner);

    let r = env.reservation(&rid(1)).unwrap();
    assert_eq!((r.amount, r.payer), (5 * C, g));
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (50 * C, 5 * C));
    assert_eq!(env.token_balance(&env.treasury), 0);
    env.check_invariants(&[u.key()], &[rid(1)]);
}

#[test]
fn gateway_cannot_burn_more_than_reserved() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    assert_ok(env.reserve(rid(2), u.key(), C));
    assert_err(env.settle(rid(1), u.key(), 5 * C + 1), E::ActualExceedsReserved);
    assert_err(env.settle(rid(1), u.key(), u64::MAX), E::ActualExceedsReserved);
    assert_err(env.settle_many(&[(rid(1), u.key(), 5 * C + 1)]), E::ActualExceedsReserved);
    // one bad entry fails the whole batch, including a valid one before it
    assert_err(env.settle_many(&[(rid(2), u.key(), C), (rid(1), u.key(), 5 * C + 1)]), E::ActualExceedsReserved);
    assert!(env.reservation(&rid(2)).is_some());
    assert_eq!(env.credit_supply(), 50 * C);
    assert_ok(env.settle_many(&[(rid(2), u.key(), C), (rid(1), u.key(), 5 * C)]));
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (44 * C, 0));
    assert_eq!(env.token_balance(&env.treasury), 6 * C);
    env.check_invariants(&[u.key()], &[]);
}

/// A series of settles can't burn more than burn_cap_per_window inside a 10-minute window.
#[test]
fn burn_cap_holds_across_a_series_of_transactions() {
    let mut env = Env::ready();
    assert_ok(set_limit(&mut env, F::BurnCapPerWindow, 30 * C));
    let a = env.funded_user(50 * C);
    let b = env.funded_user(50 * C);
    for i in 1..=3 {
        assert_ok(env.reserve(rid(i), a.key(), 10 * C));
    }
    for i in 4..=6 {
        assert_ok(env.reserve(rid(i), b.key(), 10 * C));
    }
    let t0 = env.now();
    for i in 1..=3 {
        assert_ok(env.settle(rid(i), a.key(), 10 * C));
    }
    assert_eq!(env.config().window_burned, 30 * C);
    assert_eq!(env.config().window_start, t0);
    assert_err(env.settle(rid(4), b.key(), 1), E::BurnCapExceeded);
    // a batch can't get around it: entries that don't fit are skipped and stay live
    assert_ok(env.settle_many(&[(rid(4), b.key(), 10 * C), (rid(5), b.key(), 0)]));
    assert!(env.reservation(&rid(4)).is_some(), "skipped entry stays in the queue");
    assert!(env.reservation(&rid(5)).is_none(), "a release fits any window");
    assert_eq!(env.config().total_burned, 30 * C);

    env.warp(599);
    assert_err(env.settle(rid(4), b.key(), 1), E::BurnCapExceeded);
    env.warp(1);
    assert_ok(env.settle(rid(4), b.key(), 10 * C));
    assert_eq!(env.config().window_start, t0 + 600);
    assert_ok(env.settle(rid(6), b.key(), 10 * C));
    assert_eq!(env.config().total_burned, 50 * C);
    assert_eq!(env.token_balance(&env.treasury), 50 * C);
    env.check_invariants(&[a.key(), b.key()], &[]);
}

/// Brief 6.5: across the boundary of two windows at most 2 × burn_cap_per_window can be burned.
#[test]
fn burn_window_boundary_allows_at_most_twice_the_cap() {
    let mut env = Env::ready();
    let cap = 10 * C;
    assert_ok(set_limit(&mut env, F::BurnCapPerWindow, cap));
    let u = env.funded_user(50 * C);
    for i in 1..=5 {
        assert_ok(env.reserve(rid(i), u.key(), 10 * C));
    }
    let t0 = env.now();
    assert_ok(env.settle(rid(1), u.key(), 1)); // opens the window at t0
    env.warp(599);
    assert_ok(env.settle(rid(2), u.key(), cap - 1)); // window full at its last second
    assert_err(env.settle(rid(3), u.key(), 1), E::BurnCapExceeded);
    env.warp(1); // t0 + 600: new window
    assert_ok(env.settle(rid(3), u.key(), cap));
    assert_err(env.settle(rid(4), u.key(), 1), E::BurnCapExceeded);
    // settle_many skips the entry instead of failing: nothing is burned, the reservation stays
    assert_ok(env.settle_many(&[(rid(4), u.key(), 1)]));
    assert!(env.reservation(&rid(4)).is_some());
    let c = env.config();
    assert_eq!(c.total_burned, 2 * cap, "two seconds around the boundary burned exactly 2 × cap");
    assert_eq!(c.window_start, t0 + 600);
    env.warp(599);
    assert_err(env.settle(rid(4), u.key(), 1), E::BurnCapExceeded);
    env.warp(1);
    assert_ok(env.settle(rid(4), u.key(), cap));
    assert_eq!(env.config().total_burned, 3 * cap);
    env.check_invariants(&[u.key()], &[rid(5)]);
}

/// The gateway can only burn from the vault and pay the configured treasury; no other destination is accepted.
#[test]
fn gateway_cannot_send_funds_anywhere_but_treasury() {
    let mut env = Env::ready();
    let u = env.funded_user(50 * C);
    let g = env.gateway.pubkey();
    let gw_usdc = new_token_account(&mut env, USDC_MINT, g);
    let cm = env.credit_mint;
    let gw_credits = new_token_account(&mut env, cm, g);
    let fake_mint = Pubkey::new_unique();
    env.put_mint(fake_mint, Some(g), None, 6, 0);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    let treasury = env.treasury;

    let settle = |env: &Env| env.ix_settle(&g, rid(1), u.key(), g, 5 * C);
    let mut ix = settle(&env);
    swap_account(&mut ix, treasury, gw_usdc);
    assert_err(gw(&mut env, ix), E::InvalidTreasury);
    let mut ix = settle(&env);
    swap_account(&mut ix, treasury, reserve_pda()); // reserve as treasury
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintDuplicateMutableAccount);
    let mut ix = settle(&env);
    swap_account(&mut ix, vault_pda(), gw_credits);
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintAddress);
    let mut ix = settle(&env);
    swap_account(&mut ix, reserve_pda(), gw_usdc);
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintAddress);
    let mut ix = settle(&env);
    swap_account(&mut ix, env.credit_mint, fake_mint);
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintAddress);
    // rent of the reservation goes only to its payer
    let attacker = Keypair::new().pubkey();
    let mut ix = settle(&env);
    ix.accounts[3].pubkey = attacker; // rent_payer
    assert_err(gw(&mut env, ix), E::WrongPayer);

    let many = |env: &Env| env.ix_settle_many(&g, g, &[(rid(1), u.key(), 5 * C)]);
    let mut ix = many(&env);
    swap_account(&mut ix, treasury, gw_usdc);
    assert_err(gw(&mut env, ix), E::InvalidTreasury);
    let mut ix = many(&env);
    swap_account(&mut ix, vault_pda(), gw_credits);
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintAddress);
    let mut ix = many(&env);
    swap_account(&mut ix, reserve_pda(), gw_usdc);
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintAddress);
    // a foreign rent_payer just skips the entry: nothing moves
    let ix = env.ix_settle_many(&g, attacker, &[(rid(1), u.key(), 5 * C)]);
    assert_ok(gw(&mut env, ix));
    assert!(env.reservation(&rid(1)).is_some());
    assert_eq!(env.lamports(&attacker), 0);

    // the gateway can't withdraw from a user's API balance to itself
    let mut ix = env.ix_withdraw(&g, gw_credits, C, &[]);
    swap_account(&mut ix, user_pda(&g), user_pda(&u.key()));
    assert_anchor_err(gw(&mut env, ix), AE::ConstraintSeeds);

    assert_eq!((env.token_balance(&gw_usdc), env.token_balance(&gw_credits)), (0, 0));
    assert_eq!(env.token_balance(&treasury), 0);
    assert_ok(env.settle(rid(1), u.key(), 5 * C));
    assert_eq!(env.token_balance(&treasury), 5 * C);
    env.check_invariants(&[u.key()], &[]);
}

/// sweep_surplus with live reservations: balances, reserved amounts and backing of wallet credits stay; only the
/// surplus moves.
#[test]
fn sweep_with_live_reservations_moves_only_surplus() {
    let mut env = Env::ready();
    let a = env.funded_user(50 * C);
    let b = env.funded_user(40 * C);
    let w = env.user(20 * C);
    assert_ok(env.buy(&w, 20 * C)); // credits held in a wallet, backed by the reserve
    assert_ok(env.reserve(rid(1), a.key(), 20 * C));
    assert_ok(env.reserve(rid(2), b.key(), 15 * C));
    let live = [rid(1), rid(2)];

    // with no surplus the admin gets nothing
    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), 0);
    assert_eq!(env.credit_supply(), 110 * C);
    assert_eq!(env.token_balance(&vault_pda()), 90 * C);

    // donations: 7 credits straight into the vault, 3 USDC straight into the reserve
    let donor = env.user(10 * C);
    assert_ok(env.buy(&donor, 7 * C));
    assert_ok(spl_transfer(&mut env, donor.credits, vault_pda(), &donor.kp, 7 * C));
    assert_ok(spl_transfer(&mut env, donor.usdc, reserve_pda(), &donor.kp, 3 * C));
    env.check_invariants(&[a.key(), b.key()], &live);

    let ua_before = env.user_account(&a.key()).unwrap();
    let ub_before = env.user_account(&b.key()).unwrap();
    let c_before = env.config();
    assert_ok(sweep(&mut env));
    let c = env.config();
    assert_eq!(env.token_balance(&env.treasury), 10 * C, "7 USDC behind the burned credits + 3 donated");
    assert_eq!((c.total_swept_credits, c.total_swept_usdc), (7 * C, 10 * C));
    assert_eq!(env.token_balance(&vault_pda()), c.total_user_balance);
    assert_eq!(env.token_balance(&reserve_pda()), env.credit_supply());
    assert_eq!(env.credit_supply(), 110 * C);
    let (ua, ub) = (env.user_account(&a.key()).unwrap(), env.user_account(&b.key()).unwrap());
    assert_eq!((ua.balance, ua.reserved), (ua_before.balance, ua_before.reserved));
    assert_eq!((ub.balance, ub.reserved), (ub_before.balance, ub_before.reserved));
    assert_eq!((c.total_user_balance, c.active_reserved), (c_before.total_user_balance, c_before.active_reserved));
    assert_eq!(env.reservation(&rid(1)).unwrap().amount, 20 * C);
    env.check_invariants(&[a.key(), b.key()], &live);

    // the admin can't point the sweep at another account
    let mut ix = env.ix_sweep_surplus(&env.admin.pubkey());
    let admin = env.admin.pubkey();
    let admin_usdc = new_token_account(&mut env, USDC_MINT, admin);
    swap_account(&mut ix, env.treasury, admin_usdc);
    assert_err(env.as_admin(ix), E::InvalidTreasury);
    let mut ix = env.ix_sweep_surplus(&env.admin.pubkey());
    swap_account(&mut ix, reserve_pda(), admin_usdc);
    assert_anchor_err(env.as_admin(ix), AE::ConstraintAddress);
    let cm = env.credit_mint;
    let admin_credits = new_token_account(&mut env, cm, admin);
    let mut ix = env.ix_sweep_surplus(&env.admin.pubkey());
    swap_account(&mut ix, vault_pda(), admin_credits);
    assert_anchor_err(env.as_admin(ix), AE::ConstraintAddress);
    // a second sweep finds nothing
    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), 10 * C);

    // everything still settles, and after shutdown every credit in circulation redeems in full
    assert_ok(env.settle(rid(1), a.key(), 4 * C));
    assert_ok(env.settle(rid(2), b.key(), 0));
    assert_ok(shutdown(&mut env));
    for u in [&a, &b] {
        let bal = env.user_account(&u.key()).unwrap().balance;
        assert_ok(env.withdraw(u, bal));
    }
    for u in [&a, &b, &w] {
        let held = env.token_balance(&u.credits);
        assert_ok(env.redeem(u, held));
    }
    assert_eq!((env.credit_supply(), env.token_balance(&reserve_pda())), (0, 0));
    env.check_invariants(&[a.key(), b.key()], &[]);
}

/// Credits and USDC sent straight to the vault and reserve (SPL transfers and a raw balance bump) keep the
/// invariants, and sweep_surplus removes exactly the surplus.
#[test]
fn direct_transfers_to_vault_and_reserve_are_swept_exactly() {
    let mut env = Env::ready();
    let a = env.funded_user(40 * C);
    let b = env.user(15 * C);
    assert_ok(env.buy(&b, 15 * C));
    assert_ok(env.reserve(rid(1), a.key(), 10 * C));

    assert_ok(spl_transfer(&mut env, b.credits, vault_pda(), &b.kp, 5 * C));
    let donor = env.user(3 * C);
    assert_ok(spl_transfer(&mut env, donor.usdc, reserve_pda(), &donor.kp, 3 * C));
    let r = env.token_balance(&reserve_pda());
    env.put_token_account(reserve_pda(), USDC_MINT, config_pda(), r + 2 * C);
    env.check_invariants(&[a.key()], &[rid(1)]);
    assert_eq!(env.token_balance(&vault_pda()), 45 * C);
    assert_eq!((env.credit_supply(), env.token_balance(&reserve_pda())), (55 * C, 60 * C));

    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), 10 * C, "5 (burned credits) + 3 + 2 donated USDC");
    assert_eq!(env.token_balance(&vault_pda()), 40 * C);
    assert_eq!((env.credit_supply(), env.token_balance(&reserve_pda())), (50 * C, 50 * C));
    let c = env.config();
    assert_eq!((c.total_swept_credits, c.total_swept_usdc, c.total_user_balance, c.active_reserved), (5 * C, 10 * C, 40 * C, 10 * C));
    assert_eq!(env.token_balance(&b.credits), 10 * C);
    env.check_invariants(&[a.key()], &[rid(1)]);
    assert_ok(sweep(&mut env));
    assert_eq!(env.config().total_swept_usdc, 10 * C);
}

/// sweep_surplus refuses to run if the vault or reserve is below what it owes (raw-state corruption), so it can
/// never dig into users' balances or the backing of credits in circulation.
#[test]
fn sweep_refuses_when_insolvent() {
    let mut env = Env::ready();
    let u = env.funded_user(20 * C);
    let w = env.user(5 * C);
    assert_ok(env.buy(&w, 5 * C));
    let cm = env.credit_mint;
    env.put_token_account(vault_pda(), cm, config_pda(), 20 * C - 1);
    assert_err(sweep(&mut env), E::Insolvent);
    env.put_token_account(vault_pda(), cm, config_pda(), 20 * C);
    env.put_token_account(reserve_pda(), USDC_MINT, config_pda(), 25 * C - 1);
    assert_err(sweep(&mut env), E::Insolvent);
    env.put_token_account(reserve_pda(), USDC_MINT, config_pda(), 25 * C);
    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), 0);
    let c = env.config();
    assert_eq!((c.total_swept_credits, c.total_swept_usdc), (0, 0));
    env.check_invariants(&[u.key()], &[]);
}

/// A user burning their own credits creates a USDC surplus, which sweep_surplus moves to the treasury.
#[test]
fn manual_burn_creates_usdc_surplus() {
    let mut env = Env::ready();
    let u = env.user(10 * C);
    assert_ok(env.buy(&u, 10 * C));
    let ix = spl_token::instruction::burn(&spl_token::ID, &u.credits, &env.credit_mint, &u.key(), &[], 4 * C).unwrap();
    assert_ok(env.send(&[ix], &[&u.kp]));
    assert_eq!((env.credit_supply(), env.token_balance(&reserve_pda())), (6 * C, 10 * C));
    env.check_invariants(&[u.key()], &[]);
    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), 4 * C);
    assert_eq!(env.token_balance(&reserve_pda()), 6 * C);
    let c = env.config();
    assert_eq!((c.total_swept_usdc, c.total_swept_credits, c.total_burned, c.total_released), (4 * C, 0, 0, 0));
    env.check_invariants(&[u.key()], &[]);
}

/// Forged or wrong-typed Reservation / UserAccount accounts in settle and expire are rejected.
#[test]
fn fake_reservation_and_user_accounts_rejected() {
    let mut env = Env::ready();
    let a = env.funded_user(50 * C);
    let b = env.funded_user(50 * C);
    let g = env.gateway.pubkey();
    assert_ok(env.reserve(rid(1), a.key(), 5 * C));
    let res = res_pda(&rid(1));
    let fake_program = Pubkey::new_unique();

    // a forged Reservation (right layout, owned by another program) that claims a big amount
    let forged_res = Pubkey::new_unique();
    let fr = Reservation { owner: a.key(), request_id: rid(1), amount: 25 * C, expires_at: 0, payer: g, bump: 255 };
    put_anchor_account(&mut env, forged_res, fake_program, &fr);
    // a forged UserAccount of a with a huge balance
    let forged_user = Pubkey::new_unique();
    let fu = UserAccount { owner: a.key(), balance: 1_000_000 * C, reserved: 1_000_000 * C, reserve_cap: 0, bump: 255 };
    put_anchor_account(&mut env, forged_user, fake_program, &fu);
    // a plain system account
    let sys = funded_kp(&mut env).pubkey();

    let settle = |env: &Env| env.ix_settle(&g, rid(1), a.key(), g, 5 * C);
    let cases: [(&str, Pubkey, Pubkey, AE); 6] = [
        ("forged reservation", res, forged_res, AE::AccountOwnedByWrongProgram),
        ("system account as reservation", res, sys, AE::AccountOwnedByWrongProgram),
        ("missing reservation", res, Pubkey::new_unique(), AE::AccountNotInitialized),
        ("UserAccount as reservation", res, user_pda(&b.key()), AE::AccountDiscriminatorMismatch),
        ("forged user", user_pda(&a.key()), forged_user, AE::AccountOwnedByWrongProgram),
        ("another user's account", user_pda(&a.key()), user_pda(&b.key()), AE::ConstraintSeeds),
    ];
    for (what, from, to, want) in cases {
        let mut ix = settle(&env);
        swap_account(&mut ix, from, to);
        assert_code(gw(&mut env, ix), u32::from(want), what);
    }
    // Config as the reservation
    let mut ix = settle(&env);
    ix.accounts[2].pubkey = config_pda();
    assert_anchor_err(gw(&mut env, ix), AE::AccountDiscriminatorMismatch);

    env.warp(TTL);
    let expire = |env: &Env| env.ix_expire(rid(1), a.key(), g);
    let mut ix = expire(&env);
    swap_account(&mut ix, res, forged_res);
    assert_anchor_err(env.as_anyone(ix), AE::AccountOwnedByWrongProgram);
    let mut ix = expire(&env);
    swap_account(&mut ix, user_pda(&a.key()), user_pda(&b.key()));
    assert_anchor_err(env.as_anyone(ix), AE::ConstraintSeeds);
    let mut ix = expire(&env);
    swap_account(&mut ix, user_pda(&a.key()), forged_user);
    assert_anchor_err(env.as_anyone(ix), AE::AccountOwnedByWrongProgram);

    let (ua, ub) = (env.user_account(&a.key()).unwrap(), env.user_account(&b.key()).unwrap());
    assert_eq!((ua.balance, ua.reserved, ub.balance, ub.reserved), (50 * C, 5 * C, 50 * C, 0));
    env.check_invariants(&[a.key(), b.key()], &[rid(1)]);
    assert_ok(env.expire(rid(1), a.key()));
    env.check_invariants(&[a.key(), b.key()], &[]);
}

/// Forged accounts in remaining accounts of settle_many and withdraw.
#[test]
fn fake_accounts_in_remaining_accounts_rejected() {
    let mut env = Env::ready();
    let a = env.funded_user(50 * C);
    let b = env.funded_user(50 * C);
    let g = env.gateway.pubkey();
    assert_ok(env.reserve(rid(1), a.key(), 5 * C));
    assert_ok(env.reserve(rid(2), b.key(), 5 * C));
    let (res1, ua, ub) = (res_pda(&rid(1)), user_pda(&a.key()), user_pda(&b.key()));
    let fake_program = Pubkey::new_unique();
    let forged_res = Pubkey::new_unique();
    put_anchor_account(
        &mut env,
        forged_res,
        fake_program,
        &Reservation { owner: a.key(), request_id: rid(9), amount: 5 * C, expires_at: 0, payer: g, bump: 255 },
    );
    let forged_user = Pubkey::new_unique();
    put_anchor_account(
        &mut env,
        forged_user,
        fake_program,
        &UserAccount { owner: a.key(), balance: 1_000 * C, reserved: 5 * C, reserve_cap: 0, bump: 255 },
    );
    let sys_with_data = Pubkey::new_unique();
    env.svm
        .set_account(sys_with_data, Account { lamports: 10_000_000, data: vec![1; 140], owner: system_program::ID, executable: false, rent_epoch: 0 })
        .unwrap();

    type Case<'a> = (&'a str, Vec<(Pubkey, bool)>, Vec<u64>, u32);
    let cases: Vec<Case> = vec![
        ("forged reservation", vec![(forged_res, true), (ua, true)], vec![C], code(E::InvalidReservation)),
        ("UserAccount as reservation", vec![(ua, true), (ua, true)], vec![C], code(E::InvalidReservation)),
        ("Config as reservation", vec![(config_pda(), true), (ua, true)], vec![0], code(E::InvalidReservation)),
        ("system account with data", vec![(sys_with_data, true), (ua, true)], vec![0], code(E::InvalidReservation)),
        ("vault as reservation", vec![(vault_pda(), true), (ua, true)], vec![0], code(E::InvalidReservation)),
        ("another user's account", vec![(res1, true), (ub, true)], vec![C], code(E::InvalidUserAccount)),
        ("forged user", vec![(res1, true), (forged_user, true)], vec![C], code(E::InvalidUserAccount)),
        ("Config as user", vec![(res1, true), (config_pda(), true)], vec![C], code(E::InvalidUserAccount)),
        ("read-only pair", vec![(res1, false), (ua, true)], vec![C], code(E::InvalidRemainingAccounts)),
        ("read-only user", vec![(res1, true), (ua, false)], vec![C], code(E::InvalidRemainingAccounts)),
        ("duplicate", vec![(res1, true), (ua, true), (res1, true), (ua, true)], vec![C, C], code(E::DuplicateReservation)),
        ("odd accounts", vec![(res1, true), (ua, true), (res1, true)], vec![C], code(E::InvalidRemainingAccounts)),
        ("length mismatch", vec![(res1, true), (ua, true)], vec![C, C], code(E::BatchLengthMismatch)),
    ];
    for (what, rem, actuals, want) in cases {
        let ix = ix_settle_many_raw(&env, &rem, actuals);
        assert_code(gw(&mut env, ix), want, what);
    }
    // an empty system account counts as an already closed reservation: skipped, nothing moves
    let empty = funded_kp(&mut env).pubkey();
    let ix = ix_settle_many_raw(&env, &[(empty, true), (ua, true)], vec![C]);
    assert_ok(gw(&mut env, ix));
    assert_eq!(env.credit_supply(), 100 * C);

    // withdraw: forged, foreign, live and wrong-payer reservations
    let wd = |env: &Env, u: &User, pairs: &[(Pubkey, Pubkey)]| {
        let mut ix = env.ix_withdraw(&u.key(), u.credits, C, &[]);
        for (r, p) in pairs {
            ix.accounts.push(AccountMeta::new(*r, false));
            ix.accounts.push(AccountMeta::new(*p, false));
        }
        ix
    };
    let ix = wd(&env, &a, &[(forged_res, g)]);
    assert_err(send_as(&mut env, ix, &a.kp), E::InvalidReservation);
    let ix = wd(&env, &a, &[(ua, g)]);
    assert_err(send_as(&mut env, ix, &a.kp), E::InvalidReservation);
    let ix = wd(&env, &a, &[(res1, g)]);
    assert_err(send_as(&mut env, ix, &a.kp), E::NotExpired);
    env.warp(TTL);
    let ix = wd(&env, &b, &[(res1, g)]);
    assert_err(send_as(&mut env, ix, &b.kp), E::WrongOwner);
    let attacker = Keypair::new().pubkey();
    let ix = wd(&env, &a, &[(res1, attacker)]);
    assert_err(send_as(&mut env, ix, &a.kp), E::WrongPayer);
    let ix = wd(&env, &a, &[(res1, g), (res1, g)]);
    assert_err(send_as(&mut env, ix, &a.kp), E::InvalidReservation); // listed twice: closed after the first
    let mut ix = wd(&env, &a, &[(res1, g)]);
    ix.accounts.pop();
    assert_err(send_as(&mut env, ix, &a.kp), E::InvalidRemainingAccounts);

    env.check_invariants(&[a.key(), b.key()], &[rid(1), rid(2)]);
    let ix = wd(&env, &a, &[(res1, g)]);
    assert_ok(send_as(&mut env, ix, &a.kp));
    assert!(env.reservation(&rid(1)).is_none());
    env.check_invariants(&[a.key(), b.key()], &[rid(2)]);
}

/// Token accounts of someone else can't be used as source or recipient of buy, deposit, withdraw or redeem.
#[test]
fn foreign_token_accounts_rejected() {
    let mut env = Env::ready();
    let a = env.funded_user(10 * C);
    let v = env.user(20 * C); // victim
    assert_ok(env.buy(&v, 10 * C));
    assert_ok(env.deposit(&v, 5 * C));
    env.mint_usdc(&a.usdc, 10 * C);
    // a's own second accounts of each mint (same account twice would trip the duplicate-mutable check first)
    let a_usdc2 = new_token_account(&mut env, USDC_MINT, a.key());
    let cm = env.credit_mint;
    let a_credits2 = new_token_account(&mut env, cm, a.key());
    let owner_err = u32::from(AE::ConstraintTokenOwner);
    let mint_err = u32::from(AE::ConstraintTokenMint);

    let cases: Vec<(&str, Instruction, u32)> = vec![
        ("buy: credits to a foreign account", env.ix_buy(&a.key(), a.usdc, v.credits, C), owner_err),
        ("buy: pay with a foreign USDC account", env.ix_buy(&a.key(), v.usdc, a.credits, C), owner_err),
        ("buy: credits to a USDC account", env.ix_buy(&a.key(), a.usdc, a_usdc2, C), mint_err),
        ("buy: pay with a credit account", env.ix_buy(&a.key(), a_credits2, a.credits, C), mint_err),
        ("deposit from a foreign account", env.ix_deposit(&a.key(), v.credits, C), owner_err),
        ("withdraw to a foreign account", env.ix_withdraw(&a.key(), v.credits, C, &[]), owner_err),
        ("withdraw to a USDC account", env.ix_withdraw(&a.key(), a.usdc, C, &[]), mint_err),
    ];
    for (what, ix, want) in cases {
        assert_code(send_as(&mut env, ix, &a.kp), want, what);
    }
    // even as an approved delegate of the victim's account
    let ix = spl_token::instruction::approve(&spl_token::ID, &v.credits, &a.key(), &v.key(), &[], 5 * C).unwrap();
    assert_ok(env.send(&[ix], &[&v.kp]));
    let ix = env.ix_deposit(&a.key(), v.credits, C);
    assert_code(send_as(&mut env, ix, &a.kp), owner_err, "deposit as delegate");
    // another user's API balance
    let mut ix = env.ix_withdraw(&a.key(), a.credits, C, &[]);
    swap_account(&mut ix, user_pda(&a.key()), user_pda(&v.key()));
    assert_anchor_err(send_as(&mut env, ix, &a.kp), AE::ConstraintSeeds);

    assert_ok(shutdown(&mut env));
    assert_ok(env.withdraw(&a, 10 * C));
    let cases: Vec<(&str, Instruction, u32)> = vec![
        ("redeem: USDC to a foreign account", env.ix_redeem(&a.key(), a.credits, v.usdc, C), owner_err),
        ("redeem: burn a foreign account (delegate)", env.ix_redeem(&a.key(), v.credits, a.usdc, C), owner_err),
        ("redeem: USDC to a credit account", env.ix_redeem(&a.key(), a.credits, a_credits2, C), mint_err),
    ];
    for (what, ix, want) in cases {
        assert_code(send_as(&mut env, ix, &a.kp), want, what);
    }
    assert_eq!((env.token_balance(&v.credits), env.token_balance(&v.usdc)), (5 * C, 10 * C));
    assert_eq!(env.user_account(&v.key()).unwrap().balance, 5 * C);
    assert_ok(env.redeem(&a, 10 * C));
    env.check_invariants(&[a.key(), v.key()], &[]);
}

#[test]
fn overflow_attempts_fail_cleanly() {
    let mut env = Env::ready();
    let u = env.funded_user(100 * C);
    let b = env.user(10 * C);
    assert_err(env.buy(&b, u64::MAX), E::AmountTooLarge);
    assert_code(env.deposit(&u, u64::MAX), TOKEN_INSUFFICIENT_FUNDS, "deposit u64::MAX");
    assert_err(env.withdraw(&u, u64::MAX), E::InsufficientAvailable);
    assert_err(env.reserve(rid(1), u.key(), u64::MAX), E::ReservationTooLarge);
    assert_ok(env.reserve(rid(1), u.key(), 5 * C));
    assert_err(env.settle(rid(1), u.key(), u64::MAX), E::ActualExceedsReserved);
    assert_err(env.settle_many(&[(rid(1), u.key(), u64::MAX)]), E::ActualExceedsReserved);
    for f in LIMITS {
        assert_err(set_limit(&mut env, f, u64::MAX), E::OutOfBounds);
    }
    // a user cap of u64::MAX falls back to the global hold limit
    let ix = env.ix_set_my_reserve_cap(&u.key(), u64::MAX);
    assert_ok(send_as(&mut env, ix, &u.kp));
    assert_ok(env.reserve(rid(2), u.key(), 25 * C));
    assert_ok(env.reserve(rid(3), u.key(), 20 * C));
    assert_err(env.reserve(rid(4), u.key(), 1), E::UserHoldLimitExceeded);
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (100 * C, 50 * C));
    env.check_invariants(&[u.key()], &[rid(1), rid(2), rid(3)]);

    assert_ok(shutdown(&mut env));
    assert_ok(env.withdraw(&u, 50 * C));
    assert_code(env.redeem(&u, u64::MAX), TOKEN_INSUFFICIENT_FUNDS, "redeem u64::MAX");
    assert_err(env.redeem(&u, 0), E::ZeroAmount);
    assert_ok(env.redeem(&u, 50 * C));
    assert_eq!(env.config().total_redeemed, 50 * C);
    env.check_invariants(&[u.key()], &[rid(1), rid(2), rid(3)]);
}

// ================================================================ D. USDC freeze (brief 4.1 item 2)

/// With the reserve frozen by the USDC issuer: buy and settle with actual > 0 fail; releases, withdraw, deposit,
/// reserve and expire keep working; after a thaw everything works again.
#[test]
fn frozen_reserve_blocks_usdc_outflows_only() {
    let mut env = Env::ready();
    let a = env.funded_user(50 * C);
    let buyer = env.user(10 * C);
    for i in 1..=4 {
        assert_ok(env.reserve(rid(i), a.key(), 5 * C));
    }
    let r = env.token_balance(&reserve_pda());
    env.put_token_account(reserve_pda(), USDC_MINT, config_pda(), r + C); // 1 USDC surplus
    env.set_frozen(reserve_pda(), true);

    assert_code(env.buy(&buyer, C), TOKEN_FROZEN, "buy");
    assert_code(env.settle(rid(1), a.key(), 2 * C), TOKEN_FROZEN, "settle actual > 0");
    assert_code(env.settle_many(&[(rid(1), a.key(), C), (rid(2), a.key(), 0)]), TOKEN_FROZEN, "settle_many total > 0");
    assert_code(sweep(&mut env), TOKEN_FROZEN, "sweep");
    assert_ok(env.settle(rid(2), a.key(), 0));
    assert_ok(env.settle_many(&[(rid(3), a.key(), 0)]));
    assert_ok(env.withdraw(&a, 10 * C));
    assert_ok(env.deposit(&a, 2 * C));
    assert_ok(env.reserve(rid(5), a.key(), C));
    let ua = env.user_account(&a.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (42 * C, 11 * C));
    assert_eq!(env.config().total_burned, 0);
    env.check_invariants(&[a.key()], &[rid(1), rid(4), rid(5)]);

    env.set_frozen(reserve_pda(), false);
    assert_ok(env.buy(&buyer, C));
    assert_ok(env.settle(rid(1), a.key(), 2 * C));
    assert_ok(env.settle_many(&[(rid(4), a.key(), C), (rid(5), a.key(), C)]));
    assert_ok(sweep(&mut env));
    assert_eq!(env.token_balance(&env.treasury), 4 * C + C);
    assert_eq!(env.token_balance(&reserve_pda()), env.credit_supply());
    env.check_invariants(&[a.key(), buyer.key()], &[]);
}

#[test]
fn frozen_reserve_blocks_redeem_until_thaw() {
    let mut env = Env::ready();
    let a = env.funded_user(20 * C);
    let w = env.user(10 * C);
    assert_ok(env.buy(&w, 10 * C));
    assert_ok(env.reserve(rid(1), a.key(), 5 * C));
    env.set_frozen(reserve_pda(), true);
    assert_ok(shutdown(&mut env));
    assert_code(env.redeem(&w, C), TOKEN_FROZEN, "redeem");
    assert_code(env.settle(rid(1), a.key(), C), TOKEN_FROZEN, "settle after shutdown");
    assert_ok(env.settle(rid(1), a.key(), 0));
    assert_ok(env.withdraw(&a, 20 * C));
    assert_eq!(env.token_balance(&w.credits), 10 * C);
    env.check_invariants(&[a.key()], &[]);

    env.set_frozen(reserve_pda(), false);
    assert_ok(env.redeem(&w, 10 * C));
    assert_ok(env.redeem(&a, 20 * C));
    assert_eq!((env.credit_supply(), env.token_balance(&reserve_pda())), (0, 0));
    assert_eq!(env.token_balance(&w.usdc), 10 * C);
    env.check_invariants(&[a.key()], &[]);
}

/// A frozen treasury blocks settle with actual > 0; releases and withdraw work; thaw or a new treasury fixes it.
#[test]
fn frozen_treasury_blocks_settle_with_actual() {
    let mut env = Env::ready();
    let a = env.funded_user(50 * C);
    let buyer = env.user(10 * C);
    for i in 1..=4 {
        assert_ok(env.reserve(rid(i), a.key(), 5 * C));
    }
    let old = env.treasury;
    env.set_frozen(old, true);
    assert_code(env.settle(rid(1), a.key(), 2 * C), TOKEN_FROZEN, "settle");
    assert_code(env.settle_many(&[(rid(1), a.key(), C)]), TOKEN_FROZEN, "settle_many");
    assert_ok(env.settle(rid(1), a.key(), 0));
    assert_ok(env.settle_many(&[(rid(2), a.key(), 0)]));
    assert_ok(env.withdraw(&a, 10 * C));
    assert_ok(env.buy(&buyer, C));
    assert_eq!(env.config().total_burned, 0);
    env.check_invariants(&[a.key()], &[rid(3), rid(4)]);

    env.set_frozen(old, false);
    assert_ok(env.settle(rid(3), a.key(), 2 * C));
    assert_eq!(env.token_balance(&old), 2 * C);

    // frozen again: the admin moves to a new treasury through the delay; held amounts expire meanwhile
    env.set_frozen(old, true);
    let t2 = new_token_account(&mut env, USDC_MINT, Keypair::new().pubkey());
    assert_ok(propose_treasury(&mut env, t2));
    env.warp(TTL);
    assert_ok(env.expire(rid(4), a.key()));
    env.warp(DELAY - TTL);
    assert_ok(apply(&mut env, F::Treasury));
    assert_ok(env.reserve(rid(5), a.key(), 5 * C));
    assert_ok(env.settle(rid(5), a.key(), 3 * C));
    assert_eq!((env.token_balance(&old), env.token_balance(&t2)), (2 * C, 3 * C));
    env.check_invariants(&[a.key()], &[]);
}
