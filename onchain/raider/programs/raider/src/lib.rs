use anchor_lang::prelude::*;

declare_id!("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod raider {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub payer: Signer<'info>,
}
