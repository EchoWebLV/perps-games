CREATE TABLE IF NOT EXISTS "deposit_cursors" (
	"treasury_ata" text PRIMARY KEY NOT NULL,
	"last_sig" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
