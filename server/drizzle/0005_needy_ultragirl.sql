CREATE TYPE "public"."ledger_asset" AS ENUM('coin', 'cash');--> statement-breakpoint
DROP INDEX IF EXISTS "ledger_idem_idx";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "asset" "ledger_asset" DEFAULT 'coin' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_idem_idx" ON "ledger_entries" USING btree ("asset","reason","ref") WHERE "ledger_entries"."ref" is not null;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_cash_ref_chk" CHECK ("ledger_entries"."ref" is not null or "ledger_entries"."reason" not in ('deposit','withdraw_reserve','withdraw_reverse'));