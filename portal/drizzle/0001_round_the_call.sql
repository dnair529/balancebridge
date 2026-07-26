CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bank' NOT NULL,
	"institution" text,
	"mask" text,
	"currency" text DEFAULT 'usd' NOT NULL,
	"external_source" text,
	"external_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"confidence" integer,
	"accepted" boolean,
	"related_entity" text,
	"related_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"transaction_ids" jsonb,
	"detected_by" text DEFAULT 'rule' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"shared_with_client_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "categorization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"match_type" text DEFAULT 'contains' NOT NULL,
	"pattern" text NOT NULL,
	"min_amount_cents" bigint,
	"max_amount_cents" bigint,
	"category_id" uuid NOT NULL,
	"source" text DEFAULT 'learned' NOT NULL,
	"created_by" uuid,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"identity" "citext" NOT NULL,
	"label" text,
	"verified_at" timestamp with time zone,
	"consent_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"transaction_id" uuid,
	"question" text NOT NULL,
	"choices" jsonb,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_via" text,
	"asked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "close_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"close_period_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"severity" text DEFAULT 'warn' NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "close_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"target_date" date,
	"status" text DEFAULT 'not_started' NOT NULL,
	"owner_id" uuid,
	"reviewer_id" uuid,
	"delivered_at" timestamp with time zone,
	"narrative" text,
	"narrative_approved_by" uuid,
	"narrative_approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compliance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"due_on" date NOT NULL,
	"notes" text,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"label" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"account_id" uuid,
	"transaction_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"fulfilled_by_intake_id" uuid,
	"last_nudged_at" timestamp with time zone,
	"nudge_count" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_item_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"doc_type" text DEFAULT 'unknown' NOT NULL,
	"extracted" jsonb NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" integer NOT NULL,
	"max_score" integer DEFAULT 20 NOT NULL,
	"checks" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"channel" text NOT NULL,
	"external_id" text,
	"sender_identity" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload" jsonb,
	"storage_key" text,
	"mime" text,
	"size_bytes" bigint,
	"content_hash" text,
	"status" text DEFAULT 'received' NOT NULL,
	"quarantine_reason" text,
	"document_id" uuid,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"provider" text NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"settings" jsonb,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"to_identity" text NOT NULL,
	"body" text NOT NULL,
	"purpose" text DEFAULT 'other' NOT NULL,
	"in_reply_to" uuid,
	"related_entity" text,
	"related_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "precedents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"industry" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"work_item_id" uuid,
	"minutes" integer NOT NULL,
	"automatic" boolean DEFAULT true NOT NULL,
	"occurred_on" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"posted_at" date NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"counterparty" text,
	"category_id" uuid,
	"categorized_by" text,
	"categorized_by_id" uuid,
	"categorized_at" timestamp with time zone,
	"category_confidence" integer,
	"needs_receipt" boolean DEFAULT false NOT NULL,
	"reconciled_at" timestamp with time zone,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "txn_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"matched_by" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"rejected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_to" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"related_entity" text,
	"related_id" text,
	"item_count" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_questions" ADD CONSTRAINT "client_questions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_questions" ADD CONSTRAINT "client_questions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_questions" ADD CONSTRAINT "client_questions_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_checks" ADD CONSTRAINT "close_checks_close_period_id_close_periods_id_fk" FOREIGN KEY ("close_period_id") REFERENCES "public"."close_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_periods" ADD CONSTRAINT "close_periods_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_periods" ADD CONSTRAINT "close_periods_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_periods" ADD CONSTRAINT "close_periods_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_periods" ADD CONSTRAINT "close_periods_narrative_approved_by_users_id_fk" FOREIGN KEY ("narrative_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_events" ADD CONSTRAINT "compliance_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_fulfilled_by_intake_id_intake_items_id_fk" FOREIGN KEY ("fulfilled_by_intake_id") REFERENCES "public"."intake_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_intake_item_id_intake_items_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "public"."intake_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precedents" ADD CONSTRAINT "precedents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "precedents" ADD CONSTRAINT "precedents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categorized_by_id_users_id_fk" FOREIGN KEY ("categorized_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn_matches" ADD CONSTRAINT "txn_matches_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn_matches" ADD CONSTRAINT "txn_matches_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txn_matches" ADD CONSTRAINT "txn_matches_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_client_idx" ON "accounts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ai_runs_task_idx" ON "ai_runs" USING btree ("task","created_at");--> statement-breakpoint
CREATE INDEX "anomalies_client_idx" ON "anomalies" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "categories_client_idx" ON "categories" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "rules_client_idx" ON "categorization_rules" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_uq" ON "channel_identities" USING btree ("channel","identity");--> statement-breakpoint
CREATE INDEX "client_questions_open_idx" ON "client_questions" USING btree ("client_id","answered_at");--> statement-breakpoint
CREATE INDEX "close_checks_period_idx" ON "close_checks" USING btree ("close_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "close_periods_uq" ON "close_periods" USING btree ("client_id","period_start");--> statement-breakpoint
CREATE INDEX "compliance_client_due_idx" ON "compliance_events" USING btree ("client_id","due_on");--> statement-breakpoint
CREATE INDEX "doc_requests_client_idx" ON "document_requests" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "extractions_item_idx" ON "extractions" USING btree ("intake_item_id");--> statement-breakpoint
CREATE INDEX "health_client_idx" ON "health_scores" USING btree ("client_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_external_uq" ON "intake_items" USING btree ("channel","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_content_uq" ON "intake_items" USING btree ("client_id","content_hash");--> statement-breakpoint
CREATE INDEX "intake_status_idx" ON "intake_items" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_uq" ON "integrations" USING btree ("client_id","provider");--> statement-breakpoint
CREATE INDEX "outbound_client_idx" ON "outbound_messages" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "precedents_client_idx" ON "precedents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "time_entries_client_idx" ON "time_entries" USING btree ("client_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transactions_client_posted_idx" ON "transactions" USING btree ("client_id","posted_at");--> statement-breakpoint
CREATE INDEX "transactions_uncategorized_idx" ON "transactions" USING btree ("client_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_external_uq" ON "transactions" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "txn_matches_txn_idx" ON "txn_matches" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "work_items_queue_idx" ON "work_items" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "work_items_client_idx" ON "work_items" USING btree ("client_id");