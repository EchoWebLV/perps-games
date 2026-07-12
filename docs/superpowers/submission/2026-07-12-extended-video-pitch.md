# Perps Rider Extended Video Pitch

**Audience:** MagicBlock Blitz v6 judges

**Target:** Approximately four minutes at a clear presentation pace

## Script

[Open with Perps Rider running in the lobby on a Solana Seeker]

Hey everyone, this is Perps Rider, a mobile arcade driving game powered by real perpetual-futures positions. Instead of landing on a traditional menu, every player arrives in their own car inside this shared synthwave lobby.

[Drive around the lobby and pass the buildings]

This is the home world of Perps Rider. Players drive freely, see other drivers, and choose what to do by entering different buildings.

The Track contains the main trading game. The Garage holds the player's car collection. Upgrades improve those cars, Crates unlock new ones, and the upcoming Highway introduces a longer, open-ended driving mode.

The lobby is also the foundation for a larger competitive world. Future buildings will introduce head-to-head games, cooperative trading challenges, team-based market events, and other social experiences.

Our long-term vision is one connected world where players can drive, trade, collect, collaborate, and compete.

[Enter the Garage and show several cars]

Cars are more than visual skins. Each one changes how a player manages a position. One can freeze profit and loss, another adds a stop-loss and take-profit, and another lets the player choose long or short through steering.

Today, the car collection follows the player's game account across devices. Our next step is to bring those cars on-chain as Solana NFT collectibles, allowing players to truly own, collect, and trade the cars they unlock.

[Leave the Garage and drive into the Track]

Now let me show you the main Track experience.

[Show the market and direction controls]

First, I choose a market: Bitcoin, Ethereum, or Solana. Then I decide whether I believe the price will go up or down by choosing long or short.

[Show the tachometer and rev the engine]

This tachometer is also my leverage control. The harder I rev, the more risk I take and the more strongly the car reacts to the market.

[Press GO and show the position moving]

When I press GO, the live Pyth price begins driving the game. If the market moves in my direction, my profit grows. If it moves against me, I move closer to liquidation. I can cash out and keep the result, or remain in the position and risk wrecking the car.

This makes concepts like direction, leverage, profit, and liquidation understandable through driving instead of charts and order books.

[Show a cash-out or automatic liquidation]

This is our first MagicBlock integration.

The position runs on-chain inside a MagicBlock Ephemeral Rollup. This gives the game the speed and low cost needed to read fresh prices and settle continuously.

A native MagicBlock crank checks the position after it opens. If the market crosses the liquidation level, the program settles automatically. There is no additional wallet popup, liquidation button, or game operator deciding the result.

The program uses the authenticated price and deterministic on-chain math. MagicBlock gives us arcade responsiveness without hiding the result on a centralized server.

[Drive to Crates and open one]

Our second MagicBlock integration powers the crates.

When a signed-in player opens a crate, the browser and our server cannot choose the reward. The game requests randomness from MagicBlock VRF.

MagicBlock generates a verifiable result, our on-chain program validates it, and only then does the crate reveal the car. Neither the player nor the developer can secretly choose the outcome.

[Show the same account on Seeker, iPhone, and desktop]

Perps Rider runs as a native Solana Seeker app, an iPhone PWA, and a desktop web game.

A simple Privy email login creates a Solana wallet, and the same identity, balance, and collection follow the player across devices.

[Finish with the car racing, then return to the lobby]

Perps Rider is not a trading terminal with a game placed on top. The position itself becomes the game. Leverage becomes acceleration, price becomes the road, and liquidation becomes a wreck.

MagicBlock makes the Track fast and continuously settled. Its VRF makes rewards provably fair. The lobby brings everything together inside a world built to grow into many cooperative and competitive trading games.

Perps Rider is a real perp you drive, built on MagicBlock.
