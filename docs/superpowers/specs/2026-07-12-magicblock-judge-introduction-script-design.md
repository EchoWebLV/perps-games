# Perps Rider: Three-Minute MagicBlock Judge Introduction

**Audience:** MagicBlock Blitz v6 hackathon judges

**Target length:** Three minutes at a clear presentation pace

**Narrative:** Gameplay first, followed by the technical proof that MagicBlock makes the experience possible

## Script

[Open with the game running on a phone]

Hey, this is Perps Rider. It is an arcade driving game where the car is powered by a real perpetual-futures position.

I know that sounds a little unusual, so let me show you how it works.

[Show the market and direction controls]

First, I choose a market: Bitcoin, Ethereum, or Solana. Then I decide whether I think the price will go up or down by choosing long or short.

[Show the tachometer]

This tachometer is not just showing the speed of the car. It controls my leverage. The harder I rev, the more risk I take and the more violently the car reacts to the market.

[Start the round]

When I press GO, the live Pyth price starts driving the game. If the market moves in my direction, my profit grows and the car pushes forward. If it moves against me, I get closer to liquidation. I can cash out and keep the result, or stay in the position and risk wrecking the car.

[Show a cash-out or liquidation]

This is where MagicBlock matters. The round runs on-chain inside a MagicBlock Ephemeral Rollup, where the game can read fresh prices and settle continuously without making the player approve a transaction every few seconds.

A native crank keeps checking the position. If the price crosses my liquidation level, the program settles it automatically. There is no extra wallet popup, no liquidation button, and no game operator choosing whether I win or lose. The outcome comes from the authenticated price and deterministic on-chain math.

[Drive through the lobby]

Outside the main race, players can freely drive around a shared synthwave lobby. The buildings are how you enter different parts of the game: the Track, Garage, Upgrades, Crates, and soon the Highway.

The Highway is our next longer-form mode, and the lobby is the foundation for a larger shared competitive world. In the future, new buildings will introduce new games where players can meet and compete against each other.

[Show the Garage and different cars]

Cars are more than visual skins. Different cars have different abilities that change how you manage a position. One can freeze profit and loss, another can set a stop-loss and take-profit, and another lets steering choose between long and short.

The car collection currently lives with the player's game account. Our next step is to bring those cars on-chain as Solana NFT collectibles, so players can truly own and trade the cars they unlock.

[Show the game on the Seeker and desktop]

Perps Rider works on desktop, as an iPhone PWA, and as a native Solana Seeker app. Players can sign in with a simple email code through Privy and receive their own Solana wallet, with the same identity and collection available across devices.

[End on the car racing]

Perps Rider turns leverage into acceleration, price into the road, and liquidation into a wreck. It is a real perp you drive, built on MagicBlock.
