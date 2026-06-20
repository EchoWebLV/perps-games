/** the price feed is stale/absent — refuse to open or settle on bad data */
export class FeedHaltError extends Error {
  constructor() {
    super("feed_halt");
    this.name = "FeedHaltError";
  }
}

/** the round id does not exist for this user */
export class RoundNotFoundError extends Error {
  constructor() {
    super("round_not_found");
    this.name = "RoundNotFoundError";
  }
}

/** an action was attempted on a round that is already settled */
export class RoundClosedError extends Error {
  constructor() {
    super("round_not_open");
    this.name = "RoundClosedError";
  }
}

/** the user already has an open round (1.2 allows only one at a time) */
export class OpenRoundExistsError extends Error {
  constructor() {
    super("round_already_open");
    this.name = "OpenRoundExistsError";
  }
}
