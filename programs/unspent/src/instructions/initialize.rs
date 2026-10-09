use crate::{constants::*, error::UnspentError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeParams {
    pub admin: Pubkey,
    pub gateway: Option<Pubkey>,
    pub max_buy_per_ix: u64,
    pub supply_cap: u64,
    pub max_reservation: u64,
    pub max_reserved_per_user: u64,
    pub burn_cap_per_window: u64,
    pub reservation_ttl: u64,
    pub admin_delay: u64,
}

/// Only the program's upgrade authority can initialize, so nobody can front-run the deployer (brief 6.3).
/// The credit mint must be fresh, decimals 6, without freeze authority, and already owned by the Config PDA.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ UnspentError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Unspent>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ UnspentError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        constraint = credit_mint.supply == 0 @ UnspentError::InvalidMint,
        constraint = credit_mint.decimals == CREDIT_DECIMALS @ UnspentError::InvalidMint,
        constraint = credit_mint.freeze_authority.is_none() @ UnspentError::InvalidMint,
        constraint = credit_mint.mint_authority == Some(config.key()).into() @ UnspentError::InvalidMint,
    )]
    pub credit_mint: Box<Account<'info, Mint>>,
    #[account(address = USDC_MINT @ UnspentError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = authority, seeds = [RESERVE_SEED], bump, token::mint = usdc_mint, token::authority = config)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, seeds = [VAULT_SEED], bump, token::mint = credit_mint, token::authority = config)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(constraint = treasury.mint == usdc_mint.key() @ UnspentError::InvalidTreasury)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, p: InitializeParams) -> Result<()> {
    let a = ctx.accounts;
    let c = &mut a.config;
    c.admin = p.admin;
    c.gateway = p.gateway;
    c.gateway_backup = None;
    c.treasury = a.treasury.key();
    c.credit_mint = a.credit_mint.key();
    c.usdc_mint = a.usdc_mint.key();
    c.reserve = a.reserve.key();
    c.vault = a.vault.key();
    c.bump = ctx.bumps.config;
    for (field, value) in [
        (ConfigField::MaxBuyPerIx, p.max_buy_per_ix),
        (ConfigField::SupplyCap, p.supply_cap),
        (ConfigField::MaxReservation, p.max_reservation),
        (ConfigField::MaxReservedPerUser, p.max_reserved_per_user),
        (ConfigField::BurnCapPerWindow, p.burn_cap_per_window),
        (ConfigField::ReservationTtl, p.reservation_ttl),
        (ConfigField::AdminDelay, p.admin_delay),
    ] {
        c.set_limit_value(field, value)?;
    }
    Ok(())
}
