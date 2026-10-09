//! Property-based invariant fuzzing of the unspent program (UNSPENT_BRIEF.md 5.9 and the last bullet of 13).
//!
//! proptest generates sequences of 30–80 actions over four users: buys, deposits, withdrawals (with expired, live,
//! foreign and closed reservations in remaining accounts), personal reserve caps, gateway reserves of any size
//! (fresh and reused request ids), settles with actual ≤ and > amount, settle_many batches (closed entries, duplicate
//! entries, a foreign UserAccount, several entries of one user), expiries, clock warps across the burn window, the
//! reservation TTL and the admin delay, wallet self-burns, credits and USDC sent straight into the vault and the
//! reserve, admin limit changes (lowering applies at once, raising waits for apply_pending), cancel_pending, pauses,
//! sweep_surplus, shutdown and redeem. Half of the cases start from tight random launch limits.
//!
//! Failing transactions are part of the game. A shadow model predicts every outcome: a transaction must succeed iff
//! the model sees no violated precondition, and a failure must carry the error code of a violated precondition. The
//! model changes only when a transaction succeeds. After every step the chain must satisfy the brief's invariants
//! (`Env::check_invariants` plus the conservation laws in `World::check`) and match the model field by field.
//! Every case ends with shutdown → every user withdraws everything → every credit held is redeemed → sweep, which
//! must leave the reserve, the vault and the credit supply at exactly zero.
//!
//! Knobs: `PROPTEST_CASES` (default 64), `PROPTEST_RNG_SEED` for a reproducible run. Failing inputs are persisted in
//! `tests/invariants.proptest-regressions` and replayed first on the next run.

mod common;
use common::*;

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    panic::{catch_unwind, AssertUnwindSafe},
};

use anchor_lang::prelude::Pubkey;
use anchor_spl::token::spl_token;
use proptest::{
    collection::vec as pvec,
    prelude::*,
    strategy::ValueTree,
    test_runner::{FileFailurePersistence, RngAlgorithm, TestRng, TestRunner},
};
use solana_signer::Signer;
use unspent::{constants::*, error::UnspentError as E, ConfigField, PauseTarget};

type F = ConfigField;

const N_USERS: usize = 4;

/// The limit fields in `ConfigField::index()` order.
const LIMITS: [ConfigField; 7] = [
    F::MaxBuyPerIx,
    F::SupplyCap,
    F::MaxReservation,
    F::MaxReservedPerUser,
    F::BurnCapPerWindow,
    F::ReservationTtl,
    F::AdminDelay,
];

/// Bounds of `set_limit` as written in the brief (6.3), independent of the program's constants.
fn brief_bounds(f: ConfigField) -> (u64, u64) {
    match f {
        F::MaxBuyPerIx => (0, 1_000_000 * C),
        F::SupplyCap => (0, 100_000_000 * C),
        F::MaxReservation => (0, 1_000 * C),
        F::MaxReservedPerUser => (0, 10_000 * C),
        F::BurnCapPerWindow => (0, 200_000 * C),
        F::ReservationTtl => (30 * 60, 24 * 3_600),
        F::AdminDelay => (24 * 3_600, 14 * 24 * 3_600),
        _ => unreachable!("not a limit"),
    }
}

// ------------------------------------------------------------------ expected errors

/// System program SystemError::AccountAlreadyInUse: `init` of a Reservation PDA that is still alive.
const ALREADY_IN_USE: u32 = 0;
/// anchor ErrorCode::AccountNotInitialized: a missing UserAccount or Reservation (checked in `error_codes`).
const NOT_INITIALIZED: u32 = 3012;
/// spl_token TokenError::InsufficientFunds (checked in `error_codes`).
const TOKEN_FUNDS: u32 = 1;

fn e(x: E) -> u32 {
    code(x)
}

const ALL_ERRORS: [E; 33] = [
    E::NotUpgradeAuthority,
    E::InvalidMint,
    E::InvalidTreasury,
    E::ShutDown,
    E::NotShutDown,
    E::BuyPaused,
    E::DepositPaused,
    E::GatewayPaused,
    E::ZeroAmount,
    E::AmountTooSmall,
    E::AmountTooLarge,
    E::SupplyCapExceeded,
    E::InsufficientAvailable,
    E::ReservationTooLarge,
    E::UserHoldLimitExceeded,
    E::NotGateway,
    E::ActualExceedsReserved,
    E::BurnCapExceeded,
    E::NotExpired,
    E::InvalidReservation,
    E::InvalidUserAccount,
    E::WrongOwner,
    E::WrongPayer,
    E::DuplicateReservation,
    E::InvalidRemainingAccounts,
    E::BatchLengthMismatch,
    E::OutOfBounds,
    E::NotALimit,
    E::NoPendingChange,
    E::PendingNotReady,
    E::NoBackupGateway,
    E::Insolvent,
    E::MathOverflow,
];

fn err_name(c: u32) -> String {
    match c {
        NOT_INITIALIZED => "AccountNotInitialized".into(),
        ALREADY_IN_USE => "SystemAccountAlreadyInUse".into(),
        TOKEN_FUNDS => "TokenInsufficientFunds".into(),
        _ => ALL_ERRORS.iter().find(|x| code(**x) == c).map_or_else(|| format!("code {c}"), |x| format!("{x:?}")),
    }
}

#[test]
fn error_codes() {
    assert_eq!(NOT_INITIALIZED, u32::from(anchor_lang::error::ErrorCode::AccountNotInitialized));
    assert_eq!(TOKEN_FUNDS, spl_token::error::TokenError::InsufficientFunds as u32);
    for (i, f) in LIMITS.iter().enumerate() {
        assert_eq!(f.index(), i);
        assert_eq!(f.bounds().unwrap(), brief_bounds(*f), "{f:?}");
    }
}

// ------------------------------------------------------------------ actions

/// An amount, resolved against the action's pivots at run time so that boundaries are hit exactly.
#[derive(Clone, Copy, Debug)]
enum Amt {
    Abs(u64),
    /// Per mille of the first pivot (the action's natural maximum).
    Frac(u16),
    /// A pivot ± a few μcr.
    Edge(u8, i8),
}

impl Amt {
    fn of(self, pivots: &[u64]) -> u64 {
        match self {
            Amt::Abs(v) => v,
            Amt::Frac(p) => (u128::from(pivots[0]) * u128::from(p) / 1000) as u64,
            Amt::Edge(i, d) => {
                let p = i128::from(pivots[usize::from(i) % pivots.len()]);
                (p + i128::from(d)).clamp(0, i128::from(u64::MAX)) as u64
            }
        }
    }
}

/// A new limit value: a fraction of the current one (mostly lowering), or the brief's bounds ± a little.
#[derive(Clone, Copy, Debug)]
enum Lim {
    Frac(u16),
    Lo(i32),
    Hi(i32),
}

impl Lim {
    fn of(self, cur: u64, lo: u64, hi: u64) -> u64 {
        match self {
            Lim::Frac(p) => (u128::from(cur) * u128::from(p) / 1000) as u64,
            Lim::Lo(d) => (i128::from(lo) + i128::from(d)).max(0) as u64,
            Lim::Hi(d) => (i128::from(hi) + i128::from(d)).max(0) as u64,
        }
    }
}

/// A reservation: one of the live ones, or any request id ever reserved (possibly closed).
#[derive(Clone, Copy, Debug)]
enum Sel {
    Live(usize),
    Ever(usize),
    /// The live reservation that expires first.
    Due,
}

/// A (Reservation, rent payer) pair passed to withdraw.
#[derive(Clone, Copy, Debug)]
enum Pass {
    /// One of the user's own live reservations (expired or not), with the right payer.
    Own(usize),
    /// One of the user's own expired reservations if there is one, with the right payer.
    OwnExpired(usize),
    /// Any request id ever reserved: someone else's, closed, or the user's own.
    Ever(usize),
    /// One of the user's own (preferably expired) reservations, with the user as the claimed rent payer.
    OwnWrongPayer(usize),
}

