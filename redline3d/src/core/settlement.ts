import { CONFIG } from "./config";

export interface Settlement {
  balance(): number;
  canAfford(stake: number): boolean;
  debit(stake: number): void; // on launch
  credit(payout: number): void; // on settle
  reset(): void;
}

export class SimSettlement implements Settlement {
  private bal: number;
  constructor(initial: number = CONFIG.START_BALANCE) {
    this.bal = initial;
  }
  balance(): number {
    return this.bal;
  }
  canAfford(stake: number): boolean {
    return this.bal >= stake;
  }
  debit(stake: number): void {
    if (!this.canAfford(stake)) throw new Error("insufficient balance");
    this.bal -= stake;
  }
  credit(payout: number): void {
    this.bal += payout;
  }
  reset(): void {
    this.bal = CONFIG.START_BALANCE;
  }
}
