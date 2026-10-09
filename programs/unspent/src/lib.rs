//! Unspent: LLM inference credits as an SPL token. Credits are minted 1:1 against USDC held in the reserve,
//! deposited into a program vault, and spent per request through onchain reserve → settle (UNSPENT_BRIEF.md §6).

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5YSrsYtX6UnSx8KAbiD8RWM7UzNNXU3w5QhxSA2vvfkx");

#[program]
pub mod unspent {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, params)
    }

    // ---- users
    pub fn buy_credits(ctx: Context<BuyCredits>, amount: u64) -> Result<()> {
        instructions::user::handle_buy_credits(ctx, amount)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::user::handle_deposit(ctx, amount)
    }

    pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>, amount: u64) -> Result<()> {
        instructions::user::handle_withdraw(ctx, amount)
    }

    pub fn set_my_reserve_cap(ctx: Context<SetMyReserveCap>, cap: u64) -> Result<()> {
        instructions::user::handle_set_my_reserve_cap(ctx, cap)
    }

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        instructions::user::handle_redeem(ctx, amount)
    }

    // ---- gateway
    pub fn reserve(ctx: Context<Reserve>, request_id: [u8; 32], owner: Pubkey, amount: u64) -> Result<()> {
        instructions::gateway::handle_reserve(ctx, request_id, owner, amount)
    }

    pub fn settle(ctx: Context<Settle>, actual: u64) -> Result<()> {
        instructions::gateway::handle_settle(ctx, actual)
    }

    pub fn settle_many<'info>(ctx: Context<'info, SettleMany<'info>>, actuals: Vec<u64>) -> Result<()> {
        instructions::gateway::handle_settle_many(ctx, actuals)
    }

    // ---- anyone
    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        instructions::gateway::handle_expire(ctx)
    }

    pub fn apply_pending(ctx: Context<ApplyPending>, field: ConfigField) -> Result<()> {
        instructions::admin::handle_apply_pending(ctx, field)
    }

    // ---- admin
    pub fn set_limit(ctx: Context<AdminOnly>, field: ConfigField, value: u64) -> Result<()> {
        instructions::admin::handle_set_limit(ctx, field, value)
    }

    pub fn set_pause(ctx: Context<AdminOnly>, target: PauseTarget, paused: bool) -> Result<()> {
        instructions::admin::handle_set_pause(ctx, target, paused)
    }

    pub fn propose_gateway_backup(ctx: Context<AdminOnly>, key: Pubkey) -> Result<()> {
        instructions::admin::handle_propose_gateway_backup(ctx, key)
    }

    pub fn propose_treasury(ctx: Context<ProposeTreasury>) -> Result<()> {
        instructions::admin::handle_propose_treasury(ctx)
    }

    pub fn cancel_pending(ctx: Context<AdminOnly>, field: ConfigField) -> Result<()> {
        instructions::admin::handle_cancel_pending(ctx, field)
    }

    pub fn revoke_gateway(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::handle_revoke_gateway(ctx)
    }

    pub fn activate_backup_gateway(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::handle_activate_backup_gateway(ctx)
    }

    pub fn shutdown(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::handle_shutdown(ctx)
    }

    pub fn sweep_surplus(ctx: Context<SweepSurplus>) -> Result<()> {
        instructions::admin::handle_sweep_surplus(ctx)
    }
}