/// A point in time to warp to exactly (± a second): where expire, the burn window and apply_pending flip.
#[derive(Clone, Copy, Debug)]
enum Mark {
    Expiry(Sel),
    WindowEnd,
    PendingAt(usize),
}

#[derive(Clone, Debug)]
enum Action {
    Buy(usize, Amt),
    Deposit(usize, Amt),
    Withdraw(usize, Amt, Vec<Pass>),
    SetCap(usize, Amt),
    /// Some(i): reuse a request id ever reserved (live → refused, closed → may be created again).
    Reserve(usize, Amt, Option<usize>),
    Settle(Sel, Amt),
    /// Entries: (reservation, actual, Some(user) = pass that user's account instead of the owner's).
    SettleMany(Vec<(Sel, Amt, Option<usize>)>),
    Expire(Sel),
    Warp(i64),
    WarpTo(Mark, i8),
    SelfBurn(usize, Amt),
    UsdcToReserve(usize, Amt),
    CreditsToVault(usize, Amt),
    SetLimit(ConfigField, Lim),
    /// A limit field: mostly one with a pending change, if any.
    ApplyPending(usize),
    CancelPending(usize),
    Pause(PauseTarget, bool),
    Sweep,
    Shutdown,
    Redeem(usize, Amt),
}

/// Launch parameters and the users' starting USDC.
#[derive(Clone, Debug)]
struct Setup {
    /// None: default launch params. Some: [max_buy_per_ix, supply_cap, max_reservation, max_reserved_per_user,
    /// burn_cap_per_window, reservation_ttl].
    tight: Option<[u64; 6]>,
    /// Per user: (USDC, share of it bought ‰, share of the credits deposited ‰).
    users: Vec<(u64, u16, u16)>,
}

impl Setup {
    fn prefund(&self) -> Vec<Action> {
        let mut out = vec![];
        for (i, &(_, buy, dep)) in self.users.iter().enumerate() {
            out.push(Action::Buy(i, Amt::Frac(buy)));
            out.push(Action::Deposit(i, Amt::Frac(dep)));
        }
        out
    }
}

// ------------------------------------------------------------------ shadow model

#[derive(Clone, Debug, Default)]
struct MUser {
    exists: bool,
    balance: u64,
    reserved: u64,
    cap: u64,
    wallet: u64,
    usdc: u64,
}

#[derive(Clone, Copy, Debug)]
struct MRes {
    owner: usize,
    amount: u64,
    expires_at: i64,
}

#[derive(Clone, Debug, Default)]
struct Model {
    now: i64,
    users: Vec<MUser>,
    live: BTreeMap<u64, MRes>,
    /// Every request id ever reserved, in order of first creation.
    ever: Vec<u64>,
    next_id: u64,
    limits: [u64; 7],
    /// Per limit field: (value, effective_at); (0, 0) = nothing pending.
    pending: [(u64, i64); 7],
    buy_paused: bool,
    deposit_paused: bool,
    gateway_paused: bool,
    shut_down: bool,
    window_start: i64,
    window_burned: u64,
    tub: u64,
    active: u64,
    burned: u64,
    released: u64,
    redeemed: u64,
    swept_usdc: u64,
    swept_credits: u64,
    reserve: u64,
    vault: u64,
    supply: u64,
    treasury: u64,
    /// USDC sent straight into the reserve, credits sent straight into the vault, credits burned from wallets.
    donated_usdc: u64,
    donated_credits: u64,
    self_burned: u64,
}

impl Model {
    fn lim(&self, f: ConfigField) -> u64 {
        self.limits[f.index()]
    }

    /// min(max_reserved_per_user, reserve_cap or ∞) (brief 6.3 reserve).
    fn hold_limit(&self, u: usize) -> u64 {
        let max = self.lim(F::MaxReservedPerUser);
        match self.users[u].cap {
            0 => max,
            cap => cap.min(max),
        }
    }

    /// The 10-minute burn window (brief 6.5): a window that has run out restarts at `now`. A release (0) always
    /// passes and leaves the window untouched (see `zero_release_blocked_by_lowered_burn_cap`).
    fn try_burn(&mut self, amount: u64) -> bool {
        if amount == 0 {
            return true;
        }
        if self.now >= self.window_start + BURN_WINDOW_SECS {
            self.window_start = self.now;
            self.window_burned = 0;
        }
        let next = self.window_burned + amount;
        if next > self.lim(F::BurnCapPerWindow) {
            return false;
        }
        self.window_burned = next;
        true
    }

    fn burn_fits(&self, amount: u64) -> bool {
        if amount == 0 {
            return true;
        }
        let burned = if self.now >= self.window_start + BURN_WINDOW_SECS { 0 } else { self.window_burned };
        burned + amount <= self.lim(F::BurnCapPerWindow)
    }

    /// The 6.3 counter table row of settle(actual ≤ amount).
    fn settle(&mut self, id: u64, actual: u64) {
        let r = self.live.remove(&id).expect("live reservation");
        let u = &mut self.users[r.owner];
        u.reserved -= r.amount;
        u.balance -= actual;
        self.tub -= actual;
        self.active -= r.amount;
        self.burned += actual;
        self.released += actual;
        self.vault -= actual;
        self.supply -= actual;
        self.reserve -= actual;
        self.treasury += actual;
    }

    /// The 6.3 counter table row of expire.
    fn release(&mut self, id: u64) {
        let r = self.live.remove(&id).expect("live reservation");
        self.users[r.owner].reserved -= r.amount;
        self.active -= r.amount;
    }

    fn own_live(&self, u: usize) -> Vec<u64> {
        self.live.iter().filter(|(_, r)| r.owner == u).map(|(&id, _)| id).collect()
    }

    fn pick(&self, s: Sel) -> Option<u64> {
        match s {
            Sel::Live(i) if !self.live.is_empty() => self.live.keys().nth(i % self.live.len()).copied(),
            Sel::Live(i) | Sel::Ever(i) => (!self.ever.is_empty()).then(|| self.ever[i % self.ever.len()]),
            Sel::Due => self.live.iter().min_by_key(|(id, r)| (r.expires_at, **id)).map(|(&id, _)| id),
        }
    }
}

// ------------------------------------------------------------------ world: chain + model

struct World {
    env: Env,
    users: Vec<User>,
    keys: Vec<Pubkey>,
    gw: Pubkey,
    m: Model,
    /// The step being run, with resolved parameters, for failure messages.
    at: String,
    /// The kind of the step being run ("Buy", "SettleMany", "Final", ...), for outcome statistics.
    kind: String,
    /// Outcome counts: "<kind>: ok", "<kind>: <error>", and "event: <path>" for notable successful paths.
    stats: RefCell<BTreeMap<String, u32>>,
}

impl World {
    fn new(s: &Setup) -> Self {
        let mut env = Env::new();
        let mut p = default_params(env.admin.pubkey(), Some(env.gateway.pubkey()));
        if let Some([max_buy, cap, max_res, per_user, burn, ttl]) = s.tight {
            p.max_buy_per_ix = max_buy;
            p.supply_cap = cap;
            p.max_reservation = max_res;
            p.max_reserved_per_user = per_user;
            p.burn_cap_per_window = burn;
            p.reservation_ttl = ttl;
        }
        assert_ok(env.initialize(p));
        let users: Vec<User> = s.users.iter().map(|&(usdc, _, _)| env.user(usdc)).collect();
        let keys = users.iter().map(User::key).collect();
        let c = env.config();
        let m = Model {
            now: env.now(),
            users: s.users.iter().map(|&(usdc, _, _)| MUser { usdc, ..MUser::default() }).collect(),
            limits: LIMITS.map(|f| c.limit(f).unwrap()),
            window_start: c.window_start,
            window_burned: c.window_burned,
            ..Model::default()
        };
        let gw = env.gateway.pubkey();
        let w = World { env, users, keys, gw, m, at: "setup".into(), kind: "setup".into(), stats: RefCell::default() };
        w.check();
        w
    }

