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
      // A tick on a round that just settled out from under us (status != 1) errors
      // with NoOpenRound — that's the expected heartbeat race, swallow it. Anything
      // else (StalePrice/BadPrice/send failure) is surfaced so it isn't mistaken for
      // a no-op. Behavior is unchanged: we keep polling status either way.
      if (e?.message && !/NoOpenRound/.test(e.message)) {
        console.log("tick transient:", e.message);
      }
    }
    await sleep(intervalMs);
  }
  return await programER.account.round.fetch(accounts.round);
}

module.exports = { runKeeper };
