import { z } from "zod";

const FunctionDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        `https://github.com/openai/openai-node/blob/master/src/resources/shared.ts#L217`,
      ),
    strict: z.boolean().nullable().optional(),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/master/src/resources/shared.ts#L174`,
  );

const FunctionToolSchema = z
  .object({
    type: z.literal("function"),
    function: FunctionDefinitionSchema,
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L988`,
  );

const CustomToolSchema = z
  .object({
    type: z.literal("custom"),
    custom: z.object({
      name: z
        .string()
        .describe(
          "The name of the custom tool, used to identify it in tool calls",
        ),
      description: z
        .string()
        .optional()
        .describe(
          "Optional description of the custom tool, used to provide more context",
        ),
      format: z
        .union([
          z
            .object({
              type: z
                .literal("text")
                .describe("Unconstrained text format. Always `text`"),
            })
            .describe("Unconstrained free-form text"),
          z.object({
            type: z.literal("grammar"),
            grammar: z
              .object({
                definition: z.string().describe("The grammar definition"),
                syntax: z
                  .enum(["lark", "regex"])
                  .describe("The syntax of the grammar definition"),
              })
              .describe("Your chosen grammar"),
          }),
        ])
        .optional()
        .describe(
          "The input format for the custom tool. Default is unconstrained text.",
        ),
    }),
  })
  .describe(`
  Specifies a tool the model should use. Use to force the model to call a specific custom tool.

  https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1229-L1236
  `);

const AllowedToolsSchema = z
  .object({
    mode: z.enum(["auto", "required"]).describe(`
    Constrains the tools available to the model to a pre-defined set.

    auto allows the model to pick from among the allowed tools and generate a
    message.

    required requires the model to call one or more of the allowed tools.
    `),
    tools: z
      .array(z.record(z.string(), FunctionToolSchema))
      .describe(
        "A list of tool definitions that the model should be allowed to call",
      ),
  })
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1455`,
  );

const AllowedToolChoiceSchema = z
  .object({
    type: z.literal("allowed_tools"),
    allowed_tools: AllowedToolsSchema,
  })
  .describe(`
  Constrains the tools available to the model to a pre-defined set.

  https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L359
  `);

const NamedToolChoiceSchema = z
  .object({
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
    }),
  })
  .describe(`
  Specifies a tool the model should use. Use to force the model to call a specific function.

  https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1207-L1214
  `);

export const ToolSchema = z
  .union([FunctionToolSchema, CustomToolSchema])
  .describe(`
  A function tool that can be used to generate a response.

  https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1392
  `);

export const ToolChoiceOptionSchema = z
  .union([
    z.literal("none"),
    z.literal("auto"),
    z.literal("required"),
    AllowedToolChoiceSchema,
    NamedToolChoiceSchema,
    CustomToolSchema,
  ])
  .describe(
    `https://github.com/openai/openai-node/blob/v6.0.0/src/resources/chat/completions/completions.ts#L1405`,
  );
