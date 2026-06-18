export function addCoins(total: number, collected: number): number {
  return total + Math.max(0, Math.floor(collected));
}

export function coinLabel(total: number): string {
  return String(Math.max(0, Math.floor(total)));
}
