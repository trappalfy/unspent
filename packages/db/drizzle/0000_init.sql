CREATE TYPE "public"."api_key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."network" AS ENUM('localnet', 'devnet', 'mainnet');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('reserving', 'reserved', 'dispatched', 'completed', 'settled', 'reserve_timeout', 'released', 'expired', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."settle_status" AS ENUM('pending', 'sent', 'confirmed', 'skipped_expired');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"network" "network" NOT NULL,
	"name" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"last4" text NOT NULL,
	"daily_limit_ucr" bigint,
	"allowed_models" text[],
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"network" "network" NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"event_index" integer NOT NULL,
	"name" text NOT NULL,
	"owner" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"wallet" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"body_hash" "bytea" NOT NULL,
	"request_uuid" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_wallet_key_hash_pk" PRIMARY KEY("wallet","key_hash")
);
--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"network" "network" PRIMARY KEY NOT NULL,
	"last_signature" text,
	"last_slot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"db_cost_pusd" numeric(39, 0) NOT NULL,
	"provider_cost_pusd" numeric(39, 0),
	"diff_bps" integer,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" "bytea" NOT NULL,
	"api_key_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"network" "network" NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" "request_status" NOT NULL,
	"reserved_ucr" bigint NOT NULL,
	"prices" jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_5m_tokens" integer,
	"cache_write_1h_tokens" integer,
	"web_search_requests" integer,
	"cost_pusd" numeric(39, 0),
	"cost_ucr" bigint,
	"charged_ucr" bigint,
	"estimated" boolean DEFAULT false NOT NULL,
	"reserve_sig" text,
	"reserve_last_valid_block_height" bigint,
	"settle_sig" text,
	"provider_request_id" text,
	"cc_session_id" text,
	"cc_agent_id" text,
	"http_status" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_progress_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "settle_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_uuid" uuid NOT NULL,
	"request_id" "bytea" NOT NULL,
	"owner" text NOT NULL,
	"actual_ucr" bigint NOT NULL,
	"status" "settle_status" DEFAULT 'pending' NOT NULL,
	"tx_sig" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_wallet_wallets_address_fk" FOREIGN KEY ("wallet") REFERENCES "public"."wallets"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_request_uuid_requests_id_fk" FOREIGN KEY ("request_uuid") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settle_queue" ADD CONSTRAINT "settle_queue_request_uuid_requests_id_fk" FOREIGN KEY ("request_uuid") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_wallet_idx" ON "api_keys" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_sig_idx_uq" ON "chain_events" USING btree ("network","signature","event_index");--> statement-breakpoint
CREATE INDEX "chain_events_owner_idx" ON "chain_events" USING btree ("owner","slot");--> statement-breakpoint
CREATE INDEX "chain_events_name_idx" ON "chain_events" USING btree ("name","slot");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_day_provider_uq" ON "reconciliation" USING btree ("day","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_request_id_uq" ON "requests" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "requests_wallet_created_idx" ON "requests" USING btree ("wallet","created_at");--> statement-breakpoint
CREATE INDEX "requests_key_created_idx" ON "requests" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_open_idx" ON "requests" USING btree ("status") WHERE status in ('reserving','reserved','dispatched','completed','reserve_timeout');--> statement-breakpoint
CREATE UNIQUE INDEX "settle_queue_request_uq" ON "settle_queue" USING btree ("request_uuid");--> statement-breakpoint
CREATE INDEX "settle_queue_pending_idx" ON "settle_queue" USING btree ("status","id");