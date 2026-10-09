use super::util::*;
use crate::{constants::*, error::UnspentError, events::*, math::*, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// ---------------------------------------------------------------- reserve

#[derive(Accounts)]
#[instruction(request_id: [u8; 32], owner: Pubkey)]
pub struct Reserve<'info> {
    #[account(mut)]
    pub gateway: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.as_ref()], bump = user.bump)]
    pub user: Box<Account<'info, UserAccount>>,
    /// A live reservation with the same request_id makes this init fail, so a request can't be reserved twice.
    #[account(
        init,
        payer = gateway,
        space = 8 + Reservation::INIT_SPACE,
        seeds = [RESERVATION_SEED, request_id.as_ref()],
        bump,
    )]
    pub reservation: Box<Account<'info, Reservation>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_reserve(ctx: Context<Reserve>, request_id: [u8; 32], owner: Pubkey, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    let c = &mut a.config;
    c.require_gateway(&a.gateway.key())?;
    require!(!c.shut_down, UnspentError::ShutDown);
    require!(!c.gateway_paused, UnspentError::GatewayPaused);
    require!(amount > 0, UnspentError::ZeroAmount);
    require!(amount <= c.max_reservation, UnspentError::ReservationTooLarge);
    require!(amount <= a.user.available()?, UnspentError::InsufficientAvailable);
    require!(add(a.user.reserved, amount)? <= c.hold_limit(&a.user), UnspentError::UserHoldLimitExceeded);

    let expires_at = add_secs(Clock::get()?.unix_timestamp, c.reservation_ttl)?;
    let r = &mut a.reservation;
    r.owner = owner;
    r.request_id = request_id;
    r.amount = amount;
    r.expires_at = expires_at;
    r.payer = a.gateway.key();
    r.bump = ctx.bumps.reservation;
    a.user.reserved = add(a.user.reserved, amount)?;
    c.active_reserved = add(c.active_reserved, amount)?;
    emit!(Reserved { owner, request_id, amount, expires_at });
    Ok(())
}

// ---------------------------------------------------------------- settle

/// Burns `actual` (≤ reserved) and releases the rest; actual = 0 is a plain release. Works after shutdown.
#[derive(Accounts)]
pub struct Settle<'info> {
    pub gateway: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = rent_payer)]
    pub reservation: Box<Account<'info, Reservation>>,
    /// CHECK: receives the reservation's rent; must be the account that paid it.
    #[account(mut, address = reservation.payer @ UnspentError::WrongPayer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [USER_SEED, reservation.owner.as_ref()], bump = user.bump)]
    pub user: Box<Account<'info, UserAccount>>,
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

pub fn handle_settle(ctx: Context<Settle>, actual: u64) -> Result<()> {
    let a = ctx.accounts;
    a.config.require_gateway(&a.gateway.key())?;
    let now = Clock::get()?.unix_timestamp;
    let reserved = a.reservation.amount;
    require!(actual <= reserved, UnspentError::ActualExceedsReserved);
    require!(a.config.try_burn(now, actual)?, UnspentError::BurnCapExceeded);
    a.config.settle_counters(&mut a.user, reserved, actual)?;

    vault_burn(&a.token_program, &a.vault, &a.credit_mint, &a.config, actual)?;
    reserve_transfer(&a.token_program, &a.reserve, a.treasury.to_account_info(), &a.config, actual)?;
    emit!(Settled { owner: a.reservation.owner, request_id: a.reservation.request_id, reserved, actual });
    Ok(())
}

// ---------------------------------------------------------------- settle_many

/// Batch settlement. Remaining accounts: (Reservation, UserAccount) pairs, one per entry of `actuals`.
/// - every reservation is checked and closed before the next one; a reservation listed twice fails the batch;
/// - an already closed reservation, one whose rent payer isn't `rent_payer`, or one that doesn't fit the burn window
///   is skipped and stays with the gateway's queue;
/// - one burn and one USDC transfer cover the whole batch.
#[derive(Accounts)]
pub struct SettleMany<'info> {
    pub gateway: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: receives rent of the reservations it paid for; entries paid by anyone else are skipped.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
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

pub fn handle_settle_many<'info>(ctx: Context<'info, SettleMany<'info>>, actuals: Vec<u64>) -> Result<()> {
    let a = ctx.accounts;
    a.config.require_gateway(&a.gateway.key())?;
    let rem = ctx.remaining_accounts;
    require!(rem.len().is_multiple_of(2), UnspentError::InvalidRemainingAccounts);
    require!(rem.len() / 2 == actuals.len(), UnspentError::BatchLengthMismatch);
    let now = Clock::get()?.unix_timestamp;

    let mut seen: Vec<Pubkey> = Vec::with_capacity(actuals.len());
    let mut total: u64 = 0;
    let (pairs, _) = rem.as_chunks::<2>();
    for ([res_info, user_info], &actual) in pairs.iter().zip(actuals.iter()) {
        require!(!seen.contains(res_info.key), UnspentError::DuplicateReservation);
        seen.push(res_info.key());
        if is_closed(res_info) {
            continue;
        }
        require!(res_info.is_writable && user_info.is_writable, UnspentError::InvalidRemainingAccounts);
        let res = Account::<Reservation>::try_from(res_info).map_err(|_| error!(UnspentError::InvalidReservation))?;
        // A program-owned UserAccount whose owner matches is the reservation owner's PDA: only `deposit` creates
        // UserAccounts, at [USER_SEED, owner]. Reloaded every entry, so one user can appear several times.
        let mut user =
            Account::<UserAccount>::try_from(user_info).map_err(|_| error!(UnspentError::InvalidUserAccount))?;
        require_keys_eq!(user.owner, res.owner, UnspentError::InvalidUserAccount);
        require!(actual <= res.amount, UnspentError::ActualExceedsReserved);
        if res.payer != a.rent_payer.key() || !a.config.try_burn(now, actual)? {
            continue;
        }
        a.config.settle_counters(&mut user, res.amount, actual)?;
        user.exit(&crate::ID)?;
        total = add(total, actual)?;
        emit!(Settled { owner: res.owner, request_id: res.request_id, reserved: res.amount, actual });
        close_account(res_info, &a.rent_payer.to_account_info())?;
    }

    vault_burn(&a.token_program, &a.vault, &a.credit_mint, &a.config, total)?;
    reserve_transfer(&a.token_program, &a.reserve, a.treasury.to_account_info(), &a.config, total)?;
    Ok(())
}

// ---------------------------------------------------------------- expire

/// Anyone can release a reservation after it expires; rent goes back to whoever paid it.
#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = rent_payer)]
    pub reservation: Box<Account<'info, Reservation>>,
    /// CHECK: receives the reservation's rent; must be the account that paid it.
    #[account(mut, address = reservation.payer @ UnspentError::WrongPayer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [USER_SEED, reservation.owner.as_ref()], bump = user.bump)]
    pub user: Box<Account<'info, UserAccount>>,
}

pub fn handle_expire(ctx: Context<Expire>) -> Result<()> {
    let a = ctx.accounts;
    require!(Clock::get()?.unix_timestamp >= a.reservation.expires_at, UnspentError::NotExpired);
    a.config.release_counters(&mut a.user, a.reservation.amount)?;
    emit!(Expired { owner: a.reservation.owner, request_id: a.reservation.request_id, amount: a.reservation.amount });
    Ok(())
}
