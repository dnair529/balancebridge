CREATE TABLE "alert_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text DEFAULT 'digest' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"client_id" uuid,
	"user_id" uuid,
	"title" text NOT NULL,
	"detail" text,
	"action_url" text,
	"status" text DEFAULT 'open' NOT NULL,
	"deliver_after" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text
);
--> statement-breakpoint
CREATE TABLE "client_financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"institution" text NOT NULL,
	"nickname" text,
	"kind" text NOT NULL,
	"last4" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_onboarding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"completed_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"last_saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_onboarding_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "client_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text NOT NULL,
	"previous_status" text,
	"dimensions" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"blocked_by" text DEFAULT 'none' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dimension" text NOT NULL,
	"yellow_at" integer NOT NULL,
	"red_at" integer NOT NULL,
	"unit" text DEFAULT 'days' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_thresholds_dimension_unique" UNIQUE("dimension")
);
--> statement-breakpoint
CREATE TABLE "staff_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"closes_due" integer DEFAULT 0 NOT NULL,
	"closes_on_time" integer DEFAULT 0 NOT NULL,
	"preflight_first_pass" integer DEFAULT 0 NOT NULL,
	"preflight_attempts" integer DEFAULT 0 NOT NULL,
	"reviewer_rejections" integer DEFAULT 0 NOT NULL,
	"median_reply_minutes" integer,
	"sla_breaches" integer DEFAULT 0 NOT NULL,
	"items_cleared" integer DEFAULT 0 NOT NULL,
	"txns_categorized" integer DEFAULT 0 NOT NULL,
	"rule_resolved" integer DEFAULT 0 NOT NULL,
	"ai_accepted" integer DEFAULT 0 NOT NULL,
	"ai_overridden" integer DEFAULT 0 NOT NULL,
	"active_clients" integer DEFAULT 0 NOT NULL,
	"minutes_worked" integer DEFAULT 0 NOT NULL,
	"sessions_count" integer DEFAULT 0 NOT NULL,
	"out_of_hours_minutes" integer DEFAULT 0 NOT NULL,
	"difficulty_index" integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "ein_encrypted" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "formation_state" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "fiscal_year_end" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "books_status" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "months_behind" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "txn_volume_band" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "revenue_band" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "current_software" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "cpa_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "cpa_email" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "monthly_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "close_target_day" integer DEFAULT 10;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "heard_about" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "offboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "client_access" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "alert_preferences" ADD CONSTRAINT "alert_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_financial_accounts" ADD CONSTRAINT "client_financial_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding" ADD CONSTRAINT "client_onboarding_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_status_history" ADD CONSTRAINT "client_status_history_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_thresholds" ADD CONSTRAINT "health_thresholds_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_metrics_daily" ADD CONSTRAINT "staff_metrics_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_prefs_uq" ON "alert_preferences" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "alerts_open_idx" ON "alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "assignments_user_active_idx" ON "client_assignments" USING btree ("user_id","ended_at");--> statement-breakpoint
CREATE INDEX "assignments_client_active_idx" ON "client_assignments" USING btree ("client_id","ended_at");--> statement-breakpoint
CREATE INDEX "client_fin_accounts_idx" ON "client_financial_accounts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "status_history_client_idx" ON "client_status_history" USING btree ("client_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_metrics_uq" ON "staff_metrics_daily" USING btree ("user_id","on_date");