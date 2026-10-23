import { GIT_PROVIDERS } from "@archestra/shared";
import { z } from "zod";

export const GitProviderSchema = z.enum(GIT_PROVIDERS);
export type GitProvider = z.infer<typeof GitProviderSchema>;
