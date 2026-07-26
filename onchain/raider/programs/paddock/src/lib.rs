use anchor_lang::prelude::*;

declare_id!("3wz2kwDSGZEfdwing4FucjveWunnpiwoYAnKUAbKRh2S");

pub mod book;
pub mod draw;
pub mod state;

#[program]
pub mod paddock {
    use super::*;
}
