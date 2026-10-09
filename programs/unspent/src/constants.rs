use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const USER_SEED: &[u8] = b"user";
#[constant]
pub const RESERVATION_SEED: &[u8] = b"res";
#[constant]
pub const RESERVE_SEED: &[u8] = b"reserve";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Mainnet USDC (classic SPL Token, decimals 6). Unspent targets mainnet only; local tests place a mock mint at this address.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

pub const CREDIT_DECIMALS: u8 = 6;
/// 1 credit in base units (μcr). 1 μcr = 1 USDC base unit.
pub const CREDIT: u64 = 1_000_000;
/// Minimum purchase: 1 credit.
pub const MIN_BUY: u64 = CREDIT;
/// Burn window for the gateway's burn cap.
pub const BURN_WINDOW_SECS: i64 = 600;

// Hard bounds on admin-set limits (brief 6.3, set_limits).
pub const MAX_BUY_PER_IX_BOUND: u64 = 1_000_000 * CREDIT;
pub const SUPPLY_CAP_BOUND: u64 = 100_000_000 * CREDIT;
pub const MAX_RESERVATION_BOUND: u64 = 1_000 * CREDIT;
pub const MAX_RESERVED_PER_USER_BOUND: u64 = 10_000 * CREDIT;
pub const BURN_CAP_BOUND: u64 = 200_000 * CREDIT;
pub const RESERVATION_TTL_MIN: u64 = 30 * 60;
pub const RESERVATION_TTL_MAX: u64 = 24 * 3600;
pub const ADMIN_DELAY_MIN: u64 = 24 * 3600;
pub const ADMIN_DELAY_MAX: u64 = 14 * 24 * 3600;
