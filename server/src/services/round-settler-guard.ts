/**
 * Fail-closed guard for real-money (cash) rounds.
 *
 * The engine (@perps/engine settleRound) only evaluates liquidation / cap / time at the marks the
 * CLIENT submits, and there is NO autonomous server settler yet. With cash rounds that turns every
 * round into a free option: a player can simply skip the losing marks (never call mark/close) and
 * the deadline, cap, and liquidation never fire. So cash rounds MUST NOT run until an autonomous
 * settler enforces every deadline, cap, and liquidation independently of the client.
 *
 * This guard makes that impossible to violate by accident: booting cash rounds requires BOTH the
 * explicit CASH_SETTLER_ENABLED switch AND a wired settler component. Neither exists yet, so cash
 * fails closed at boot. Coin (soft-currency) rounds are unaffected.
 *
 * REMOVE/REPLACE this guard when the autonomous settler lands: construct the real settler, pass it
 * as `roundSettler`, and let CASH_SETTLER_ENABLED gate it.
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
