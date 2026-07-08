DROP TABLE IF EXISTS "relay_delivery_attempts";
--> statement-breakpoint
DROP TABLE IF EXISTS "relay_agent_activity_rows";
--> statement-breakpoint
DROP TABLE IF EXISTS "relay_live_activities";
--> statement-breakpoint
DROP TABLE IF EXISTS "relay_mobile_devices";
--> statement-breakpoint
ALTER TABLE "relay_environment_links" DROP COLUMN IF EXISTS "notifications_enabled";
--> statement-breakpoint
ALTER TABLE "relay_environment_links" DROP COLUMN IF EXISTS "live_activities_enabled";
--> statement-breakpoint
ALTER TABLE "relay_environment_links" DROP COLUMN IF EXISTS "created_by_device_id";
