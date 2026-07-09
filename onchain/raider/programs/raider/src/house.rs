// house.rs — pure pot<->till arithmetic for the single-pot / per-session-till house
// sharding model. Like settle.rs, this is pure integer math with NO Anchor types so
// the conservation invariants are unit-testable in isolation. The `slice_from_pot`
// and `sweep_till` instruction handlers in lib.rs are thin wrappers over these.
//
// Model: ONE master pot PDA `[HOUSE_SEED, mint]` (never delegated) holds the bankroll.
// Each active session carves a till PDA `[HOUSE_SEED, mint, owner]` off the master for
// the duration of its ER session, then sweeps it back. `master.balance + till.balance`
// is invariant across slice and sweep — value only ever moves between the pot and a
// till, never in or out.

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum HouseMathError {
    Overflow,
    Undercapitalized,
    /// The requested slice exceeds the master's per-session ceiling `max_slice` (FIX 2):
    /// one caller may reserve at most one worst-case round's payout off the shared pot.
    SliceTooLarge,
}

/// Session start: fold any leftover ALREADY in the till back into the master first
/// (self-healing — covers a skipped end-sweep or a delegate that failed after a prior
/// slice, so re-slicing never double-spends), then carve `slice` off the combined pot
/// into the till. `max_slice` is the master's operator-configured ceiling: a single carve
/// may reserve at most one worst-case round's payout (FIX 2), so no caller can strand the
/// whole bankroll. Returns (new_master_balance, new_till_balance). Errors with
/// `SliceTooLarge` when the requested slice exceeds `max_slice` (checked against the
/// request, NOT the reclaimed pot — an oversized carve is rejected even when the pot could
/// cover it), or `Undercapitalized` when the combined pot can't cover the slice (the
/// operator's "bankroll under threshold → not playable" rule).
pub fn reclaim_and_slice(
    master_balance: u64,
    till_balance: u64,
    slice: u64,
    max_slice: u64,
) -> core::result::Result<(u64, u64), HouseMathError> {
    // FIX 2: reject an over-ceiling carve BEFORE touching the pot — the cap bounds the
    // requested slice, not the reclaimed balance, so an oversized slice is refused even
    // when the pot could cover it. This is what stops one caller reserving the whole pot.
    if slice > max_slice {
        return Err(HouseMathError::SliceTooLarge);
    }
    let pot = master_balance
        .checked_add(till_balance)
        .ok_or(HouseMathError::Overflow)?;
    if pot < slice {
        return Err(HouseMathError::Undercapitalized);
    }
    Ok((pot - slice, slice))
}

/// Session end: return the whole till balance to the master. Returns the new master
/// balance; the caller zeroes the till. Conserves master + till.
pub fn sweep(master_balance: u64, till_balance: u64) -> core::result::Result<u64, HouseMathError> {
    master_balance
        .checked_add(till_balance)
        .ok_or(HouseMathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A cap comfortably above the 237_500_000 test slice, so these pre-existing vectors
    // exercise the carve/reclaim/undercap paths without tripping the FIX-2 ceiling.
    const CAP: u64 = 300_000_000;

    #[test]
    fn slice_carves_off_master_and_conserves() {
        // master ~10 SOL of base units (10_000_000_000 lamports), no leftover,
        // slice a min-bet (0.01 SOL) worst case = 237_500_000.
        let (m, t) = reclaim_and_slice(10_000_000_000, 0, 237_500_000, CAP).unwrap();
        assert_eq!(m, 9_762_500_000);
        assert_eq!(t, 237_500_000);
        assert_eq!(m + t, 10_000_000_000); // conserved
    }

    #[test]
    fn slice_reclaims_leftover_before_carving() {
        // till still holds 300_000_000 from a skipped sweep; master 9_700_000_000.
        // combined 10_000_000_000; re-slice 237_500_000 → leftover folded back, not
        // double-spent: master 9_762_500_000, till 237_500_000. Leftover-reclaim is
        // unaffected by the cap (the cap bounds the SLICE, not the reclaimed pot).
        let (m, t) = reclaim_and_slice(9_700_000_000, 300_000_000, 237_500_000, CAP).unwrap();
        assert_eq!(m, 9_762_500_000);
        assert_eq!(t, 237_500_000);
        assert_eq!(m + t, 10_000_000_000);
    }

    #[test]
    fn slice_rejects_when_pot_cannot_cover() {
        // master + till = 200_000_000 < slice 237_500_000 → undercapitalized (cap clears).
        assert_eq!(
            reclaim_and_slice(150_000_000, 50_000_000, 237_500_000, CAP),
            Err(HouseMathError::Undercapitalized)
        );
    }

    // FIX 2: a slice EXACTLY at the ceiling succeeds and still conserves.
    #[test]
    fn slice_at_cap_succeeds_and_conserves() {
        let (m, t) = reclaim_and_slice(10_000_000_000, 0, CAP, CAP).unwrap();
        assert_eq!(t, CAP);
        assert_eq!(m + t, 10_000_000_000); // conserved
    }

    // FIX 2: a slice ONE base unit over the ceiling is rejected, EVEN THOUGH the pot could
    // easily cover it — this is the whole point, a caller cannot carve the entire bankroll.
    #[test]
    fn slice_above_cap_is_rejected() {
        assert_eq!(
            reclaim_and_slice(10_000_000_000, 0, CAP + 1, CAP),
            Err(HouseMathError::SliceTooLarge)
        );
        // The extreme case the vuln relied on: slicing the whole 10-SOL pot is now refused.
        assert_eq!(
            reclaim_and_slice(10_000_000_000, 0, 10_000_000_000, CAP),
            Err(HouseMathError::SliceTooLarge)
        );
    }

    #[test]
    fn sweep_returns_whole_till_to_master() {
        // session ended with till = slice + house winnings (237.5M + 12.5M).
        assert_eq!(sweep(9_762_500_000, 250_000_000).unwrap(), 10_012_500_000);
    }

    #[test]
    fn sweep_after_player_win_returns_less() {
        // house lost 40M over the session: till = 197.5M. master back to 9_960_000_000.
        assert_eq!(sweep(9_762_500_000, 197_500_000).unwrap(), 9_960_000_000);
    }
}
