# Perps Rider: Three-Minute MagicBlock Judge Introduction

**Audience:** MagicBlock Blitz v6 hackathon judges

**Target length:** Three minutes at a clear presentation pace

**Narrative:** Gameplay first, followed by the technical proof that MagicBlock makes the experience possible

## Script

[Open with the game running in the lobby on a phone]

Hey, this is Perps Rider, an arcade driving game powered by a real perpetual-futures position. Instead of a menu, every player starts here in a shared synthwave lobby.

[Drive around the lobby and pass the buildings]

This is the game's home world. I can drive around, see other players, and enter buildings. The Track leads to the main perp game. The Garage holds my collection, Upgrades improve my cars, Crates unlock new ones, and the upcoming Highway adds a longer-form driving mode.

The lobby is the foundation for a larger shared world. Over time, new buildings will open into new games where players compete against each other.

[Enter the Garage and show different cars]

Before we race, let me show you the cars. They are more than visual skins. Different cars have abilities that change how you manage a position. One can freeze profit and loss, another can set a stop-loss and take-profit, and another lets steering choose between long and short.

The car collection currently lives with the player's game account. Our next step is to bring these cars on-chain as Solana NFT collectibles, so players can truly own and trade the cars they unlock.

[Leave the Garage and drive into the Track]

Now I am entering the Track, where the main game happens.

[Show the market and direction controls]

First, I choose a market: Bitcoin, Ethereum, or Solana. Then I decide whether I think the price will go up or down by choosing long or short.

[Show the tachometer]

This tachometer is not just showing speed. It controls my leverage. The harder I rev, the more risk I take and the more violently the car reacts to the market.

[Start the round]

When I press GO, the live Pyth price starts driving the game. If the market moves in my direction, my profit grows and the car pushes forward. If it moves against me, I get closer to liquidation. I can cash out and keep the result, or stay in the position and risk wrecking the car.

[Show a cash-out or liquidation]

This is where MagicBlock matters. The round runs on-chain inside a MagicBlock Ephemeral Rollup, where the game can read fresh prices and settle continuously without making the player approve a transaction every few seconds.

A native crank keeps checking the position. If the price crosses my liquidation level, the program settles it automatically. There is no extra wallet popup, no liquidation button, and no game operator choosing whether I win or lose. The outcome comes from the authenticated price and deterministic on-chain math.

[Show the game on the Seeker and desktop]

Perps Rider works on desktop, as an iPhone PWA, and as a native Solana Seeker app. A simple Privy email login creates a Solana wallet, with the same identity and collection across devices.

[End on the car racing]

Perps Rider turns leverage into acceleration, price into the road, and liquidation into a wreck. It is a real perp you drive, built on MagicBlock.
