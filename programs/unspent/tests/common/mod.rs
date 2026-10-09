//! LiteSVM test harness for the unspent program: deploys the program with a real upgrade authority, places a mock
//! USDC mint at the mainnet USDC address, and builds every instruction.
#![allow(dead_code)]

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{bpf_loader_upgradeable, instruction::Instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token;
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_account::Account;
use solana_instruction::{error::InstructionError, AccountMeta};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use unspent::{
    constants::*, error::UnspentError, ConfigField, InitializeParams, PauseTarget, Reservation, UserAccount,
};

pub use unspent::Config;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const C: u64 = CREDIT; // 1 credit in μcr
pub const START_TS: i64 = 1_790_000_000;

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &unspent::ID).0
}

pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn reserve_pda() -> Pubkey {
    pda(&[RESERVE_SEED])
}
pub fn vault_pda() -> Pubkey {
    pda(&[VAULT_SEED])
}
pub fn user_pda(owner: &Pubkey) -> Pubkey {
    pda(&[USER_SEED, owner.as_ref()])
}
pub fn res_pda(request_id: &[u8; 32]) -> Pubkey {
    pda(&[RESERVATION_SEED, request_id.as_ref()])
}
pub fn program_data_pda() -> Pubkey {
    Pubkey::find_program_address(&[unspent::ID.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// Default launch parameters (Q7, Q16, Q17).
pub fn default_params(admin: Pubkey, gateway: Option<Pubkey>) -> InitializeParams {
    InitializeParams {
        admin,
        gateway,
        max_buy_per_ix: 100_000 * C,
        supply_cap: 250_000 * C,
        max_reservation: 25 * C,
        max_reserved_per_user: 50 * C,
        burn_cap_per_window: 5_000 * C,
        reservation_ttl: 3_600,
        admin_delay: 48 * 3_600,
    }
}

pub fn rid(n: u64) -> [u8; 32] {
    let mut id = [7u8; 32];
    id[..8].copy_from_slice(&n.to_le_bytes());
    id
}

/// Anchor custom error code of an UnspentError.
pub fn code(e: UnspentError) -> u32 {
    u32::from(e)
}

pub fn custom_code(res: &TxResult) -> Option<u32> {
    match res {
        Err(f) => match &f.err {
            solana_transaction::TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
pub fn assert_err(res: TxResult, e: UnspentError) {
    let want = code(e);
    match &res {
        Ok(_) => panic!("expected {e:?} ({want}), transaction succeeded"),
        Err(f) => assert_eq!(custom_code(&res), Some(want), "expected {e:?}, got {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

/// Anchor framework error (e.g. 2006 ConstraintSeeds, 3012 AccountNotInitialized).
#[track_caller]
pub fn assert_anchor_err(res: TxResult, e: anchor_lang::error::ErrorCode) {
    let want = u32::from(e);
    match &res {
        Ok(_) => panic!("expected anchor error {e:?}, transaction succeeded"),
        Err(f) => assert_eq!(custom_code(&res), Some(want), "expected {e:?}, got {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

#[track_caller]
pub fn assert_ok(res: TxResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(f) => panic!("transaction failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

#[track_caller]
pub fn assert_fails(res: TxResult) {
    assert!(res.is_err(), "expected failure, transaction succeeded");
}

pub struct User {
    pub kp: Keypair,
    pub usdc: Pubkey,
    pub credits: Pubkey,
}

impl User {
    pub fn key(&self) -> Pubkey {
        self.kp.pubkey()
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub deployer: Keypair,
    pub admin: Keypair,
    pub gateway: Keypair,
    pub usdc_auth: Keypair,
    pub credit_mint: Pubkey,
    pub treasury_owner: Keypair,
    pub treasury: Pubkey,
}

impl Env {
    /// Program deployed, mints and treasury created, nothing initialized.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/unspent.so"));
        svm.add_program(unspent::ID, bytes).unwrap();
        let deployer = Keypair::new();
        // LiteSVM deploys with no upgrade authority; set it to the deployer. ProgramData layout:
        // [0..4] tag, [4..12] slot, [12] Option tag, [13..45] authority.
        let pd = program_data_pda();
        let mut acc = svm.get_account(&pd).unwrap();
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(deployer.pubkey().as_ref());
        svm.set_account(pd, acc).unwrap();

        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = START_TS;
        svm.set_sysvar(&clock);

        let admin = Keypair::new();
        let gateway = Keypair::new();
        let usdc_auth = Keypair::new();
        let treasury_owner = Keypair::new();
        for k in [&deployer, &admin, &gateway, &usdc_auth, &treasury_owner] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        let mut env = Env {
            svm,
            deployer,
            admin,
            gateway,
            usdc_auth,
            credit_mint: Pubkey::new_unique(),
            treasury_owner,
            treasury: Pubkey::new_unique(),
        };
        let usdc_auth = env.usdc_auth.pubkey();
        env.put_mint(USDC_MINT, Some(usdc_auth), None, 6, 0);
        env.put_mint(env.credit_mint, Some(config_pda()), None, CREDIT_DECIMALS, 0);
        let owner = env.treasury_owner.pubkey();
        env.put_token_account(env.treasury, USDC_MINT, owner, 0);
        env
    }

    /// Deployed and initialized with default parameters.
    pub fn ready() -> Self {
        let mut env = Self::new();
        let params = default_params(env.admin.pubkey(), Some(env.gateway.pubkey()));
        assert_ok(env.initialize(params));
        env
    }

    // ------------------------------------------------------------ raw state

    pub fn put_mint(&mut self, at: Pubkey, authority: Option<Pubkey>, freeze: Option<Pubkey>, decimals: u8, supply: u64) {
        let m = spl_token::state::Mint {
            mint_authority: authority.map_or(COption::None, COption::Some),
            supply,
            decimals,
            is_initialized: true,
            freeze_authority: freeze.map_or(COption::None, COption::Some),
        };
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        m.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(at, Account { lamports, data, owner: spl_token::ID, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    pub fn put_token_account(&mut self, at: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let a = spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        a.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(at, Account { lamports, data, owner: spl_token::ID, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    /// Freezes or thaws a token account in place (simulates the USDC issuer's freeze authority).
    pub fn set_frozen(&mut self, at: Pubkey, frozen: bool) {
        let mut acc = self.svm.get_account(&at).unwrap();
        let mut a = spl_token::state::Account::unpack(&acc.data).unwrap();
        a.state = if frozen { spl_token::state::AccountState::Frozen } else { spl_token::state::AccountState::Initialized };
        a.pack_into_slice(&mut acc.data);
        self.svm.set_account(at, acc).unwrap();
    }

    pub fn token_balance(&self, at: &Pubkey) -> u64 {
        let acc = self.svm.get_account(at).unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    pub fn supply(&self, mint: &Pubkey) -> u64 {
        let acc = self.svm.get_account(mint).unwrap();
        spl_token::state::Mint::unpack(&acc.data).unwrap().supply
    }

    pub fn credit_supply(&self) -> u64 {
        self.supply(&self.credit_mint)
    }

    pub fn lamports(&self, at: &Pubkey) -> u64 {
        self.svm.get_account(at).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn exists(&self, at: &Pubkey) -> bool {
        self.svm.get_account(at).is_some_and(|a| a.lamports > 0)
    }

    fn read<T: AccountDeserialize>(&self, at: &Pubkey) -> Option<T> {
        let acc = self.svm.get_account(at)?;
        if acc.lamports == 0 || acc.data.is_empty() {
            return None;
        }
        T::try_deserialize(&mut acc.data.as_slice()).ok()
    }

    pub fn config(&self) -> Config {
        self.read(&config_pda()).expect("config")
    }
    pub fn user_account(&self, owner: &Pubkey) -> Option<UserAccount> {
        self.read(&user_pda(owner))
    }
    pub fn reservation(&self, request_id: &[u8; 32]) -> Option<Reservation> {
        self.read(&res_pda(request_id))
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    /// New user with SOL, a USDC account holding `usdc` and an empty credit account.
    pub fn user(&mut self, usdc: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let (usdc_acc, credit_acc) = (Pubkey::new_unique(), Pubkey::new_unique());
        self.put_token_account(usdc_acc, USDC_MINT, kp.pubkey(), 0);
        self.put_token_account(credit_acc, self.credit_mint, kp.pubkey(), 0);
        if usdc > 0 {
            self.mint_usdc(&usdc_acc, usdc);
        }
        User { kp, usdc: usdc_acc, credits: credit_acc }
    }

    pub fn mint_usdc(&mut self, to: &Pubkey, amount: u64) {
        let auth = self.usdc_auth.pubkey();
        let ix = spl_token::instruction::mint_to(&spl_token::ID, &USDC_MINT, to, &auth, &[], amount).unwrap();
        let kp = self.usdc_auth.insecure_clone();
        assert_ok(self.send(&[ix], &[&kp]));
    }

    /// User with `n` credits deposited on the API balance.
    pub fn funded_user(&mut self, n: u64) -> User {
        let u = self.user(n);
        assert_ok(self.buy(&u, n));
        assert_ok(self.deposit(&u, n));
        u
    }

    // ------------------------------------------------------------ transactions

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let payer = signers[0].pubkey();
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    fn ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
        Instruction { program_id: unspent::ID, accounts: metas, data }
    }

    pub fn ix_initialize(&self, authority: &Pubkey, params: InitializeParams) -> Instruction {
        Self::ix(
            unspent::instruction::Initialize { params }.data(),
            unspent::accounts::Initialize {
                authority: *authority,
                program: unspent::ID,
                program_data: program_data_pda(),
                config: config_pda(),
                credit_mint: self.credit_mint,
                usdc_mint: USDC_MINT,
                reserve: reserve_pda(),
                vault: vault_pda(),
                treasury: self.treasury,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn initialize(&mut self, params: InitializeParams) -> TxResult {
        let ix = self.ix_initialize(&self.deployer.pubkey(), params);
        let kp = self.deployer.insecure_clone();
        self.send(&[ix], &[&kp])
    }

    pub fn ix_buy(&self, buyer: &Pubkey, buyer_usdc: Pubkey, buyer_credits: Pubkey, amount: u64) -> Instruction {
        Self::ix(
            unspent::instruction::BuyCredits { amount }.data(),
            unspent::accounts::BuyCredits {
                buyer: *buyer,
                config: config_pda(),
                credit_mint: self.credit_mint,
                reserve: reserve_pda(),
                buyer_usdc,
                buyer_credits,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn buy(&mut self, u: &User, amount: u64) -> TxResult {
        let ix = self.ix_buy(&u.key(), u.usdc, u.credits, amount);
        self.send(&[ix], &[&u.kp])
    }

    pub fn ix_deposit(&self, owner: &Pubkey, owner_credits: Pubkey, amount: u64) -> Instruction {
        Self::ix(
            unspent::instruction::Deposit { amount }.data(),
            unspent::accounts::Deposit {
                owner: *owner,
                config: config_pda(),
                user: user_pda(owner),
                vault: vault_pda(),
                owner_credits,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn deposit(&mut self, u: &User, amount: u64) -> TxResult {
        let ix = self.ix_deposit(&u.key(), u.credits, amount);
        self.send(&[ix], &[&u.kp])
    }

    /// `expired`: (request_id, rent payer) of reservations to close first.
    pub fn ix_withdraw(&self, owner: &Pubkey, owner_credits: Pubkey, amount: u64, expired: &[([u8; 32], Pubkey)]) -> Instruction {
        let mut metas = unspent::accounts::Withdraw {
            owner: *owner,
            config: config_pda(),
            user: user_pda(owner),
            vault: vault_pda(),
            owner_credits,
            token_program: spl_token::ID,
        }
        .to_account_metas(None);
        for (id, payer) in expired {
            metas.push(AccountMeta::new(res_pda(id), false));
            metas.push(AccountMeta::new(*payer, false));
        }
        Self::ix(unspent::instruction::Withdraw { amount }.data(), metas)
    }

    pub fn withdraw(&mut self, u: &User, amount: u64) -> TxResult {
        let ix = self.ix_withdraw(&u.key(), u.credits, amount, &[]);
        self.send(&[ix], &[&u.kp])
    }

    pub fn ix_set_my_reserve_cap(&self, owner: &Pubkey, cap: u64) -> Instruction {
        Self::ix(
            unspent::instruction::SetMyReserveCap { cap }.data(),
            unspent::accounts::SetMyReserveCap { owner: *owner, user: user_pda(owner) }.to_account_metas(None),
        )
    }

    pub fn ix_reserve(&self, gateway: &Pubkey, request_id: [u8; 32], owner: Pubkey, amount: u64) -> Instruction {
        Self::ix(
            unspent::instruction::Reserve { request_id, owner, amount }.data(),
            unspent::accounts::Reserve {
                gateway: *gateway,
                config: config_pda(),
                user: user_pda(&owner),
                reservation: res_pda(&request_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn reserve(&mut self, request_id: [u8; 32], owner: Pubkey, amount: u64) -> TxResult {
        let ix = self.ix_reserve(&self.gateway.pubkey(), request_id, owner, amount);
        let kp = self.gateway.insecure_clone();
        self.send(&[ix], &[&kp])
    }

    pub fn ix_settle(&self, gateway: &Pubkey, request_id: [u8; 32], owner: Pubkey, rent_payer: Pubkey, actual: u64) -> Instruction {
        Self::ix(
            unspent::instruction::Settle { actual }.data(),
            unspent::accounts::Settle {
                gateway: *gateway,
                config: config_pda(),
                reservation: res_pda(&request_id),
                rent_payer,
                user: user_pda(&owner),
                credit_mint: self.credit_mint,
                vault: vault_pda(),
                reserve: reserve_pda(),
                treasury: self.config().treasury,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn settle(&mut self, request_id: [u8; 32], owner: Pubkey, actual: u64) -> TxResult {
        let g = self.gateway.pubkey();
        let ix = self.ix_settle(&g, request_id, owner, g, actual);
        let kp = self.gateway.insecure_clone();
        self.send(&[ix], &[&kp])
    }

    /// entries: (request_id, owner, actual).
    pub fn ix_settle_many(&self, gateway: &Pubkey, rent_payer: Pubkey, entries: &[([u8; 32], Pubkey, u64)]) -> Instruction {
        let mut metas = unspent::accounts::SettleMany {
            gateway: *gateway,
            config: config_pda(),
            rent_payer,
            credit_mint: self.credit_mint,
            vault: vault_pda(),
            reserve: reserve_pda(),
            treasury: self.config().treasury,
            token_program: spl_token::ID,
        }
        .to_account_metas(None);
        for (id, owner, _) in entries {
            metas.push(AccountMeta::new(res_pda(id), false));
            metas.push(AccountMeta::new(user_pda(owner), false));
        }
        let actuals = entries.iter().map(|e| e.2).collect();
        Self::ix(unspent::instruction::SettleMany { actuals }.data(), metas)
    }

    pub fn settle_many(&mut self, entries: &[([u8; 32], Pubkey, u64)]) -> TxResult {
        let g = self.gateway.pubkey();
        let ix = self.ix_settle_many(&g, g, entries);
        let kp = self.gateway.insecure_clone();
        self.send(&[ix], &[&kp])
    }

    pub fn ix_expire(&self, request_id: [u8; 32], owner: Pubkey, rent_payer: Pubkey) -> Instruction {
        Self::ix(
            unspent::instruction::Expire {}.data(),
            unspent::accounts::Expire {
                config: config_pda(),
                reservation: res_pda(&request_id),
                rent_payer,
                user: user_pda(&owner),
            }
            .to_account_metas(None),
        )
    }

    /// Anyone (a fresh keypair) calls expire; rent goes to the gateway that paid it.
    pub fn expire(&mut self, request_id: [u8; 32], owner: Pubkey) -> TxResult {
        let caller = Keypair::new();
        self.svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
        let ix = self.ix_expire(request_id, owner, self.gateway.pubkey());
        self.send(&[ix], &[&caller])
    }

    pub fn ix_redeem(&self, owner: &Pubkey, owner_credits: Pubkey, owner_usdc: Pubkey, amount: u64) -> Instruction {
        Self::ix(
            unspent::instruction::Redeem { amount }.data(),
            unspent::accounts::Redeem {
                owner: *owner,
                config: config_pda(),
                credit_mint: self.credit_mint,
                reserve: reserve_pda(),
                owner_credits,
                owner_usdc,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn redeem(&mut self, u: &User, amount: u64) -> TxResult {
        let ix = self.ix_redeem(&u.key(), u.credits, u.usdc, amount);
        self.send(&[ix], &[&u.kp])
    }

    // ------------------------------------------------------------ admin

    fn admin_metas(&self, admin: &Pubkey) -> Vec<AccountMeta> {
        unspent::accounts::AdminOnly { admin: *admin, config: config_pda() }.to_account_metas(None)
    }

    pub fn ix_set_limit(&self, admin: &Pubkey, field: ConfigField, value: u64) -> Instruction {
        Self::ix(unspent::instruction::SetLimit { field, value }.data(), self.admin_metas(admin))
    }
    pub fn ix_set_pause(&self, admin: &Pubkey, target: PauseTarget, paused: bool) -> Instruction {
        Self::ix(unspent::instruction::SetPause { target, paused }.data(), self.admin_metas(admin))
    }
    pub fn ix_propose_gateway_backup(&self, admin: &Pubkey, key: Pubkey) -> Instruction {
        Self::ix(unspent::instruction::ProposeGatewayBackup { key }.data(), self.admin_metas(admin))
    }
    pub fn ix_propose_treasury(&self, admin: &Pubkey, new_treasury: Pubkey) -> Instruction {
        Self::ix(
            unspent::instruction::ProposeTreasury {}.data(),
            unspent::accounts::ProposeTreasury { admin: *admin, config: config_pda(), new_treasury }.to_account_metas(None),
        )
    }
    pub fn ix_cancel_pending(&self, admin: &Pubkey, field: ConfigField) -> Instruction {
        Self::ix(unspent::instruction::CancelPending { field }.data(), self.admin_metas(admin))
    }
    pub fn ix_apply_pending(&self, field: ConfigField) -> Instruction {
        Self::ix(
            unspent::instruction::ApplyPending { field }.data(),
            unspent::accounts::ApplyPending { config: config_pda() }.to_account_metas(None),
        )
    }
    pub fn ix_revoke_gateway(&self, admin: &Pubkey) -> Instruction {
        Self::ix(unspent::instruction::RevokeGateway {}.data(), self.admin_metas(admin))
    }
    pub fn ix_activate_backup_gateway(&self, admin: &Pubkey) -> Instruction {
        Self::ix(unspent::instruction::ActivateBackupGateway {}.data(), self.admin_metas(admin))
    }
    pub fn ix_shutdown(&self, admin: &Pubkey) -> Instruction {
        Self::ix(unspent::instruction::Shutdown {}.data(), self.admin_metas(admin))
    }
    pub fn ix_sweep_surplus(&self, admin: &Pubkey) -> Instruction {
        Self::ix(
            unspent::instruction::SweepSurplus {}.data(),
            unspent::accounts::SweepSurplus {
                admin: *admin,
                config: config_pda(),
                credit_mint: self.credit_mint,
                vault: vault_pda(),
                reserve: reserve_pda(),
                treasury: self.config().treasury,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Sends an instruction signed by the admin.
    pub fn as_admin(&mut self, ix: Instruction) -> TxResult {
        let kp = self.admin.insecure_clone();
        self.send(&[ix], &[&kp])
    }

    /// Anyone (a fresh keypair) sends the instruction.
    pub fn as_anyone(&mut self, ix: Instruction) -> TxResult {
        let caller = Keypair::new();
        self.svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
        self.send(&[ix], &[&caller])
    }

    // ------------------------------------------------------------ invariants (brief 5.9)

    #[track_caller]
    pub fn check_invariants(&self, users: &[Pubkey], live: &[[u8; 32]]) {
        let c = self.config();
        let reserve = self.token_balance(&reserve_pda());
        let vault = self.token_balance(&vault_pda());
        let supply = self.credit_supply();
        assert!(reserve >= supply, "reserve {reserve} < supply {supply}");
        assert!(vault >= c.total_user_balance, "vault {vault} < total_user_balance {}", c.total_user_balance);
        assert_eq!(c.total_released, c.total_burned, "total_released != total_burned");
        let mut sum_balance = 0u64;
        let mut sum_reserved = 0u64;
        for u in users {
            if let Some(ua) = self.user_account(u) {
                assert!(ua.reserved <= ua.balance, "user reserved {} > balance {}", ua.reserved, ua.balance);
                let held: u64 = live
                    .iter()
                    .filter_map(|id| self.reservation(id))
                    .filter(|r| r.owner == *u)
                    .map(|r| r.amount)
                    .sum();
                assert_eq!(ua.reserved, held, "user reserved != sum of live reservations");
                sum_balance += ua.balance;
                sum_reserved += ua.reserved;
            }
        }
        assert_eq!(sum_balance, c.total_user_balance, "Σ balance != total_user_balance");
        let live_sum: u64 = live.iter().filter_map(|id| self.reservation(id)).map(|r| r.amount).sum();
        assert_eq!(c.active_reserved, live_sum, "active_reserved != Σ live reservations");
        assert_eq!(sum_reserved, c.active_reserved, "Σ user reserved != active_reserved");
    }
}
