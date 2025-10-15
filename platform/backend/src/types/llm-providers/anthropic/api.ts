import { z } from "zod";

// TODO: Implement
export const MessagesRequestSchema = z.any();

// TODO: Implement
export const MessagesResponseSchema = z.any();

export const MessagesHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z.string(),
});
