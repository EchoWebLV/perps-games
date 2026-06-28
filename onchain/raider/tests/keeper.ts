// Minimal house keeper: tick the open round on the ER until it settles (or maxTicks).
// PERMISSIONLESS — `caller` is just whoever pays the tx; the program decides the verdict.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runKeeper(programER, accounts, signer, opts = {}) {
  const intervalMs = opts.intervalMs ?? 200;
  const maxTicks = opts.maxTicks ?? 400;
  for (let i = 0; i < maxTicks; i++) {
    const r = await programER.account.round.fetch(accounts.round);
    if (r.status === 2) return r;
    try {
      await programER.methods
        .tick()
        .accounts({
          player: accounts.player,
          house: accounts.house,
          round: accounts.round,
          mint: accounts.mint,
          priceUpdate: accounts.btcFeed,
          caller: signer.publicKey,
        })
        .signers([signer])
        .rpc({ skipPreflight: true });
    } catch (e) {
      // heartbeat no-op error / transient race — keep polling status.
    }
    await sleep(intervalMs);
  }
  return await programER.account.round.fetch(accounts.round);
}

module.exports = { runKeeper };
