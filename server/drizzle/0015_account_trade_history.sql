CREATE TABLE IF NOT EXISTS "trade_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_public_key" text NOT NULL,
	"asset" text NOT NULL,
	"dir" integer NOT NULL,
	"lev" integer NOT NULL,
	"stake_base" bigint NOT NULL,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"payout_base" bigint NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_history" ADD CONSTRAINT "trade_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_history_user_settled_idx" ON "trade_history" USING btree ("user_id","settled_at","id");