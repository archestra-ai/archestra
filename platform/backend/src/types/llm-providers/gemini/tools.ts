import { z } from "zod";

export const FunctionDeclarationSchema = z
  .object({
    name: z
      .string()
      .describe(
        "The name of the function. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 63.",
      ),
    description: z.string().describe("A brief description of the function."),
    behavior: z
      .enum(["UNSPECIFIED", "BLOCKING", "NON_BLOCKING"])
      .optional()
      .describe(`https://ai.google.dev/api/caching#Behavior`),
    parameters: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Describes the parameters to this function. Reflects the Open API 3.03 Parameter Object string Key: the name of the parameter. Parameter names are case sensitive. Schema Value: the Schema defining the type used for the parameter.",
      ),
    parametersJsonSchema: z.any().optional(),
    response: z.any().optional(),
    responseJsonSchema: z.any().optional(),
  })
  .describe(`https://ai.google.dev/api/caching#FunctionDeclaration`);

const FunctionCallingModeSchema = z.enum(["AUTO", "ANY", "NONE"]);

const FunctionCallingConfigSchema = z.object({
  mode: FunctionCallingModeSchema,
  allowedFunctionNames: z.array(z.string()).optional(),
});

export const ToolConfigSchema = z.object({
  functionCallingConfig: FunctionCallingConfigSchema,
});

const GoogleSearchRetrievalSchema = z
  .object({
    dynamicRetrievalConfig: z
      .object({
        mode: z
          .enum(["MODE_UNSPECIFIED", "MODE_DYNAMIC"])
          .describe(`https://ai.google.dev/api/caching#Mode`),
        dynamicThreshold: z.number(),
      })
      .describe(`
        Specifies the dynamic retrieval configuration for the given source.

        https://ai.google.dev/api/caching#DynamicRetrievalConfig
      `),
  })
  .describe(`https://ai.google.dev/api/caching#GoogleSearchRetrieval`);

export const ToolSchema = z
  .object({
    functionDeclarations: z.array(FunctionDeclarationSchema).optional(),
    googleSearchRetrieval: GoogleSearchRetrievalSchema.optional(),
    codeExecution: z.any().optional(),
    googleSearch: z.any().optional(),
    urlContext: z.any().optional(),
  })
  .describe(`
Tool details that the model may use to generate response.

A Tool is a piece of code that enables the system to interact with external systems to perform an action, or set of actions, outside of knowledge and scope of the model.

https://ai.google.dev/api/caching#Tool
`);
