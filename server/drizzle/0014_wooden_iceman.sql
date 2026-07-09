CREATE TABLE IF NOT EXISTS "upgrade_levels" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"turbo" integer DEFAULT 0 NOT NULL,
	"tank" integer DEFAULT 0 NOT NULL,
	"suspension" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upgrade_levels" ADD CONSTRAINT "upgrade_levels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_user_created_idx" ON "ledger_entries" USING btree ("user_id","created_at");