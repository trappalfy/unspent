use anchor_lang::prelude::*;

#[error_code]
pub enum UnspentError {
    #[msg("Only the program's upgrade authority can initialize")]
    NotUpgradeAuthority,
    #[msg("Mint does not meet the requirements")]
    InvalidMint,
    #[msg("Treasury must be a USDC token account other than the reserve")]
    InvalidTreasury,
    #[msg("Unspent is shut down")]
    ShutDown,
    #[msg("Unspent is not shut down")]
    NotShutDown,
    #[msg("Buying is paused")]
    BuyPaused,
    #[msg("Deposits are paused")]
    DepositPaused,
    #[msg("Reservations are paused")]
    GatewayPaused,
    #[msg("Amount must be positive")]
    ZeroAmount,
    #[msg("Amount is below the minimum")]
    AmountTooSmall,
    #[msg("Amount is above the per-instruction maximum")]
    AmountTooLarge,
    #[msg("Purchase would exceed the supply cap")]
    SupplyCapExceeded,
    #[msg("Not enough available balance")]
    InsufficientAvailable,
    #[msg("Reservation exceeds the per-request maximum")]
    ReservationTooLarge,
    #[msg("Reservation exceeds the per-user hold limit")]
    UserHoldLimitExceeded,
    #[msg("Signer is not the active gateway")]
    NotGateway,
    #[msg("Actual cost exceeds the reserved amount")]
    ActualExceedsReserved,
    #[msg("Burn cap for the current window exceeded")]
    BurnCapExceeded,
    #[msg("Reservation has not expired")]
    NotExpired,
    #[msg("Account is not a valid reservation")]
    InvalidReservation,
    #[msg("Account is not the reservation owner's user account")]
    InvalidUserAccount,
    #[msg("Reservation belongs to another owner")]
    WrongOwner,
    #[msg("Rent recipient does not match the reservation payer")]
    WrongPayer,
    #[msg("Duplicate reservation in batch")]
    DuplicateReservation,
    #[msg("Remaining accounts must come in pairs")]
    InvalidRemainingAccounts,
    #[msg("Batch actuals and accounts do not match")]
    BatchLengthMismatch,
    #[msg("Value is outside the allowed bounds")]
    OutOfBounds,
    #[msg("Field is not a limit")]
    NotALimit,
    #[msg("No pending change for this field")]
    NoPendingChange,
    #[msg("Pending change is not effective yet")]
    PendingNotReady,
    #[msg("No backup gateway is set")]
    NoBackupGateway,
    #[msg("Vault or reserve is below what it owes")]
    Insolvent,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