    fn note(&mut self, s: String) {
        self.at.push_str(" → ");
        self.at.push_str(&s);
    }

    /// A transaction must succeed iff the model found no violation; a failure must carry one of the violations.
    #[track_caller]
    fn judge(&self, res: TxResult, v: &[u32]) -> bool {
        let got = custom_code(&res);
        let outcome = match (&res, got) {
            (Ok(_), _) => "ok".to_string(),
            (Err(_), Some(c)) => err_name(c),
            (Err(f), None) => format!("{:?}", f.err),
        };
        self.count(format!("{}: {outcome}", self.kind));
        match res {
            Ok(_) if v.is_empty() => true,
            Ok(_) => panic!("{}: transaction succeeded, the model expected a failure with one of {v:?}", self.at),
            Err(f) => {
                assert!(
                    !v.is_empty(),
                    "{}: transaction failed with {:?}, the model expected success\nlogs: {:#?}",
                    self.at,
                    f.err,
                    f.meta.logs
                );
                assert!(
                    got.is_some_and(|c| v.contains(&c)),
                    "{}: transaction failed with {:?}, the model expected one of {v:?}\nlogs: {:#?}",
                    self.at,
                    f.err,
                    f.meta.logs
                );
                false
            }
        }
    }

    fn pending_field(&self, i: usize) -> ConfigField {
        let pending: Vec<ConfigField> = LIMITS.into_iter().filter(|f| self.m.pending[f.index()].1 != 0).collect();
        if !pending.is_empty() && i % 4 != 0 {
            pending[i % pending.len()]
        } else {
            LIMITS[i % LIMITS.len()]
        }
    }

    fn count(&self, key: String) {
        *self.stats.borrow_mut().entry(key).or_default() += 1;
    }

    fn hit(&self, event: &str) {
        self.count(format!("event: {event}"));
    }

    fn step(&mut self, n: usize, a: &Action) {
        self.at = format!("step {n}: {a:?}");
        self.kind = self.at[self.at.find(": ").unwrap() + 2..].split(['(', ' ']).next().unwrap().to_string();
        match a {
            Action::Buy(u, amt) => self.buy(*u, *amt),
            Action::Deposit(u, amt) => self.deposit(*u, *amt),
            Action::Withdraw(u, amt, passes) => {
                let own = self.m.own_live(*u);
                let expired: Vec<u64> =
                    own.iter().copied().filter(|id| self.m.live[id].expires_at <= self.m.now).collect();
                let own_expired = if expired.is_empty() { &own } else { &expired };
                let mut pairs = vec![];
                for p in passes {
                    match *p {
                        Pass::Own(i) if !own.is_empty() => pairs.push((own[i % own.len()], self.gw)),
                        Pass::OwnExpired(i) if !own.is_empty() => {
                            pairs.push((own_expired[i % own_expired.len()], self.gw))
                        }
                        Pass::OwnWrongPayer(i) if !own.is_empty() => {
                            pairs.push((own_expired[i % own_expired.len()], self.keys[*u]))
                        }
                        Pass::Ever(i) if !self.m.ever.is_empty() => {
                            pairs.push((self.m.ever[i % self.m.ever.len()], self.gw))
                        }
                        _ => {}
                    }
                }
                self.withdraw(*u, *amt, pairs);
            }
            Action::SetCap(u, amt) => self.set_cap(*u, *amt),
            Action::Reserve(u, amt, reuse) => self.reserve(*u, *amt, *reuse),
            Action::Settle(sel, amt) => self.settle(*sel, *amt),
            Action::SettleMany(entries) => self.settle_many(entries),
            Action::Expire(sel) => {
                if let Some(id) = self.m.pick(*sel) {
                    self.expire(id);
                }
            }
            Action::Warp(secs) => self.warp(*secs),
            Action::WarpTo(mark, d) => {
                let t = match *mark {
                    Mark::Expiry(sel) => self.m.pick(sel).and_then(|id| self.m.live.get(&id)).map(|r| r.expires_at),
                    Mark::WindowEnd => Some(self.m.window_start + BURN_WINDOW_SECS),
                    Mark::PendingAt(i) => {
                        let at: Vec<i64> = self.m.pending.iter().map(|p| p.1).filter(|&t| t != 0).collect();
                        (!at.is_empty()).then(|| at[i % at.len()])
                    }
                };
                if let Some(t) = t.map(|t| t + i64::from(*d)).filter(|&t| t > self.m.now) {
                    self.note(format!("warp to {t}"));
                    self.warp(t - self.m.now);
                }
            }
            Action::SelfBurn(u, amt) => self.self_burn(*u, *amt),
            Action::UsdcToReserve(u, amt) => self.usdc_to_reserve(*u, *amt),
            Action::CreditsToVault(u, amt) => self.credits_to_vault(*u, *amt),
            Action::SetLimit(f, lim) => self.set_limit(*f, *lim),
            Action::ApplyPending(i) => {
                let f = self.pending_field(*i);
                self.note(format!("{f:?}"));
                self.apply_pending(f)
            }
            Action::CancelPending(i) => {
                let f = self.pending_field(*i);
                self.note(format!("{f:?}"));
                self.cancel_pending(f)
            }
            Action::Pause(t, p) => self.pause(*t, *p),
            Action::Sweep => {
                self.sweep();
            }
            Action::Shutdown => {
                self.shutdown();
            }
            Action::Redeem(u, amt) => {
                self.redeem(*u, *amt);
            }
        }
        self.check();
    }

    // -------------------------------------------------------------- users

    fn buy(&mut self, u: usize, amt: Amt) {
        let m = &self.m;
        let usdc = m.users[u].usdc;
        let (max_buy, cap) = (m.lim(F::MaxBuyPerIx), m.lim(F::SupplyCap));
        let room = cap.saturating_sub(m.supply);
        let amount = amt.of(&[usdc.min(max_buy).min(room), usdc, max_buy, room, MIN_BUY]);
        let mut v = vec![];
        if m.shut_down {
            v.push(e(E::ShutDown));
        }
        if m.buy_paused {
            v.push(e(E::BuyPaused));
        }
        if amount < MIN_BUY {
            v.push(e(E::AmountTooSmall));
        }
        if amount > max_buy {
            v.push(e(E::AmountTooLarge));
        }
        match m.supply.checked_add(amount) {
            None => v.push(e(E::MathOverflow)),
            Some(s) if s > cap => v.push(e(E::SupplyCapExceeded)),
            _ => {}
        }
        if usdc < amount {
            v.push(TOKEN_FUNDS);
        }
        self.note(format!("buy {amount}"));
        let res = self.env.buy(&self.users[u], amount);
        if self.judge(res, &v) {
            let m = &mut self.m;
            m.users[u].usdc -= amount;
            m.users[u].wallet += amount;
            m.reserve += amount;
            m.supply += amount;
        }
    }

    fn deposit(&mut self, u: usize, amt: Amt) {
        let m = &self.m;
        let wallet = m.users[u].wallet;
        let amount = amt.of(&[wallet]);
        let mut v = vec![];
        if m.shut_down {
            v.push(e(E::ShutDown));
        }
        if m.deposit_paused {
            v.push(e(E::DepositPaused));
        }
        if amount == 0 {
            v.push(e(E::ZeroAmount));
        }
        if wallet < amount {
            v.push(TOKEN_FUNDS);
        }
        self.note(format!("deposit {amount}"));
        let res = self.env.deposit(&self.users[u], amount);
        if self.judge(res, &v) {
            let m = &mut self.m;
            let mu = &mut m.users[u];
            mu.exists = true;
            mu.balance += amount;
            mu.wallet -= amount;
            m.tub += amount;
            m.vault += amount;
        }
    }

