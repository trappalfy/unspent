use crate::state::{ConfigField, PauseTarget};
use anchor_lang::prelude::*;

#[event]
pub struct CreditsBought {
    pub buyer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ReserveCapSet {
    pub owner: Pubkey,
    pub cap: u64,
}

#[event]
pub struct Reserved {
    pub owner: Pubkey,
    pub request_id: [u8; 32],
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct Settled {
    pub owner: Pubkey,
    pub request_id: [u8; 32],
    pub reserved: u64,
    pub actual: u64,
}

#[event]
pub struct Expired {
    pub owner: Pubkey,
    pub request_id: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct Redeemed {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ShutDown {}

#[event]
pub struct SurplusSwept {
    pub usdc: u64,
    pub credits: u64,
}

#[event]
pub struct LimitChanged {
    pub field: ConfigField,
    pub value: u64,
}

#[event]
pub struct PauseSet {
    pub target: PauseTarget,
    pub paused: bool,
}

#[event]
pub struct ChangeProposed {
    pub field: ConfigField,
    pub value: u64,
    pub key: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct ChangeApplied {
    pub field: ConfigField,
    pub value: u64,
    pub key: Pubkey,
}

#[event]
pub struct ChangeCancelled {
    pub field: ConfigField,
}

#[event]
pub struct GatewayRevoked {}

#[event]
pub struct BackupGatewayActivated {
    pub gateway: Pubkey,
}
