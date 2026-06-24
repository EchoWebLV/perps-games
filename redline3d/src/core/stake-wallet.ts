export class StakeWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StakeWalletError";
  }
}

export interface EnsureStakeBalanceOpts {
  currentBalance: number;
  stake: number;
  deposit: (amountCents: number) => Promise<void>;
  pollBalance: () => Promise<number>;
  maxPolls?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
}

export async function ensureStakeBalance(opts: EnsureStakeBalanceOpts): Promise<number> {
  if (opts.currentBalance >= opts.stake) return opts.currentBalance;
  const missing = opts.stake - opts.currentBalance;
  await opts.deposit(missing);

  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 10;
  const pollMs = opts.pollMs ?? 3000;
  for (let i = 0; i < maxPolls; i++) {
    await delay(pollMs);
    const balance = await opts.pollBalance();
    if (balance >= opts.stake) return balance;
  }
  throw new StakeWalletError("stake_deposit_not_confirmed");
}