    /// Withdraw, first closing the (reservation, rent payer) pairs (brief 5.6, 6.3). Returns whether it succeeded.
    fn withdraw(&mut self, u: usize, amt: Amt, pairs: Vec<(u64, Pubkey)>) -> bool {
        let m = &self.m;
        let mu = m.users[u].clone();
        let mut v = vec![];
        if !mu.exists {
            v.push(NOT_INITIALIZED);
        }
        // Pairs are processed in order; the first bad one fails the transaction.
        let mut closed: Vec<u64> = vec![];
        for &(id, payer) in &pairs {
            let before = v.len();
            match m.live.get(&id).filter(|_| !closed.contains(&id)) {
                None => v.push(e(E::InvalidReservation)),
                Some(r) => {
                    if r.owner != u {
                        v.push(e(E::WrongOwner));
                    }
                    if m.now < r.expires_at {
                        v.push(e(E::NotExpired));
                    }
                    if payer != self.gw {
                        v.push(e(E::WrongPayer));
                    }
                }
            }
            if v.len() > before {
                break;
            }
            closed.push(id);
        }
        let released: u64 = closed.iter().map(|id| m.live[id].amount).sum();
        let avail_after = mu.balance - (mu.reserved - released);
        let amount = amt.of(&[avail_after, mu.balance - mu.reserved, mu.balance]);
        if v.is_empty() {
            if amount == 0 {
                v.push(e(E::ZeroAmount));
            }
            if amount > avail_after {
                v.push(e(E::InsufficientAvailable));
            }
        }
        let rent: u64 = closed.iter().map(|id| self.env.lamports(&res_pda(&rid(*id)))).sum();
        let ids: Vec<([u8; 32], Pubkey)> = pairs.iter().map(|(id, p)| (rid(*id), *p)).collect();
        self.note(format!("withdraw {amount} closing {pairs:?}"));
        let user = &self.users[u];
        let ix = self.env.ix_withdraw(&user.key(), user.credits, amount, &ids);
        let gw_before = self.env.lamports(&self.gw);
        let res = self.env.send(&[ix], &[&user.kp]);
        let ok = self.judge(res, &v);
        if ok {
            for id in &closed {
                self.m.release(*id);
            }
            let m = &mut self.m;
            m.users[u].balance -= amount;
            m.users[u].wallet += amount;
            m.tub -= amount;
            m.vault -= amount;
            assert_eq!(
                self.env.lamports(&self.gw) - gw_before,
                rent,
                "{}: rent of closed reservations goes to the payer",
                self.at
            );
            if !closed.is_empty() {
                self.hit("withdraw closed expired reservations");
            }
            if self.m.shut_down {
                self.hit("withdraw after shutdown");
            }
        } else if v.contains(&e(E::InsufficientAvailable)) && mu.reserved > 0 && amount <= mu.balance {
            self.hit("withdraw refused: credits held by live reservations");
        }
        ok
    }

    fn set_cap(&mut self, u: usize, amt: Amt) {
        let cap = amt.of(&[self.m.lim(F::MaxReservedPerUser), self.m.users[u].reserved, 0]);
        let v = if self.m.users[u].exists { vec![] } else { vec![NOT_INITIALIZED] };
        self.note(format!("cap {cap}"));
        let user = &self.users[u];
        let ix = self.env.ix_set_my_reserve_cap(&user.key(), cap);
        let res = self.env.send(&[ix], &[&user.kp]);
        if self.judge(res, &v) {
            self.m.users[u].cap = cap;
        }
    }

    fn redeem(&mut self, u: usize, amt: Amt) -> bool {
        let m = &self.m;
        let wallet = m.users[u].wallet;
        let amount = amt.of(&[wallet]);
        let mut v = vec![];
        if !m.shut_down {
            v.push(e(E::NotShutDown));
        }
        if amount == 0 {
            v.push(e(E::ZeroAmount));
        }
        if wallet < amount || m.reserve < amount {
            v.push(TOKEN_FUNDS);
        }
        self.note(format!("redeem {amount}"));
        let res = self.env.redeem(&self.users[u], amount);
        let ok = self.judge(res, &v);
        if ok {
            let m = &mut self.m;
            m.users[u].wallet -= amount;
            m.users[u].usdc += amount;
            m.supply -= amount;
            m.reserve -= amount;
            m.redeemed += amount;
        }
        ok
    }

    // -------------------------------------------------------------- plain SPL token moves

    fn self_burn(&mut self, u: usize, amt: Amt) {
        let wallet = self.m.users[u].wallet;
        let amount = amt.of(&[wallet]);
        let v = if wallet < amount { vec![TOKEN_FUNDS] } else { vec![] };
        self.note(format!("burn {amount} from the wallet"));
        let user = &self.users[u];
        let ix = spl_token::instruction::burn(
            &spl_token::ID,
            &user.credits,
            &self.env.credit_mint,
            &user.key(),
            &[],
            amount,
        )
        .unwrap();
        let res = self.env.send(&[ix], &[&user.kp]);
        if self.judge(res, &v) {
            self.m.users[u].wallet -= amount;
            self.m.supply -= amount;
            self.m.self_burned += amount;
        }
    }

    fn usdc_to_reserve(&mut self, u: usize, amt: Amt) {
        let usdc = self.m.users[u].usdc;
        let amount = amt.of(&[usdc]);
        let v = if usdc < amount { vec![TOKEN_FUNDS] } else { vec![] };
        self.note(format!("send {amount} USDC into the reserve"));
        let user = &self.users[u];
        let ix = spl_token::instruction::transfer(&spl_token::ID, &user.usdc, &reserve_pda(), &user.key(), &[], amount)
            .unwrap();
        let res = self.env.send(&[ix], &[&user.kp]);
        if self.judge(res, &v) {
            self.m.users[u].usdc -= amount;
            self.m.reserve += amount;
            self.m.donated_usdc += amount;
        }
    }

    fn credits_to_vault(&mut self, u: usize, amt: Amt) {
        let wallet = self.m.users[u].wallet;
        let amount = amt.of(&[wallet]);
        let v = if wallet < amount { vec![TOKEN_FUNDS] } else { vec![] };
        self.note(format!("send {amount} credits into the vault"));
        let user = &self.users[u];
        let ix =
            spl_token::instruction::transfer(&spl_token::ID, &user.credits, &vault_pda(), &user.key(), &[], amount)
                .unwrap();
        let res = self.env.send(&[ix], &[&user.kp]);
        if self.judge(res, &v) {
            self.m.users[u].wallet -= amount;
            self.m.vault += amount;
            self.m.donated_credits += amount;
        }
    }

    // -------------------------------------------------------------- gateway and anyone

    fn reserve(&mut self, u: usize, amt: Amt, reuse: Option<usize>) {
        let m = &self.m;
        let id = match reuse {
            Some(i) if !m.ever.is_empty() => m.ever[i % m.ever.len()],
            _ => m.next_id + 1,
        };
        let mu = &m.users[u];
        let avail = mu.balance - mu.reserved;
        let max_res = m.lim(F::MaxReservation);
        let hold = m.hold_limit(u);
        let room = hold.saturating_sub(mu.reserved);
        let amount = amt.of(&[avail.min(max_res).min(room), avail, max_res, room]);
        let mut v = vec![];
        if !mu.exists {
            v.push(NOT_INITIALIZED);
        }
        if m.live.contains_key(&id) {
            v.push(ALREADY_IN_USE);
        }
        if m.shut_down {
            v.push(e(E::ShutDown));
        }
        if m.gateway_paused {
            v.push(e(E::GatewayPaused));
        }
        if amount == 0 {
            v.push(e(E::ZeroAmount));
        }
        if amount > max_res {
            v.push(e(E::ReservationTooLarge));
        }
        if amount > avail {
            v.push(e(E::InsufficientAvailable));
        }
        match mu.reserved.checked_add(amount) {
            None => v.push(e(E::MathOverflow)),
            Some(x) if x > hold => v.push(e(E::UserHoldLimitExceeded)),
            _ => {}
        }
        let expires_at = m.now + m.lim(F::ReservationTtl) as i64;
        let mu_reserved = mu.reserved;
        self.m.next_id = self.m.next_id.max(id);
        self.note(format!("reserve #{id} {amount}"));
        let res = self.env.reserve(rid(id), self.keys[u], amount);
        if self.judge(res, &v) {
            let m = &mut self.m;
            m.live.insert(id, MRes { owner: u, amount, expires_at });
            let reused = m.ever.contains(&id);
            if !reused {
                m.ever.push(id);
            }
            m.users[u].reserved += amount;
            m.active += amount;
            if reused {
                self.hit("reserve re-created a closed request id");
            }
            if amount == avail {
                self.hit("reserve took exactly all available");
            }
            if amount + mu_reserved == hold {
                self.hit("reserve filled the hold limit exactly");
            }
        }
    }

