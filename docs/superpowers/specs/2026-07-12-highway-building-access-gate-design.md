# Highway Building Access Gate

## Goal

Keep the full application available publicly while temporarily restricting only the Highway building to local development.

## Behavior

When a player activates the Highway building:

- `localhost`, `127.0.0.1`, `::1`, or `[::1]`: enter Highway normally.
- Any other hostname, including Railway: remain in the lobby and show `Highway coming soon` through the existing lobby toast.

Every other building and game mode remains unchanged on all hosts.

## Implementation

A small pure hostname predicate controls Highway availability. The Highway branch in `triggerBuilding` checks that predicate before calling `enterHighway`. No global boot gate, routing change, Railway configuration, or server change is required.

## Testing

Unit tests cover the loopback allowlist and public-host rejection. A source-level integration test confirms the Highway building branch uses the predicate while other building branches remain available.
