import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const ConnectionKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9._-]*$/,
    "Credential identifiers start with a letter and use lowercase letters, numbers, dots, dashes, or underscores",
  );

export const SelectExecutionCredentialDefinitionSchema = createSelectSchema(
  schema.executionCredentialDefinitionsTable,
);

export const InsertExecutionCredentialDefinitionSchema = createInsertSchema(
  schema.executionCredentialDefinitionsTable,
  {
    key: ConnectionKeySchema,
    name: (field) => field.trim().min(1).max(120),
    description: (field) => field.trim().max(1_000),
    icon: (field) => field.max(700_000),
  },
)
  .omit({
    id: true,
    organizationId: true,
    createdBy: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine(
    (definition) =>
      (definition.allowPersonal ?? true) !==
      (definition.allowOrganization ?? false),
    {
      message: "Choose either personal connections or organization connections",
      path: ["allowPersonal"],
    },
  );

export const UpdateExecutionCredentialDefinitionSchema = createUpdateSchema(
  schema.executionCredentialDefinitionsTable,
  {
    description: (field) => field.trim().max(1_000),
    icon: (field) => field.max(700_000),
  },
)
  .pick({
    description: true,
    icon: true,
  })
  .partial();

export const ExecutionCredentialDefinitionViewSchema = z.object({
  key: ConnectionKeySchema,
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  builtIn: z.boolean(),
  allowPersonal: z.boolean(),
  allowOrganization: z.boolean(),
  personalConfigured: z.boolean(),
  organizationConfigured: z.boolean(),
});

export const ExecutionCredentialUsageSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
});

export type ExecutionCredentialDefinition = z.infer<
  typeof SelectExecutionCredentialDefinitionSchema
>;
export type InsertExecutionCredentialDefinition = z.infer<
  typeof InsertExecutionCredentialDefinitionSchema
>;
export type UpdateExecutionCredentialDefinition = z.infer<
  typeof UpdateExecutionCredentialDefinitionSchema
>;
export type ExecutionCredentialDefinitionView = z.infer<
  typeof ExecutionCredentialDefinitionViewSchema
>;
export type ExecutionCredentialUsage = z.infer<
  typeof ExecutionCredentialUsageSchema
>;