    fn settle(&mut self, sel: Sel, amt: Amt) {
        let Some(id) = self.m.pick(sel) else { return };
        let r = self.m.live.get(&id).copied();
        let actual = amt.of(&[r.map_or(0, |r| r.amount)]);
        let mut v = vec![];
        match r {
            None => v.push(NOT_INITIALIZED),
            Some(r) => {
                if actual > r.amount {
                    v.push(e(E::ActualExceedsReserved));
                }
                if !self.m.burn_fits(actual) {
                    v.push(e(E::BurnCapExceeded));
                }
            }
        }
        let owner = r.map_or(self.keys[0], |r| self.keys[r.owner]);
        self.note(format!("settle #{id} actual {actual}"));
        let res = self.env.settle(rid(id), owner, actual);
        if self.judge(res, &v) {
            let rolled = self.m.window_burned > 0 && self.m.now >= self.m.window_start + BURN_WINDOW_SECS;
            assert!(self.m.try_burn(actual));
            self.m.settle(id, actual);
            let r = r.unwrap();
            if actual == 0 {
                self.hit("settle released with actual 0");
            }
            if actual == r.amount {
                self.hit("settle burned the whole reservation");
            }
            if rolled && actual > 0 {
                self.hit("settle burned in a new burn window");
            }
            if self.m.shut_down {
                self.hit("settle after shutdown");
            }
        } else if v == [e(E::BurnCapExceeded)] {
            self.hit("settle refused: over the burn cap");
        }
    }

    /// Entries are processed in order (brief 6.3): a duplicate, a foreign UserAccount or actual > amount fails the
    /// batch; a closed reservation is skipped; an entry that does not fit the burn window is skipped and stays live.
    fn settle_many(&mut self, entries: &[(Sel, Amt, Option<usize>)]) {
        let mut sim = self.m.clone();
        let mut v = vec![];
        let mut built = vec![];
        let mut seen = BTreeSet::new();
        let mut events: Vec<&str> = vec![];
        let mut settled_owners: Vec<usize> = vec![];
        let mut taken: BTreeSet<u64> = BTreeSet::new();
        for &(sel, amt, other) in entries {
            // Live picks are without replacement, so a batch covers several reservations (often of one user);
            // duplicates come from Ever picks and from running out of live ones.
            let id = match sel {
                Sel::Live(i) => {
                    let rest: Vec<u64> = self.m.live.keys().copied().filter(|id| !taken.contains(id)).collect();
                    if rest.is_empty() {
                        self.m.pick(Sel::Ever(i))
                    } else {
                        Some(rest[i % rest.len()])
                    }
                }
                Sel::Ever(_) | Sel::Due => self.m.pick(sel),
            };
            let Some(id) = id else { continue };
            taken.insert(id);
            let orig = self.m.live.get(&id).copied();
            let actual = amt.of(&[orig.map_or(0, |r| r.amount)]);
            let acct = other.unwrap_or(orig.map_or(0, |r| r.owner));
            built.push((rid(id), self.keys[acct], actual));
            if !v.is_empty() {
                continue;
            }
            if !seen.insert(id) {
                v.push(e(E::DuplicateReservation));
                continue;
            }
            let Some(r) = sim.live.get(&id).copied() else {
                events.push("settle_many skipped a closed reservation");
                continue;
            };
            if acct != r.owner {
                v.push(e(E::InvalidUserAccount));
                continue;
            }
            if actual > r.amount {
                v.push(e(E::ActualExceedsReserved));
                continue;
            }
            if sim.try_burn(actual) {
                sim.settle(id, actual);
                if settled_owners.contains(&r.owner) {
                    events.push("settle_many settled several reservations of one user");
                }
                settled_owners.push(r.owner);
            } else {
                events.push("settle_many skipped an entry over the burn cap");
            }
        }
        let shown: Vec<_> = built
            .iter()
            .map(|(id, k, a)| {
                (u64::from_le_bytes(id[..8].try_into().unwrap()), self.keys.iter().position(|x| x == k).unwrap(), *a)
            })
            .collect();
        self.note(format!("settle_many (id, user account, actual) {shown:?}"));
        let res = self.env.settle_many(&built);
        if self.judge(res, &v) {
            self.m = sim;
            for ev in events {
                self.hit(ev);
            }
        }
    }

    fn expire(&mut self, id: u64) -> bool {
        let r = self.m.live.get(&id).copied();
        let v = match r {
            None => vec![NOT_INITIALIZED],
            Some(r) if self.m.now < r.expires_at => vec![e(E::NotExpired)],
            Some(_) => vec![],
        };
        let owner = r.map_or(self.keys[0], |r| self.keys[r.owner]);
        let rent = self.env.lamports(&res_pda(&rid(id)));
        let gw_before = self.env.lamports(&self.gw);
        self.note(format!("expire #{id}"));
        let res = self.env.expire(rid(id), owner);
        let ok = self.judge(res, &v);
        if ok {
            self.m.release(id);
            assert_eq!(self.env.lamports(&self.gw) - gw_before, rent, "{}: rent goes back to the payer", self.at);
            if self.m.now == r.unwrap().expires_at {
                self.hit("expire exactly at expires_at");
            }
        }
        ok
    }

    fn warp(&mut self, secs: i64) {
        self.env.warp(secs);
        self.m.now += secs;
    }

    // -------------------------------------------------------------- admin

    fn set_limit(&mut self, f: ConfigField, lim: Lim) {
        let cur = self.m.lim(f);
        let (lo, hi) = brief_bounds(f);
        let value = lim.of(cur, lo, hi);
        let v = if value < lo || value > hi { vec![e(E::OutOfBounds)] } else { vec![] };
        self.note(format!("set {f:?} {cur} → {value}"));
        let ix = self.env.ix_set_limit(&self.env.admin.pubkey(), f, value);
        let res = self.env.as_admin(ix);
        if self.judge(res, &v) {
            let m = &mut self.m;
            let i = f.index();
            // Raising, or any change of admin_delay, waits admin_delay; lowering applies now and drops a pending raise.
            if f == F::AdminDelay || value > cur {
                m.pending[i] = (value, m.now + m.lim(F::AdminDelay) as i64);
                self.hit("set_limit queued a raise");
            } else {
                let dropped = m.pending[i].1 != 0;
                m.limits[i] = value;
                m.pending[i] = (0, 0);
                self.hit("set_limit lowered a limit at once");
                if dropped {
                    self.hit("set_limit lowering dropped a pending raise");
                }
            }
        }
    }

    fn apply_pending(&mut self, f: ConfigField) {
        let (value, at) = self.m.pending[f.index()];
        let v = if at == 0 {
            vec![e(E::NoPendingChange)]
        } else if self.m.now < at {
            vec![e(E::PendingNotReady)]
        } else {
            vec![]
        };
        let ix = self.env.ix_apply_pending(f);
        let res = self.env.as_anyone(ix);
        if self.judge(res, &v) {
            self.m.limits[f.index()] = value;
            self.m.pending[f.index()] = (0, 0);
        }
    }

