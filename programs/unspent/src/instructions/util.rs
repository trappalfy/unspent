use crate::{
    constants::CONFIG_SEED,
    error::UnspentError,
    events::Expired,
    state::{Config, Reservation, UserAccount},
};
use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub fn config_seeds(bump: &u8) -> [&[u8]; 2] {
    [CONFIG_SEED, std::slice::from_ref(bump)]
}

/// Closes a program-owned account: all lamports to `dest`, data cleared, ownership back to the system program.
pub fn close_account<'info>(info: &AccountInfo<'info>, dest: &AccountInfo<'info>) -> Result<()> {
    dest.add_lamports(info.lamports())?;
    info.sub_lamports(info.lamports())?;
    info.assign(&system_program::ID);
    info.resize(0)?;
    Ok(())
}

pub fn is_closed(info: &AccountInfo) -> bool {
    info.owner == &system_program::ID && info.data_is_empty()
}

/// Transfer USDC out of the reserve, signed by the Config PDA.
pub fn reserve_transfer<'info>(
    token_program: &Program<'info, Token>,
    reserve: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    config: &Account<'info, Config>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds = config_seeds(&config.bump);
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer { from: reserve.to_account_info(), to, authority: config.to_account_info() },
            &[&seeds],
        ),
        amount,
    )
}

/// Burn credits from the vault, signed by the Config PDA.
pub fn vault_burn<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    config: &Account<'info, Config>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds = config_seeds(&config.bump);
    token::burn(
        CpiContext::new_with_signer(
            token_program.key(),
            Burn { mint: mint.to_account_info(), from: vault.to_account_info(), authority: config.to_account_info() },
            &[&seeds],
        ),
        amount,
    )
}

/// Mint credits, signed by the Config PDA (the mint authority).
pub fn mint_credits<'info>(
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    to: AccountInfo<'info>,
    config: &Account<'info, Config>,
    amount: u64,
) -> Result<()> {
    let seeds = config_seeds(&config.bump);
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.key(),
            MintTo { mint: mint.to_account_info(), to, authority: config.to_account_info() },
            &[&seeds],
        ),
        amount,
    )
}

/// Releases expired reservations passed as (Reservation, rent payer) pairs in remaining accounts (brief 6.3 withdraw).
/// Every reservation must belong to `user` and be expired; anything else fails the instruction.
pub fn release_expired_pairs<'info>(
    remaining: &'info [AccountInfo<'info>],
    config: &mut Config,
    user: &mut UserAccount,
    now: i64,
) -> Result<()> {
    require!(remaining.len().is_multiple_of(2), UnspentError::InvalidRemainingAccounts);
    let (pairs, _) = remaining.as_chunks::<2>();
    for [res_info, payer_info] in pairs {
        require!(res_info.is_writable && payer_info.is_writable, UnspentError::InvalidRemainingAccounts);
        let res = Account::<Reservation>::try_from(res_info).map_err(|_| error!(UnspentError::InvalidReservation))?;
        require_keys_eq!(res.owner, user.owner, UnspentError::WrongOwner);
        require!(now >= res.expires_at, UnspentError::NotExpired);
        require_keys_eq!(res.payer, payer_info.key(), UnspentError::WrongPayer);
        config.release_counters(user, res.amount)?;
        emit!(Expired { owner: res.owner, request_id: res.request_id, amount: res.amount });
        close_account(res_info, payer_info)?;
    }
    Ok(())
}
