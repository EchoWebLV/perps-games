CREATE TYPE "public"."round_status" AS ENUM('open', 'settled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "round_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"dir" integer,
	"lev" integer,
	"amount" double precision,
	"price_raw" double precision NOT NULL,
	"ts_us" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"dir" integer NOT NULL,
	"lev" integer NOT NULL,
	"stake" bigint NOT NULL,
	"cfg_edge" double precision NOT NULL,
	"cfg_liq" double precision NOT NULL,
	"cfg_cap" integer NOT NULL,
	"cfg_maxsec" integer NOT NULL,
	"entry_raw" double precision NOT NULL,
	"entry_ts_us" bigint NOT NULL,
	"status" "round_status" DEFAULT 'open' NOT NULL,
	"exit_raw" double precision,
	"exit_ts_us" bigint,
	"outcome" text,
	"equity" double precision,
	"payout_coins" bigint,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "round_actions" ADD CONSTRAINT "round_actions_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rounds" ADD CONSTRAINT "rounds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "round_actions_round_seq_idx" ON "round_actions" USING btree ("round_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "round_actions_idem_idx" ON "round_actions" USING btree ("round_id","action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rounds_user_idx" ON "rounds" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rounds_one_open_idx" ON "rounds" USING btree ("user_id") WHERE "rounds"."status" = 'open';