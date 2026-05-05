import { z } from "zod";

export const ScheduleTriggerReplyChannelSchema = z.enum(["chat", "slack_dm"]);
export type ScheduleTriggerReplyChannel = z.infer<
  typeof ScheduleTriggerReplyChannelSchema
>;
