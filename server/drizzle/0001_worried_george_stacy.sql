CREATE TABLE IF NOT EXISTS "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" bigint NOT NULL,
	"reason" text NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_user_idx" ON "ledger_entries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_idem_idx" ON "ledger_entries" USING btree ("reason","ref") WHERE "ledger_entries"."ref" is not null;