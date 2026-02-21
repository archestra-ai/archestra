ALTER TABLE "chatops_channel_binding" ADD COLUMN "is_dm" boolean DEFAULT false NOT NULL;
ALTER TABLE "chatops_channel_binding" ADD COLUMN "dm_owner_email" varchar(256);