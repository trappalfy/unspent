use super::util::*;
use crate::{constants::*, error::UnspentError, events::*, math::*, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

// ---------------------------------------------------------------- buy_credits

#[derive(Accounts)]
pub struct BuyCredits<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = config.credit_mint)]
    pub credit_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.reserve)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    /// Credits go only to the buyer's own token account.
    #[account(mut, token::mint = config.credit_mint, token::authority = buyer)]
    pub buyer_credits: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// amount USDC → reserve, amount credits minted to the buyer, 1:1 in base units.
pub fn handle_buy_credits(ctx: Context<BuyCredits>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    let c = &a.config;
    require!(!c.shut_down, UnspentError::ShutDown);
    require!(!c.buy_paused, UnspentError::BuyPaused);
    require!(amount >= MIN_BUY, UnspentError::AmountTooSmall);
    require!(amount <= c.max_buy_per_ix, UnspentError::AmountTooLarge);
    require!(add(a.credit_mint.supply, amount)? <= c.supply_cap, UnspentError::SupplyCapExceeded);

    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer {
                from: a.buyer_usdc.to_account_info(),
                to: a.reserve.to_account_info(),
                authority: a.buyer.to_account_info(),
            },
        ),
        amount,
    )?;
    mint_credits(&a.token_program, &a.credit_mint, a.buyer_credits.to_account_info(), c, amount)?;
    emit!(CreditsBought { buyer: a.buyer.key(), amount });
    Ok(())
}

// ---------------------------------------------------------------- deposit

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub user: Box<Account<'info, UserAccount>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.credit_mint, token::authority = owner)]
    pub owner_credits: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.config.shut_down, UnspentError::ShutDown);
    require!(!a.config.deposit_paused, UnspentError::DepositPaused);
    require!(amount > 0, UnspentError::ZeroAmount);
    if a.user.owner == Pubkey::default() {
        a.user.owner = a.owner.key();
        a.user.bump = ctx.bumps.user;
    }
    token::transfer(
        CpiContext::new(
            a.token_program.key(),
            Transfer {
                from: a.owner_credits.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
    )?;
    a.user.balance = add(a.user.balance, amount)?;
    a.config.total_user_balance = add(a.config.total_user_balance, amount)?;
    emit!(Deposited { owner: a.owner.key(), amount });
    Ok(())
}

// ---------------------------------------------------------------- withdraw

/// Remaining accounts: (expired Reservation, its rent payer) pairs to close first. Works in pause and after shutdown.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user.bump, has_one = owner)]
    pub user: Box<Account<'info, UserAccount>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.credit_mint, token::authority = owner)]
    pub owner_credits: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw<'info>(ctx: Context<'info, Withdraw<'info>>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    release_expired_pairs(ctx.remaining_accounts, &mut a.config, &mut a.user, now)?;
    require!(amount > 0, UnspentError::ZeroAmount);
    require!(amount <= a.user.available()?, UnspentError::InsufficientAvailable);

    let seeds = config_seeds(&a.config.bump);
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer {
                from: a.vault.to_account_info(),
                to: a.owner_credits.to_account_info(),
                authority: a.config.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
    )?;
    a.user.balance = sub(a.user.balance, amount)?;
    a.config.total_user_balance = sub(a.config.total_user_balance, amount)?;
    emit!(Withdrawn { owner: a.owner.key(), amount });
    Ok(())
}

// ---------------------------------------------------------------- set_my_reserve_cap

#[derive(Accounts)]
pub struct SetMyReserveCap<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user.bump, has_one = owner)]
    pub user: Account<'info, UserAccount>,
}

pub fn handle_set_my_reserve_cap(ctx: Context<SetMyReserveCap>, cap: u64) -> Result<()> {
    ctx.accounts.user.reserve_cap = cap;
    emit!(ReserveCapSet { owner: ctx.accounts.owner.key(), cap });
    Ok(())
}

// ---------------------------------------------------------------- redeem

/// After shutdown only: burn credits from the holder's wallet, pay the same amount of USDC from the reserve (brief 5.7).
#[derive(Accounts)]
pub struct Redeem<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = config.credit_mint)]
    pub credit_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.reserve)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.credit_mint, token::authority = owner)]
    pub owner_credits: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(a.config.shut_down, UnspentError::NotShutDown);
    require!(amount > 0, UnspentError::ZeroAmount);
    token::burn(
        CpiContext::new(
            a.token_program.key(),
            Burn {
                mint: a.credit_mint.to_account_info(),
                from: a.owner_credits.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
    )?;
    reserve_transfer(&a.token_program, &a.reserve, a.owner_usdc.to_account_info(), &a.config, amount)?;
    a.config.total_redeemed = add(a.config.total_redeemed, amount)?;
    emit!(Redeemed { owner: a.owner.key(), amount });
    Ok(())
}