    fn cancel_pending(&mut self, f: ConfigField) {
        let v = if self.m.pending[f.index()].1 == 0 { vec![e(E::NoPendingChange)] } else { vec![] };
        let ix = self.env.ix_cancel_pending(&self.env.admin.pubkey(), f);
        let res = self.env.as_admin(ix);
        if self.judge(res, &v) {
            self.m.pending[f.index()] = (0, 0);
        }
    }

    fn pause(&mut self, t: PauseTarget, paused: bool) {
        let ix = self.env.ix_set_pause(&self.env.admin.pubkey(), t, paused);
        let res = self.env.as_admin(ix);
        if self.judge(res, &[]) {
            match t {
                PauseTarget::Buy => self.m.buy_paused = paused,
                PauseTarget::Deposit => self.m.deposit_paused = paused,
                PauseTarget::Gateway => self.m.gateway_paused = paused,
            }
        }
    }

    /// Burns vault − total_user_balance, then sends reserve − supply to the treasury (brief 6.3).
    fn sweep(&mut self) -> bool {
        let m = &self.m;
        let mut v = vec![];
        let credits = m.vault.saturating_sub(m.tub);
        let supply_after = m.supply - credits;
        if m.vault < m.tub || m.reserve < supply_after {
            v.push(e(E::Insolvent));
        }
        let usdc = m.reserve.saturating_sub(supply_after);
        self.note(format!("sweep {credits} credits, {usdc} USDC"));
        let ix = self.env.ix_sweep_surplus(&self.env.admin.pubkey());
        let res = self.env.as_admin(ix);
        let ok = self.judge(res, &v);
        if ok {
            let m = &mut self.m;
            m.vault -= credits;
            m.supply -= credits;
            m.reserve -= usdc;
            m.treasury += usdc;
            m.swept_credits += credits;
            m.swept_usdc += usdc;
            if credits > 0 {
                self.hit("sweep burned credits sent into the vault");
            }
            if usdc > 0 {
                self.hit("sweep moved surplus USDC to the treasury");
            }
            if self.m.active > 0 {
                self.hit("sweep with live reservations");
            }
        }
        ok
    }

    fn shutdown(&mut self) -> bool {
        let v = if self.m.shut_down { vec![e(E::ShutDown)] } else { vec![] };
        let ix = self.env.ix_shutdown(&self.env.admin.pubkey());
        let res = self.env.as_admin(ix);
        let ok = self.judge(res, &v);
        if ok {
            self.m.shut_down = true;
        }
        ok
    }

    // -------------------------------------------------------------- checks

    /// Brief 5.9 invariants, conservation laws and a field-by-field comparison with the model.
    fn check(&self) {
        let (env, m, at) = (&self.env, &self.m, &self.at);
        let live: Vec<[u8; 32]> = m.live.keys().map(|&id| rid(id)).collect();
        if let Err(p) = catch_unwind(AssertUnwindSafe(|| env.check_invariants(&self.keys, &live))) {
            let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()));
            panic!("{at}: brief 5.9 invariant broken: {}", msg.unwrap_or_default());
        }

        let c = env.config();
        let reserve = env.token_balance(&reserve_pda());
        let vault = env.token_balance(&vault_pda());
        let supply = env.credit_supply();
        let treasury = env.token_balance(&c.treasury);

        // Conservation (brief 5.9, 6.3): the treasury gets only spent credits' USDC and swept surplus; USDC above the
        // circulation comes only from donations, wallet burns and swept credits; credits above users' balances in
        // the vault come only from donations.
        assert_eq!(
            treasury,
            c.total_released + c.total_swept_usdc,
            "{at}: treasury = total_released + total_swept_usdc"
        );
        assert_eq!(
            i128::from(reserve) - i128::from(supply),
            i128::from(m.donated_usdc) + i128::from(m.self_burned) + i128::from(c.total_swept_credits)
                - i128::from(c.total_swept_usdc),
            "{at}: reserve − supply = donated USDC + wallet burns + swept credits − swept USDC"
        );
        assert_eq!(
            i128::from(vault) - i128::from(c.total_user_balance),
            i128::from(m.donated_credits) - i128::from(c.total_swept_credits),
            "{at}: vault − total_user_balance = donated credits − swept credits"
        );
        let wallets: u64 = self.users.iter().map(|u| env.token_balance(&u.credits)).sum();
        assert_eq!(supply, wallets + vault, "{at}: every credit is in a wallet or in the vault");

        // Model.
        assert_eq!(
            (reserve, vault, supply, treasury),
            (m.reserve, m.vault, m.supply, m.treasury),
            "{at}: (reserve, vault, supply, treasury) vs model"
        );
        assert_eq!(
            [c.total_user_balance, c.active_reserved, c.total_burned, c.total_released, c.total_redeemed],
            [m.tub, m.active, m.burned, m.released, m.redeemed],
            "{at}: [total_user_balance, active_reserved, total_burned, total_released, total_redeemed] vs model"
        );
        assert_eq!(
            (c.total_swept_usdc, c.total_swept_credits),
            (m.swept_usdc, m.swept_credits),
            "{at}: (total_swept_usdc, total_swept_credits) vs model"
        );
        assert_eq!(
            (c.buy_paused, c.deposit_paused, c.gateway_paused, c.shut_down),
            (m.buy_paused, m.deposit_paused, m.gateway_paused, m.shut_down),
            "{at}: flags vs model"
        );
        assert_eq!(LIMITS.map(|f| c.limit(f).unwrap()), m.limits, "{at}: limits vs model");
        assert_eq!(
            LIMITS.map(|f| (c.pending[f.index()].value, c.pending[f.index()].effective_at)),
            m.pending,
            "{at}: pending changes vs model"
        );
        assert_eq!((c.window_start, c.window_burned), (m.window_start, m.window_burned), "{at}: burn window vs model");

        for (i, (u, mu)) in self.users.iter().zip(&m.users).enumerate() {
            let ua = env.user_account(&u.key());
            assert_eq!(ua.is_some(), mu.exists, "{at}: user {i} account exists");
            if let Some(ua) = ua {
                assert_eq!(ua.owner, u.key(), "{at}: user {i} owner");
                assert_eq!(
                    (ua.balance, ua.reserved, ua.reserve_cap),
                    (mu.balance, mu.reserved, mu.cap),
                    "{at}: user {i} (balance, reserved, reserve_cap) vs model"
                );
            }
            assert_eq!(
                (env.token_balance(&u.credits), env.token_balance(&u.usdc)),
                (mu.wallet, mu.usdc),
                "{at}: user {i} wallet (credits, USDC) vs model"
            );
        }

        for &id in &m.ever {
            match (env.reservation(&rid(id)), m.live.get(&id)) {
                (None, None) => {}
                (Some(r), Some(mr)) => {
                    assert_eq!(
                        (r.owner, r.request_id, r.amount, r.expires_at, r.payer),
                        (self.keys[mr.owner], rid(id), mr.amount, mr.expires_at, self.gw),
                        "{at}: reservation #{id} vs model"
                    );
                    assert!(env.exists(&res_pda(&rid(id))));
                }
                (chain, model) => panic!("{at}: reservation #{id}: chain {chain:?}, model {model:?}"),
            }
        }
    }

    /// Shutdown → every reservation expires → every user withdraws everything → every credit held is redeemed →
    /// only surplus is left, and sweep_surplus takes it to exactly zero (brief 5.7, 5.9, 13).
    fn finish(&mut self) {
        self.kind = "Final".into();
        self.at = "final shutdown".into();
        if !self.m.shut_down {
            assert!(self.shutdown(), "{}: shutdown", self.at);
        }
        self.check();
        // Longer than any TTL a reservation could have been created with.
        self.warp(RESERVATION_TTL_MAX as i64 + 1);
        for u in 0..N_USERS {
            if !self.m.users[u].exists {
                continue;
            }
            let own = self.m.own_live(u);
            // At most 8 pairs go into the withdraw itself; the rest are expired one by one first.
            let (direct, passed) = own.split_at(own.len().saturating_sub(8));
            for &id in direct {
                self.at = format!("final: expire #{id} of user {u}");
                assert!(self.expire(id), "{}", self.at);
                self.check();
            }
            let balance = self.m.users[u].balance;
            self.at = format!("final: user {u} withdraws everything ({balance}), closing {passed:?}");
            if balance > 0 {
                let pairs = passed.iter().map(|&id| (id, self.gw)).collect();
                assert!(self.withdraw(u, Amt::Abs(balance), pairs), "{}", self.at);
            } else {
                for &id in passed {
                    assert!(self.expire(id), "{}", self.at);
                }
            }
            self.check();
        }
        assert!(self.m.live.is_empty() && self.m.active == 0 && self.m.tub == 0, "every API balance withdrawn");

        for u in 0..N_USERS {
            let held = self.m.users[u].wallet;
            let part = held / 3;
            for amount in [part, held - part] {
                if amount > 0 {
                    self.at = format!("final: user {u} redeems {amount} of {held}");
                    assert!(self.redeem(u, Amt::Abs(amount)), "{}", self.at);
                    self.check();
                }
            }
        }

        // Every credit any holder had is redeemed: what is left in circulation are only the credits sent straight
        // into the vault, and what is left in the reserve beyond them is surplus.
        self.at = "final: after full redemption".into();
        let (reserve, vault, supply) =
            (self.env.token_balance(&reserve_pda()), self.env.token_balance(&vault_pda()), self.env.credit_supply());
        assert_eq!(supply, vault, "{}: only unowned vault credits remain in circulation", self.at);
        assert_eq!(
            vault,
            self.m.donated_credits - self.m.swept_credits,
            "{}: vault holds only donated credits",
            self.at
        );
        assert!(reserve >= supply, "{}: reserve {reserve} < supply {supply}", self.at);
        assert_eq!(
            reserve - supply,
            self.m.donated_usdc + self.m.self_burned + self.m.swept_credits - self.m.swept_usdc,
            "{}: reserve − supply is surplus only",
            self.at
        );
        assert!(self.sweep(), "{}: sweep", self.at);
        self.check();
        let (reserve, vault, supply) =
            (self.env.token_balance(&reserve_pda()), self.env.token_balance(&vault_pda()), self.env.credit_supply());
        assert_eq!((reserve, vault, supply), (0, 0, 0), "{}: (reserve, vault, supply) after the final sweep", self.at);
    }
}

