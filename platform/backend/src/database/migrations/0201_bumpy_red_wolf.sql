ALTER TYPE "public"."conversation_share_visibility" ADD VALUE 'team';--> statement-breakpoint
ALTER TYPE "public"."conversation_share_visibility" ADD VALUE 'user';--> statement-breakpoint
CREATE TABLE "conversation_share_team" (
	"share_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_share_team_share_id_team_id_pk" PRIMARY KEY("share_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_share_user" (
	"share_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_share_user_share_id_user_id_pk" PRIMARY KEY("share_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_share_team" ADD CONSTRAINT "conversation_share_team_share_id_conversation_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."conversation_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_share_team" ADD CONSTRAINT "conversation_share_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_share_user" ADD CONSTRAINT "conversation_share_user_share_id_conversation_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."conversation_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_share_user" ADD CONSTRAINT "conversation_share_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;