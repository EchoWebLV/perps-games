# Perps Rider: Three-Minute MagicBlock Judge Introduction

**Audience:** MagicBlock Blitz v6 hackathon judges

**Target length:** Three minutes at a clear presentation pace

**Narrative:** Gameplay first, followed by the technical proof that MagicBlock makes the experience possible

## Script

Most perpetual exchanges give you charts, order books, and a wall of numbers.

Perps Rider gives you a car.

This is a real perpetual-futures position that you drive. You choose Bitcoin, Ethereum, or Solana, decide whether to go long or short, and then rev the tachometer to set your leverage, all the way up to 3,000 times.

When you hit GO, the live market takes control of the road. If the price moves in your direction, your equity climbs and your car surges forward. If it moves against you, you race toward your liquidation floor. You can cash out and lock in the win, or stay on the throttle for a bigger payout and risk wrecking the car.

So the core loop feels like an arcade racer, but underneath it is a genuine leveraged position settled against a live Pyth Lazer price.

That is where MagicBlock becomes essential.

The full round state machine runs on-chain inside a MagicBlock Ephemeral Rollup. Prices can refresh every 50 to 200 milliseconds, giving us the speed and low cost needed for continuous settlement. At leverage this high, even a tiny market move matters, so the game cannot wait for a player to sign another transaction.

Instead, a native MagicBlock crank continuously calls our settlement instruction. The program reads the authenticated oracle price and decides the outcome itself. If the liquidation floor is crossed, the position settles immediately, with zero transactions from the player and no operator choosing the result.

The final state is committed back to Solana. Stakes remain in program-controlled vaults, withdrawals are bound to the player's wallet, and every payout uses deterministic integer math that anyone can recompute from the on-chain round data.

MagicBlock gives us arcade responsiveness without hiding the financial logic on a centralized game server.

Perps Rider also has an open-world layer. Players drive through a synthwave lobby connecting the garage, crates, and track, while the upcoming Highway expands that world into a longer drive. Cars are not only collectibles: their abilities change how players manage risk. One can freeze profit and loss, another adds stop-loss and take-profit, and another lets steering choose long or short.

The same account works across desktop, an iPhone PWA, and a native Solana Seeker build. Players can sign in with a simple email code through Privy, while still receiving their own Solana wallet.

Perps Rider is not a trading terminal with a game wrapped around it. It turns the position itself into the game: leverage becomes acceleration, price becomes the road, liquidation becomes a wreck, and MagicBlock makes every moment fast, on-chain, and verifiable.

Perps Rider. A real perp you drive, built on MagicBlock.