// ------------------------------------------------------------------ strategies

fn user() -> impl Strategy<Value = usize> {
    0..N_USERS
}

fn amt() -> impl Strategy<Value = Amt> {
    prop_oneof![
        3 => (0u64..=120).prop_map(|k| Amt::Abs(k * C)),
        2 => (0u64..=30 * C).prop_map(Amt::Abs),
        5 => (0u16..=1000).prop_map(Amt::Frac),
        4 => (0u8..5, -2i8..=2).prop_map(|(i, d)| Amt::Edge(i, d)),
        1 => Just(Amt::Abs(u64::MAX)),
    ]
}

/// Withdrawal amounts: like `amt`, plus exactly all available and one μcr over each boundary (available after the
/// releases, available before them, the whole balance).
fn take() -> impl Strategy<Value = Amt> {
    prop_oneof![
        6 => amt(),
        1 => Just(Amt::Edge(0, 0)),
        2 => (0u8..3).prop_map(|i| Amt::Edge(i, 1)),
    ]
}

/// Reservation amounts: mostly a share of what fits (so several reservations live at once), sometimes exactly a
/// boundary ± 2 μcr, sometimes far too large.
fn hold() -> impl Strategy<Value = Amt> {
    prop_oneof![
        5 => (0u16..=1000).prop_map(Amt::Frac),
        5 => (1u16..=350).prop_map(Amt::Frac),
        2 => Just(Amt::Edge(0, 0)),
        1 => (0u8..4).prop_map(|i| Amt::Edge(i, 1)),
        3 => (0u8..4, -2i8..=2).prop_map(|(i, d)| Amt::Edge(i, d)),
        2 => (0u64..=60).prop_map(|k| Amt::Abs(k * C)),
        1 => Just(Amt::Abs(u64::MAX)),
    ]
}

/// Settlement actuals: mostly ≤ the reserved amount, sometimes just or far above it.
fn actual() -> impl Strategy<Value = Amt> {
    prop_oneof![
        6 => (0u16..=1000).prop_map(Amt::Frac),
        2 => Just(Amt::Frac(0)),
        2 => Just(Amt::Frac(1000)),
        1 => (1i8..=2).prop_map(|d| Amt::Edge(0, d)),
        1 => (1u64..=60).prop_map(|k| Amt::Abs(k * C)),
    ]
}

fn sel() -> impl Strategy<Value = Sel> {
    prop_oneof![
        6 => (0usize..32).prop_map(Sel::Live),
        1 => (0usize..32).prop_map(Sel::Ever),
        1 => Just(Sel::Due),
    ]
}

fn pass() -> impl Strategy<Value = Pass> {
    prop_oneof![
        3 => (0usize..8).prop_map(Pass::Own),
        3 => (0usize..8).prop_map(Pass::OwnExpired),
        2 => (0usize..32).prop_map(Pass::Ever),
        2 => (0usize..8).prop_map(Pass::OwnWrongPayer),
    ]
}

fn limit_field() -> impl Strategy<Value = ConfigField> {
    prop::sample::select(LIMITS.to_vec())
}

fn lim() -> impl Strategy<Value = Lim> {
    prop_oneof![
        6 => (0u16..=2000).prop_map(Lim::Frac),
        1 => (-2i32..=2).prop_map(Lim::Lo),
        1 => (-2i32..=2).prop_map(Lim::Hi),
    ]
}

/// Around the burn window (600 s), reservation TTLs (30 min – 24 h) and the admin delay (≥ 24 h).
fn warp_secs() -> impl Strategy<Value = i64> {
    prop_oneof![
        4 => prop::sample::select(vec![1i64, 300, 599, 600, 601, 1_799, 1_800, 3_599, 3_600, 3_601, 7_200]),
        2 => prop::sample::select(vec![86_400i64, 86_401, 2 * 86_400, 2 * 86_400 + 1]),
        2 => 1i64..=4_000,
    ]
}

fn pause_target() -> impl Strategy<Value = PauseTarget> {
    prop::sample::select(vec![PauseTarget::Buy, PauseTarget::Deposit, PauseTarget::Gateway])
}

fn mark() -> impl Strategy<Value = Mark> {
    prop_oneof![
        3 => sel().prop_map(Mark::Expiry),
        2 => Just(Mark::WindowEnd),
        2 => (0usize..8).prop_map(Mark::PendingAt),
    ]
}

/// Weights put roughly one case in three through a mid-sequence shutdown.
fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        14 => (user(), amt()).prop_map(|(u, a)| Action::Buy(u, a)),
        14 => (user(), amt()).prop_map(|(u, a)| Action::Deposit(u, a)),
        12 => (user(), take(), pvec(pass(), 0..=3)).prop_map(|(u, a, p)| Action::Withdraw(u, a, p)),
        4 => (user(), amt()).prop_map(|(u, a)| Action::SetCap(u, a)),
        28 => (user(), hold(), prop::option::weighted(0.1, 0usize..32)).prop_map(|(u, a, r)| Action::Reserve(u, a, r)),
        14 => (sel(), actual()).prop_map(|(s, a)| Action::Settle(s, a)),
        10 => pvec((sel(), actual(), prop::option::weighted(0.08, user())), 0..=6).prop_map(Action::SettleMany),
        8 => sel().prop_map(Action::Expire),
        10 => warp_secs().prop_map(Action::Warp),
        6 => (mark(), -1i8..=1).prop_map(|(m, d)| Action::WarpTo(m, d)),
        3 => (user(), amt()).prop_map(|(u, a)| Action::SelfBurn(u, a)),
        2 => (user(), amt()).prop_map(|(u, a)| Action::UsdcToReserve(u, a)),
        2 => (user(), amt()).prop_map(|(u, a)| Action::CreditsToVault(u, a)),
        5 => (limit_field(), lim()).prop_map(|(f, l)| Action::SetLimit(f, l)),
        3 => (0usize..16).prop_map(Action::ApplyPending),
        2 => (0usize..16).prop_map(Action::CancelPending),
        4 => (pause_target(), prop::bool::weighted(0.4)).prop_map(|(t, p)| Action::Pause(t, p)),
        3 => Just(Action::Sweep),
        1 => Just(Action::Shutdown),
        3 => (user(), amt()).prop_map(|(u, a)| Action::Redeem(u, a)),
    ]
}

