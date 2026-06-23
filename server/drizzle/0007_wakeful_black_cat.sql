CREATE TYPE "public"."withdrawal_status" AS ENUM('reserved', 'awaiting_approval', 'signing', 'sent', 'confirmed', 'failed', 'reversed', 'needs_review');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"dest_wallet" text NOT NULL,
	"status" "withdrawal_status" DEFAULT 'reserved' NOT NULL,
	"tx_sig" text,
	"privy_tx_id" text,
	"privy_idempotency_key" text NOT NULL,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_user_idx" ON "withdrawals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_one_inflight_idx" ON "withdrawals" USING btree ("user_id") WHERE "withdrawals"."status" in ('reserved','awaiting_approval','signing','sent','needs_review');