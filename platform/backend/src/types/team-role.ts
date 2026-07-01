import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { z } from "zod";

export const TeamMemberRoleSchema = z.enum([ADMIN_ROLE_NAME, MEMBER_ROLE_NAME]);

export type TeamMemberRole = z.infer<typeof TeamMemberRoleSchema>;