fn setup() -> impl Strategy<Value = Setup> {
    let tight = prop::option::weighted(
        0.5,
        (1u64..=300, 50u64..=3_000, 1u64..=40 * C, 0u64..=80 * C, 0u64..=60 * C, 1_800u64..=7_200)
            .prop_map(|(b, s, r, h, burn, ttl)| [b * C, s * C, r, h, burn, ttl]),
    );
    let usdc = prop_oneof![1 => Just(0u64), 3 => 0u64..=60 * C, 4 => 0u64..=2_000 * C];
    let users = pvec((usdc, 0u16..=1000, 0u16..=1000), N_USERS);
    (tight, users).prop_map(|(tight, users)| Setup { tight, users })
}

fn config() -> ProptestConfig {
    ProptestConfig {
        cases: 64,
        max_shrink_iters: 4_096,
        max_shrink_time: 180_000,
        failure_persistence: Some(Box::new(FileFailurePersistence::WithSource("proptest-regressions"))),
        ..ProptestConfig::default()
    }
}

fn run_case(setup: &Setup, actions: &[Action]) -> World {
    let mut w = World::new(setup);
    for (i, a) in setup.prefund().iter().chain(actions).enumerate() {
        w.step(i, a);
    }
    w.finish();
    w
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn invariants_hold_under_random_action_sequences(setup in setup(), actions in pvec(action(), 30..=80)) {
        run_case(&setup, &actions);
    }
}

/// Outcomes and paths a fixed-seed batch of generated cases must reach, so the fuzzer cannot silently go vacuous
/// (e.g. every reserve failing for lack of balance). `FUZZ_STATS=1 cargo test ... -- --nocapture` prints the counts.
const REQUIRED: &[&str] = &[
    "Buy: ok",
    "Buy: AmountTooSmall",
    "Buy: AmountTooLarge",
    "Buy: BuyPaused",
    "Buy: ShutDown",
    "Buy: TokenInsufficientFunds",
    "Deposit: ok",
    "Deposit: ZeroAmount",
    "Deposit: DepositPaused",
    "Deposit: TokenInsufficientFunds",
    "Withdraw: ok",
    "Withdraw: ZeroAmount",
    "Withdraw: InsufficientAvailable",
    "Withdraw: AccountNotInitialized",
    "Withdraw: NotExpired",
    "Withdraw: WrongOwner",
    "Withdraw: WrongPayer",
    "Withdraw: InvalidReservation",
    "SetCap: ok",
    "Reserve: ok",
    "Reserve: ZeroAmount",
    "Reserve: ReservationTooLarge",
    "Reserve: InsufficientAvailable",
    "Reserve: UserHoldLimitExceeded",
    "Reserve: AccountNotInitialized",
    "Reserve: GatewayPaused",
    "Reserve: ShutDown",
    "Reserve: SystemAccountAlreadyInUse",
    "Settle: ok",
    "Settle: ActualExceedsReserved",
    "Settle: BurnCapExceeded",
    "Settle: AccountNotInitialized",
    "SettleMany: ok",
    "SettleMany: DuplicateReservation",
    "SettleMany: InvalidUserAccount",
    "SettleMany: ActualExceedsReserved",
    "Expire: ok",
    "Expire: NotExpired",
    "Expire: AccountNotInitialized",
    "SelfBurn: ok",
    "UsdcToReserve: ok",
    "CreditsToVault: ok",
    "SetLimit: ok",
    "SetLimit: OutOfBounds",
    "ApplyPending: ok",
    "ApplyPending: NoPendingChange",
    "ApplyPending: PendingNotReady",
    "CancelPending: ok",
    "Pause: ok",
    "Sweep: ok",
    "Shutdown: ok",
    "Shutdown: ShutDown",
    "Redeem: ok",
    "Redeem: NotShutDown",
    "event: withdraw closed expired reservations",
    "event: withdraw after shutdown",
    "event: withdraw refused: credits held by live reservations",
    "event: reserve re-created a closed request id",
    "event: reserve took exactly all available",
    "event: reserve filled the hold limit exactly",
    "event: settle released with actual 0",
    "event: settle burned the whole reservation",
    "event: settle burned in a new burn window",
    "event: settle after shutdown",
    "event: settle refused: over the burn cap",
    "event: settle_many skipped a closed reservation",
    "event: settle_many skipped an entry over the burn cap",
    "event: settle_many settled several reservations of one user",
    "event: expire exactly at expires_at",
    "event: set_limit queued a raise",
    "event: set_limit lowered a limit at once",
    "event: sweep burned credits sent into the vault",
    "event: sweep moved surplus USDC to the treasury",
    "event: sweep with live reservations",
];

#[test]
fn fuzz_reaches_every_outcome() {
    let mut runner =
        TestRunner::new_with_rng(ProptestConfig::default(), TestRng::deterministic_rng(RngAlgorithm::ChaCha));
    let strategy = (setup(), pvec(action(), 30..=80));
    let mut stats: BTreeMap<String, u32> = BTreeMap::new();
    for _ in 0..48 {
        let (setup, actions) = strategy.new_tree(&mut runner).unwrap().current();
        for (k, n) in run_case(&setup, &actions).stats.into_inner() {
            *stats.entry(k).or_default() += n;
        }
    }
    if std::env::var_os("FUZZ_STATS").is_some() {
        for (k, n) in &stats {
            println!("{n:>6}  {k}");
        }
    }
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|k| !stats.contains_key(*k)).collect();
    assert!(missing.is_empty(), "the fuzzer never reached: {missing:#?}");
}

/// Brief 6.3: `settle` with `actual = 0` is a release without burning, and the burn cap limits burning. Lowering
/// `burn_cap_per_window` is an immediate, risk-reducing admin action (e.g. reacting to a compromised gateway key).
/// If it goes below what was already burned in the current window, the program refuses even zero settles with
/// BurnCapExceeded until the window rolls over (`Config::try_burn` checks `window_burned + 0 > cap`), and
/// `settle_many` skips zero entries instead of releasing them. Found by the fuzzer with a brief-literal model; the
/// fuzz model above mirrors the program here so it keeps guarding everything else.
#[test]
fn zero_release_blocked_by_lowered_burn_cap() {
    let mut env = Env::ready();
    let u = env.funded_user(10 * C);
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_ok(env.reserve(rid(2), u.key(), C));
    assert_ok(env.reserve(rid(3), u.key(), C));
    assert_ok(env.settle(rid(1), u.key(), 2 * C)); // 2 credits burned in this window
    let ix = env.ix_set_limit(&env.admin.pubkey(), ConfigField::BurnCapPerWindow, C); // lowering: immediate
    assert_ok(env.as_admin(ix));
    assert_eq!(env.config().burn_cap_per_window, C);

    // A release burns nothing, so the burn cap must not stop it.
    assert_ok(env.settle(rid(2), u.key(), 0));
    assert_ok(env.settle_many(&[(rid(3), u.key(), 0)]));
    assert!(env.reservation(&rid(3)).is_none(), "the zero entry of settle_many is released, not skipped");
    assert_eq!(env.user_account(&u.key()).unwrap().reserved, 0);
    env.check_invariants(&[u.key()], &[]);
}
