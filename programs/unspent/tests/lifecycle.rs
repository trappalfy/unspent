mod common;
use common::*;
use solana_signer::Signer;

/// The full onchain cycle of brief 16 stage 3: buy → deposit → reserve → settle / settle_many → withdraw →
/// abandoned reservation expires → shutdown → withdraw and redeem.
#[test]
fn full_cycle() {
    let mut env = Env::ready();
    let u = env.user(100 * C);
    assert_ok(env.buy(&u, 100 * C));
    assert_eq!(env.token_balance(&u.credits), 100 * C);
    assert_eq!(env.token_balance(&reserve_pda()), 100 * C);
    assert_ok(env.deposit(&u, 60 * C));
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (60 * C, 0));

    // request 1: reserve 2 credits, settle 0.01035
    assert_ok(env.reserve(rid(1), u.key(), 2 * C));
    assert_eq!(env.user_account(&u.key()).unwrap().reserved, 2 * C);
    let gw_before = env.lamports(&env.gateway.pubkey());
    assert_ok(env.settle(rid(1), u.key(), 10_350));
    assert!(env.reservation(&rid(1)).is_none());
    assert!(env.lamports(&env.gateway.pubkey()) > gw_before - 10_000, "rent returned to gateway");
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (60 * C - 10_350, 0));
    assert_eq!(env.token_balance(&env.treasury), 10_350);
    assert_eq!(env.credit_supply(), 100 * C - 10_350);

    // requests 2-4 in one settle_many, including a release (actual 0)
    for i in 2..=4 {
        assert_ok(env.reserve(rid(i), u.key(), C));
    }
    assert_ok(env.settle_many(&[(rid(2), u.key(), 500_000), (rid(3), u.key(), 0), (rid(4), u.key(), C)]));
    let ua = env.user_account(&u.key()).unwrap();
    assert_eq!((ua.balance, ua.reserved), (60 * C - 10_350 - 1_500_000, 0));
    assert_eq!(env.token_balance(&env.treasury), 10_350 + 1_500_000);
    for i in 2..=4 {
        assert!(env.reservation(&rid(i)).is_none());
    }

    // abandoned reservation: gateway disappears, it expires after the TTL and is closed inside withdraw
    assert_ok(env.reserve(rid(5), u.key(), 10 * C));
    env.check_invariants(&[u.key()], &[rid(5)]);
    let avail = env.user_account(&u.key()).unwrap().available().unwrap();
    assert_err(env.withdraw(&u, avail + 1), unspent::error::UnspentError::InsufficientAvailable);
    env.warp(3_600);
    let g = env.gateway.pubkey();
    let ix = env.ix_withdraw(&u.key(), u.credits, avail + 10 * C, &[(rid(5), g)]);
    assert_ok(env.send(&[ix], &[&u.kp]));
    assert!(env.reservation(&rid(5)).is_none());
    assert_eq!(env.user_account(&u.key()).unwrap().balance, 0);

    // shutdown: buy and deposit stop, redeem opens 1:1
    let ix = env.ix_shutdown(&env.admin.pubkey());
    assert_ok(env.as_admin(ix));
    assert_err(env.buy(&u, C), unspent::error::UnspentError::ShutDown);
    let held = env.token_balance(&u.credits);
    let usdc_before = env.token_balance(&u.usdc);
    assert_ok(env.redeem(&u, held));
    assert_eq!(env.token_balance(&u.usdc), usdc_before + held);
    assert_eq!(env.credit_supply(), 0);
    assert_eq!(env.token_balance(&reserve_pda()), 0, "every credit redeemed, reserve empty");
    env.check_invariants(&[u.key()], &[]);
}
