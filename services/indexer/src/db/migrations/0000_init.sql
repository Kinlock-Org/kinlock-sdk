CREATE TABLE "chain_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"ledger" bigint NOT NULL,
	"ledger_time" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"event_index" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "chain_events_tx_event_unique" UNIQUE("tx_hash","event_index")
);
--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_ledger" bigint NOT NULL,
	"last_event_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"id" bigint PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"payee_id" text NOT NULL,
	"payout" text NOT NULL,
	"token" text NOT NULL,
	"total" numeric(39, 0) NOT NULL,
	"released" numeric(39, 0) DEFAULT 0 NOT NULL,
	"returned" numeric(39, 0) DEFAULT 0 NOT NULL,
	"ref_hash" text NOT NULL,
	"state" text NOT NULL,
	"end_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_tx" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"payee_id" text PRIMARY KEY NOT NULL,
	"slug" text,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	"payout" text NOT NULL,
	"payout_updated_at" timestamp with time zone,
	"attester" text NOT NULL,
	"meta_hash" text NOT NULL,
	"display_name" text,
	"country" text,
	"local_currency" text,
	"city" text,
	"registered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payees_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tranches" (
	"lock_id" bigint NOT NULL,
	"idx" integer NOT NULL,
	"amount" numeric(39, 0) NOT NULL,
	"unlock_at" timestamp with time zone NOT NULL,
	"released" boolean DEFAULT false NOT NULL,
	"release_tx" text,
	CONSTRAINT "tranches_lock_id_idx_pk" PRIMARY KEY("lock_id","idx")
);
--> statement-breakpoint
ALTER TABLE "tranches" ADD CONSTRAINT "tranches_lock_id_locks_id_fk" FOREIGN KEY ("lock_id") REFERENCES "public"."locks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "locks_sender_idx" ON "locks" USING btree ("sender");--> statement-breakpoint
CREATE INDEX "locks_payee_state_idx" ON "locks" USING btree ("payee_id","state");--> statement-breakpoint
CREATE INDEX "locks_payee_ref_hash_idx" ON "locks" USING btree ("payee_id","ref_hash");