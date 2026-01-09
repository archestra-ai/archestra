import { z } from "zod";

export const CohereToolSchema = z.object({
    type: z.literal("function"),
    function: z.object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.any()).optional(),
    }),
});

export type CohereTool = z.infer<typeof CohereToolSchema>;
