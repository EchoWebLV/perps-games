CREATE TYPE "public"."deposit_status" AS ENUM('credited', 'quarantine');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposit_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_wallet" text NOT NULL,
	"first_seen_tx_sig" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_sig" text NOT NULL,
	"user_id" uuid,
	"amount_base_units" text NOT NULL,
	"amount_cents" bigint,
	"mint" text NOT NULL,
	"source_owner" text NOT NULL,
	"dest_ata" text NOT NULL,
	"slot" bigint NOT NULL,
	"status" "deposit_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposit_sources" ADD CONSTRAINT "deposit_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_sources_wallet_idx" ON "deposit_sources" USING btree ("source_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposits_tx_sig_idx" ON "deposits" USING btree ("tx_sig");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposits_user_idx" ON "deposits" USING btree ("user_id");