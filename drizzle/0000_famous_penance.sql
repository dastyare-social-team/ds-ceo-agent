CREATE TABLE "app_content_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"media_kind" text NOT NULL,
	"media_url" text,
	"source_text" text,
	"proposals" jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_confirm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"zernio_post_ids" jsonb
);
--> statement-breakpoint
CREATE TABLE "app_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"account" text DEFAULT 'default' NOT NULL,
	"label" text,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_story_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"heading" text,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"terms" jsonb NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_zernio_accounts" (
	"zernio_account_id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"username" text,
	"display_name" text,
	"profile_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"needs_reconnection" boolean DEFAULT false NOT NULL,
	"credential_id" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_content_drafts_chat_idx" ON "app_content_drafts" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_credentials_scope_account_live" ON "app_credentials" USING btree ("scope","account",("revoked_at" IS NULL));--> statement-breakpoint
CREATE INDEX "app_credentials_scope_idx" ON "app_credentials" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "app_story_chunks_source_idx" ON "app_story_chunks" USING btree ("source");--> statement-breakpoint
CREATE INDEX "app_zernio_accounts_platform_idx" ON "app_zernio_accounts" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "app_zernio_accounts_credential_idx" ON "app_zernio_accounts" USING btree ("credential_id");