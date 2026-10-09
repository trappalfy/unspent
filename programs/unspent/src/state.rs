use crate::{constants::*, error::UnspentError, math::*};
use anchor_lang::prelude::*;

/// Fields that can change through `set_limit`, `propose_*` and `apply_pending` (brief 6.1, 6.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConfigField {
    MaxBuyPerIx,
    SupplyCap,
    MaxReservation,
    MaxReservedPerUser,
    BurnCapPerWindow,
    ReservationTtl,
    AdminDelay,
    GatewayBackup,
    Treasury,
}

pub const PENDING_SLOTS: usize = 9;

impl ConfigField {
    pub fn index(self) -> usize {
        self as usize
    }

    pub fn is_limit(self) -> bool {
        !matches!(self, ConfigField::GatewayBackup | ConfigField::Treasury)
    }

    /// Inclusive bounds for limit fields (credits in μcr, durations in seconds).
    pub fn bounds(self) -> Result<(u64, u64)> {
        Ok(match self {
            ConfigField::MaxBuyPerIx => (0, MAX_BUY_PER_IX_BOUND),
            ConfigField::SupplyCap => (0, SUPPLY_CAP_BOUND),
            ConfigField::MaxReservation => (0, MAX_RESERVATION_BOUND),
            ConfigField::MaxReservedPerUser => (0, MAX_RESERVED_PER_USER_BOUND),
            ConfigField::BurnCapPerWindow => (0, BURN_CAP_BOUND),
            ConfigField::ReservationTtl => (RESERVATION_TTL_MIN, RESERVATION_TTL_MAX),
            ConfigField::AdminDelay => (ADMIN_DELAY_MIN, ADMIN_DELAY_MAX),
            _ => return err!(UnspentError::NotALimit),
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PauseTarget {
    Buy,
    Deposit,
    Gateway,
}

/// A delayed change of one field. `effective_at == 0` means no change is pending.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingChange {
    pub value: u64,
    pub key: Pubkey,
    pub effective_at: i64,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Config {
    /// Squads multisig without time lock: immediate risk-reducing actions; risk-increasing ones go through admin_delay.
    pub admin: Pubkey,
    pub gateway: Option<Pubkey>,
    pub gateway_backup: Option<Pubkey>,
    /// USDC token account that receives the USDC of burned credits.
    pub treasury: Pubkey,
    pub credit_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub reserve: Pubkey,
    pub vault: Pubkey,
    pub buy_paused: bool,
    pub deposit_paused: bool,
    pub gateway_paused: bool,
    pub shut_down: bool,
    pub max_buy_per_ix: u64,
    pub supply_cap: u64,
    pub max_reservation: u64,
    pub max_reserved_per_user: u64,
    pub burn_cap_per_window: u64,
    pub reservation_ttl: u64,
    pub admin_delay: u64,
    pub window_start: i64,
    pub window_burned: u64,
    /// One slot per ConfigField, indexed by ConfigField::index().
    pub pending: [PendingChange; PENDING_SLOTS],
    pub total_user_balance: u64,
    pub active_reserved: u64,
    pub total_burned: u64,
    pub total_released: u64,
    pub total_redeemed: u64,
    pub total_swept_usdc: u64,
    pub total_swept_credits: u64,
    pub bump: u8,
}

impl Config {
    pub fn limit(&self, field: ConfigField) -> Result<u64> {
        Ok(match field {
            ConfigField::MaxBuyPerIx => self.max_buy_per_ix,
            ConfigField::SupplyCap => self.supply_cap,
            ConfigField::MaxReservation => self.max_reservation,
            ConfigField::MaxReservedPerUser => self.max_reserved_per_user,
            ConfigField::BurnCapPerWindow => self.burn_cap_per_window,
            ConfigField::ReservationTtl => self.reservation_ttl,
            ConfigField::AdminDelay => self.admin_delay,
            _ => return err!(UnspentError::NotALimit),
        })
    }

    pub fn set_limit_value(&mut self, field: ConfigField, value: u64) -> Result<()> {
        let (lo, hi) = field.bounds()?;
        require!(value >= lo && value <= hi, UnspentError::OutOfBounds);
        match field {
            ConfigField::MaxBuyPerIx => self.max_buy_per_ix = value,
            ConfigField::SupplyCap => self.supply_cap = value,
            ConfigField::MaxReservation => self.max_reservation = value,
            ConfigField::MaxReservedPerUser => self.max_reserved_per_user = value,
            ConfigField::BurnCapPerWindow => self.burn_cap_per_window = value,
            ConfigField::ReservationTtl => self.reservation_ttl = value,
            ConfigField::AdminDelay => self.admin_delay = value,
            _ => return err!(UnspentError::NotALimit),
        }
        Ok(())
    }

    pub fn require_gateway(&self, signer: &Pubkey) -> Result<()> {
        require!(self.gateway == Some(*signer), UnspentError::NotGateway);
        Ok(())
    }

    /// How much the gateway may hold for this user at once: the global limit, or the user's own lower cap.
    pub fn hold_limit(&self, user: &UserAccount) -> u64 {
        if user.reserve_cap == 0 {
            self.max_reserved_per_user
        } else {
            user.reserve_cap.min(self.max_reserved_per_user)
        }
    }

    /// Counts `amount` against the 10-minute burn window. Returns false, leaving state untouched, if the cap would be exceeded.
    /// A release (amount 0) always passes, even after the admin lowers the cap below what this window already burned.
    pub fn try_burn(&mut self, now: i64, amount: u64) -> Result<bool> {
        if amount == 0 {
            return Ok(true);
        }
        if now >= self.window_start.saturating_add(BURN_WINDOW_SECS) {
            self.window_start = now;
            self.window_burned = 0;
        }
        let next = add(self.window_burned, amount)?;
        if next > self.burn_cap_per_window {
            return Ok(false);
        }
        self.window_burned = next;
        Ok(true)
    }

    /// Bookkeeping of a settlement: burn `actual` of a reservation of `reserved` (brief 6.3 counter table).
    pub fn settle_counters(&mut self, user: &mut UserAccount, reserved: u64, actual: u64) -> Result<()> {
        require!(actual <= reserved, UnspentError::ActualExceedsReserved);
        user.reserved = sub(user.reserved, reserved)?;
        user.balance = sub(user.balance, actual)?;
        self.total_user_balance = sub(self.total_user_balance, actual)?;
        self.active_reserved = sub(self.active_reserved, reserved)?;
        self.total_burned = add(self.total_burned, actual)?;
        self.total_released = add(self.total_released, actual)?;
        Ok(())
    }

    /// Bookkeeping of a release without burning (expire).
    pub fn release_counters(&mut self, user: &mut UserAccount, reserved: u64) -> Result<()> {
        user.reserved = sub(user.reserved, reserved)?;
        self.active_reserved = sub(self.active_reserved, reserved)?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct UserAccount {
    pub owner: Pubkey,
    /// Credits of this user in the vault, including what is reserved.
    pub balance: u64,
    /// Part of balance held for running requests.
    pub reserved: u64,
    /// The user's own hold limit; 0 = the global max_reserved_per_user.
    pub reserve_cap: u64,
    pub bump: u8,
}

impl UserAccount {
    pub fn available(&self) -> Result<u64> {
        sub(self.balance, self.reserved)
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Reservation {
    /// First field after the discriminator so wallets can find their reservations with getProgramAccounts (memcmp at 8).
    pub owner: Pubkey,
    pub request_id: [u8; 32],
    pub amount: u64,
    pub expires_at: i64,
    /// Who paid the rent; gets it back when the reservation closes.
    pub payer: Pubkey,
    pub bump: u8,
}
