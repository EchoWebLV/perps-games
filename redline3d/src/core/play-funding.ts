/** The wallet (plus any in-game balance) cannot fund the requested action. */
export class InsufficientWalletBalanceError extends Error {
  constructor() {
    super("insufficient_wallet_balance");
    this.name = "InsufficientWalletBalanceError";
  }
}

/** The sweep was sent but the server had not credited it within the poll window. */
export class SweepConfirmTimeoutError extends Error {
  constructor() {
    super("sweep_confirm_timeout");
    this.name = "SweepConfirmTimeoutError";
  }
}

export interface SweepToPlayBalanceOpts {
  /** on-chain USDC in the Privy wallet right now, in cents */
  walletBalanceCents: number;
  /** in-game ledger balance before the sweep, in cents */
  startingServerBalance: number;
  /** build the unsigned wallet→treasury deposit tx for `amountCents`; resolves to base64 */
  buildDepositTx: (amountCents: number) => Promise<string>;
  /** sign + broadcast the tx via Privy; resolves to the tx signature */
  signAndSend: (txBase64: string) => Promise<string>;
  /** read the current in-game ledger balance (cents) */
  pollServerBalance: () => Promise<number>;
  /** smallest sweepable amount; below this there is nothing worth a tx (default 1c) */
  minSweepCents?: number;
  maxPolls?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
}

/**
 * Move the player's ENTIRE Privy-wallet USDC into the off-chain play balance, once.
 * On-chain happens here (one tx); afterwards every round is an instant ledger debit.
 * Resolves to the new in-game balance.
 */
export async function sweepToPlayBalance(opts: SweepToPlayBalanceOpts): Promise<number> {
  const amount = opts.walletBalanceCents;
  if (amount < (opts.minSweepCents ?? 1)) throw new InsufficientWalletBalanceError();

  const txBase64 = await opts.buildDepositTx(amount);
  await opts.signAndSend(txBase64);

  const target = opts.startingServerBalance + amount;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 30;
  const pollMs = opts.pollMs ?? 1000;
  for (let i = 0; i < maxPolls; i++) {
    const balance = await opts.pollServerBalance();
    if (balance >= target) return balance;
    await delay(pollMs);
  }
  throw new SweepConfirmTimeoutError();
}
