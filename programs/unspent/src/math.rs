use crate::error::UnspentError;
use anchor_lang::prelude::*;

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(UnspentError::MathOverflow))
}

pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| error!(UnspentError::MathOverflow))
}

pub fn add_secs(t: i64, secs: u64) -> Result<i64> {
    i64::try_from(secs)
        .ok()
        .and_then(|s| t.checked_add(s))
        .ok_or_else(|| error!(UnspentError::MathOverflow))
}
