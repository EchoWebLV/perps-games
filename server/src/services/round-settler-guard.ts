/**
 * Fail-closed guard for real-money (cash) rounds.
 *
 * The engine (@perps/engine settleRound) only evaluates liquidation / cap / time at the marks the
 * CLIENT submits. Without a server-side sweep that turns every cash round into a free option: a
 * player simply skips the losing marks (never calls mark/close) and the deadline, cap, and
 * liquidation never fire. So cash rounds MUST NOT run unless an autonomous settler enforces every
 * deadline, cap, and liquidation independently of the client.
 *
 * That settler now exists — {@link makeRoundSettler} in round-settler.ts — and index.ts constructs
 * it for `stakeAsset === "cash"`, sharing the routes' own `makeRounds` instance (the shown-mark
 * cache it settles against is per-instance). This guard stays as the interlock: booting cash rounds
 * still requires BOTH the explicit CASH_SETTLER_ENABLED switch AND a wired settler, so removing or
 * failing to construct the settler can never silently reopen the free-option hole. Coin
 * (soft-currency) rounds are unaffected and pass with no settler.
 */
export interface RoundSettler {
  start(): void;
  stop(): void;
}

export function assertRoundSettlerForStake(input: {
  stakeAsset: "coin" | "cash";
  cashSettlerEnabled: boolean;
  roundSettler: RoundSettler | null;
}): void {
  if (input.stakeAsset !== "cash") return; // soft-coin rounds never need the settler
  if (!input.cashSettlerEnabled) {
    throw new Error(
      "refusing to boot: cash (real-money) rounds require an autonomous settler; set CASH_SETTLER_ENABLED=true once one is wired",
    );
  }
  if (!input.roundSettler) {
    throw new Error(
      "refusing to boot: CASH_SETTLER_ENABLED is set but no autonomous round settler is wired — cash rounds cannot run without one",
    );
  }
}
