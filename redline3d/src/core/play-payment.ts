export class InsufficientWalletBalanceError extends Error {
  constructor() {
    super("insufficient_wallet_balance");
    this.name = "InsufficientWalletBalanceError";
  }
}

export class PlayPaymentConfirmationError extends Error {
  constructor() {
    super("play_payment_not_confirmed");
    this.name = "PlayPaymentConfirmationError";
  }
}

export interface EnsurePlayPaymentOpts {
  walletBalance: number | null;
  currentServerBalance?: number;
  playAmount: number;
  pay: (amountCents: number) => Promise<void>;
  pollServerBalance: () => Promise<number>;
  maxPolls?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
}

export async function ensurePlayPayment(opts: EnsurePlayPaymentOpts): Promise<number> {
  if (opts.walletBalance != null && opts.walletBalance < opts.playAmount) {
    throw new InsufficientWalletBalanceError();
  }

  const requiredServerBalance = (opts.currentServerBalance ?? 0) + opts.playAmount;
  await opts.pay(opts.playAmount);

  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 10;
  const pollMs = opts.pollMs ?? 3000;
  for (let i = 0; i < maxPolls; i++) {
    await delay(pollMs);
    const balance = await opts.pollServerBalance();
    if (balance >= requiredServerBalance) return balance;
  }
  throw new PlayPaymentConfirmationError();
}
