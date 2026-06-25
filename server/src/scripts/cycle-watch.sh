#!/bin/bash
# Watches perps_dev for new settled rounds (cycles) for the test user and dumps each cycle's ledger legs.
# Exits after 3 new cycles or ~9 min.
U="745259f9-1651-4023-890a-bf846d2499d3"
DB="perps_dev"
BASE_TS="$1"   # baseline timestamp; only report rounds whose cash legs are newer
TARGET=${2:-3}
seen_file=$(mktemp)
deadline=$(( $(date +%s) + 540 ))

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
log "cycle-watch started; baseline_ts=$BASE_TS; target=$TARGET new cycles"

count=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  # new round ids that have a round_stake newer than baseline and not yet reported
  newrounds=$(psql "$DB" -t -A -F'|' -c \
    "select distinct ref from ledger_entries where user_id='$U' and asset='cash' and reason='round_stake' and created_at > '$BASE_TS' order by ref;" 2>/dev/null)
  for r in $newrounds; do
    [ -z "$r" ] && continue
    grep -qx "$r" "$seen_file" && continue
    # only report once the round has settled (payout or payout_sent or a close exists)
    settled=$(psql "$DB" -t -A -c "select count(*) from ledger_entries where user_id='$U' and ref='$r' and reason in ('round_payout','round_payout_sent');" 2>/dev/null)
    [ "${settled:-0}" -eq 0 ] && continue
    echo "$r" >> "$seen_file"
    count=$((count+1))
    echo "==================== CYCLE $count  round=$r ===================="
    psql "$DB" -c "select to_char(created_at,'HH24:MI:SS') t, asset, delta, reason, substring(ref,1,16) ref from ledger_entries where user_id='$U' and (ref='$r' or (reason='deposit' and created_at >= (select min(created_at) from ledger_entries where ref='$r') - interval '20 seconds')) order by created_at;" 2>/dev/null
    [ "$count" -ge "$TARGET" ] && { log "reached $TARGET cycles — done"; rm -f "$seen_file"; exit 0; }
  done
  sleep 4
done
log "timeout reached; captured $count/$TARGET cycles"
rm -f "$seen_file"
exit 0
