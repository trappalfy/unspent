use super::util::*;
use crate::{constants::*, error::UnspentError, events::*, math::*, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// Risk-reducing actions take effect immediately; risk-increasing ones wait admin_delay (brief 6.2).

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
}

/// Lowering a limit applies now and drops any pending raise of the same field; raising it, or any change of
/// admin_delay, becomes a pending change of that field only.
pub fn handle_set_limit(ctx: Context<AdminOnly>, field: ConfigField, value: u64) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(field.is_limit(), UnspentError::NotALimit);
    let (lo, hi) = field.bounds()?;
    require!(value >= lo && value <= hi, UnspentError::OutOfBounds);
    if field == ConfigField::AdminDelay || value > c.limit(field)? {
        let effective_at = add_secs(Clock::get()?.unix_timestamp, c.admin_delay)?;
        c.pending[field.index()] = PendingChange { value, key: Pubkey::default(), effective_at };
        emit!(ChangeProposed { field, value, key: Pubkey::default(), effective_at });
    } else {
        c.set_limit_value(field, value)?;
        c.pending[field.index()] = PendingChange::default();
        emit!(LimitChanged { field, value });
    }
    Ok(())
}

pub fn handle_set_pause(ctx: Context<AdminOnly>, target: PauseTarget, paused: bool) -> Result<()> {
    let c = &mut ctx.accounts.config;
    match target {
        PauseTarget::Buy => c.buy_paused = paused,
        PauseTarget::Deposit => c.deposit_paused = paused,
        PauseTarget::Gateway => c.gateway_paused = paused,
    }
    emit!(PauseSet { target, paused });
    Ok(())
}

fn propose_key(c: &mut Config, field: ConfigField, key: Pubkey) -> Result<()> {
    let effective_at = add_secs(Clock::get()?.unix_timestamp, c.admin_delay)?;
    c.pending[field.index()] = PendingChange { value: 0, key, effective_at };
    emit!(ChangeProposed { field, value: 0, key, effective_at });
    Ok(())
}

pub fn handle_propose_gateway_backup(ctx: Context<AdminOnly>, key: Pubkey) -> Result<()> {
    propose_key(&mut ctx.accounts.config, ConfigField::GatewayBackup, key)
}

#[derive(Accounts)]
pub struct ProposeTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        constraint = new_treasury.mint == config.usdc_mint @ UnspentError::InvalidTreasury,
        constraint = new_treasury.key() != config.reserve @ UnspentError::InvalidTreasury,
    )]
    pub new_treasury: Box<Account<'info, TokenAccount>>,
}

pub fn handle_propose_treasury(ctx: Context<ProposeTreasury>) -> Result<()> {
    let key = ctx.accounts.new_treasury.key();
    propose_key(&mut ctx.accounts.config, ConfigField::Treasury, key)
}

pub fn handle_cancel_pending(ctx: Context<AdminOnly>, field: ConfigField) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(c.pending[field.index()].effective_at != 0, UnspentError::NoPendingChange);
    c.pending[field.index()] = PendingChange::default();
    emit!(ChangeCancelled { field });
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyPending<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// Anyone can apply a pending change once it is effective; only that field changes.
pub fn handle_apply_pending(ctx: Context<ApplyPending>, field: ConfigField) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let p = c.pending[field.index()];
    require!(p.effective_at != 0, UnspentError::NoPendingChange);
    require!(Clock::get()?.unix_timestamp >= p.effective_at, UnspentError::PendingNotReady);
    match field {
        ConfigField::GatewayBackup => c.gateway_backup = Some(p.key),
        ConfigField::Treasury => c.treasury = p.key,
        _ => c.set_limit_value(field, p.value)?,
    }
    c.pending[field.index()] = PendingChange::default();
    emit!(ChangeApplied { field, value: p.value, key: p.key });
    Ok(())
}

pub fn handle_revoke_gateway(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.config.gateway = None;
    emit!(GatewayRevoked {});
    Ok(())
}

/// Switches to the pre-approved backup key at once, so replacing a compromised key needs no admin_delay downtime.
pub fn handle_activate_backup_gateway(ctx: Context<AdminOnly>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let backup = c.gateway_backup.ok_or_else(|| error!(UnspentError::NoBackupGateway))?;
    c.gateway = Some(backup);
    c.gateway_backup = None;
    emit!(BackupGatewayActivated { gateway: backup });
    Ok(())
}

/// Irreversible: stops buys, deposits and new reservations; opens redeem. Withdraw, settle and expire keep working.
pub fn handle_shutdown(ctx: Context<AdminOnly>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(!c.shut_down, UnspentError::ShutDown);
    c.shut_down = true;
    emit!(ShutDown {});
    Ok(())
}

// ---------------------------------------------------------------- sweep_surplus

#[derive(Accounts)]
pub struct SweepSurplus<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = config.credit_mint)]
    pub credit_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.reserve)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.treasury @ UnspentError::InvalidTreasury)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Burns vault credits beyond users' balances (sent around `deposit`), then moves USDC beyond the supply to the
/// treasury. Users' balances, including what is reserved, are never touched.
pub fn handle_sweep_surplus(ctx: Context<SweepSurplus>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.vault.amount >= a.config.total_user_balance, UnspentError::Insolvent);
    let credits = sub(a.vault.amount, a.config.total_user_balance)?;
    vault_burn(&a.token_program, &a.vault, &a.credit_mint, &a.config, credits)?;
    a.credit_mint.reload()?;
    require!(a.reserve.amount >= a.credit_mint.supply, UnspentError::Insolvent);
    let usdc = sub(a.reserve.amount, a.credit_mint.supply)?;
    reserve_transfer(&a.token_program, &a.reserve, a.treasury.to_account_info(), &a.config, usdc)?;
    a.config.total_swept_credits = add(a.config.total_swept_credits, credits)?;
    a.config.total_swept_usdc = add(a.config.total_swept_usdc, usdc)?;
    emit!(SurplusSwept { usdc, credits });
    Ok(())
}
