import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "../database";

/**
 * As we support more llm provider types, this type will expand and should be updated
 *
 * TODO: right now, with just OpenAI this type represents an openapi definition object.. example:
 *
 * I wonder if there is some zod schema that exists to imply this shape of object
 *
 * "parameters": {
      "type": "object",
      "required": [
        "to",
        "subject",
        "body"
      ],
      "properties": {
        "to": {
          "type": "string",
          "description": "The email address to send the email to"
        },
        "body": {
          "type": "string",
          "description": "The body of the email"
        },
        "subject": {
          "type": "string",
          "description": "The subject of the email"
        }
      }
    }
 */
const ToolParametersContentSchema = z.any();

export const SelectToolSchema = createSelectSchema(schema.toolsTable);
export const InsertToolSchema = createInsertSchema(schema.toolsTable);

export type Tool = z.infer<typeof SelectToolSchema>;
export type InsertTool = z.infer<typeof InsertToolSchema>;

export type ToolParametersContent = z.infer<typeof ToolParametersContentSchema>;
