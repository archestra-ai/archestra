import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectClusterSchema = createSelectSchema(schema.clustersTable);

export const InsertClusterInputSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().nullish(),
  kubeconfigYaml: z.string().min(1).nullish(),
  loadFromCluster: z.boolean().optional().default(false),
  isPersonalDefault: z.boolean().optional().default(false),
});

export const UpdateClusterInputSchema = z.object({
  name: z.string().min(1).optional(),
  namespace: z.string().nullish(),
  kubeconfigYaml: z.string().nullable().optional(),
  loadFromCluster: z.boolean().optional(),
  isPersonalDefault: z.boolean().optional(),
});

export type Cluster = z.infer<typeof SelectClusterSchema>;
export type InsertClusterInput = z.input<typeof InsertClusterInputSchema>;
export type UpdateClusterInput = z.input<typeof UpdateClusterInputSchema>;
