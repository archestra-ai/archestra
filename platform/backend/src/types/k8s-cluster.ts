import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectK8sClusterSchema = createSelectSchema(
  schema.k8sClustersTable,
).extend({
  kubeconfig: z.string(),
});

export const InsertK8sClusterSchema = createInsertSchema(
  schema.k8sClustersTable,
  {
    kubeconfig: z.string().min(1),
  },
).omit({ id: true, createdAt: true, updatedAt: true });

export const UpdateK8sClusterSchema = createUpdateSchema(
  schema.k8sClustersTable,
  {
    kubeconfig: z.string().min(1).optional(),
  },
).pick({ name: true, kubeconfig: true });

export type K8sCluster = z.infer<typeof SelectK8sClusterSchema>;
export type InsertK8sCluster = z.infer<typeof InsertK8sClusterSchema>;
export type UpdateK8sCluster = z.infer<typeof UpdateK8sClusterSchema>;

export const CreateK8sClusterBodySchema = z.object({
  name: z.string().min(1).max(255),
  kubeconfig: z.string().min(1),
});

export type CreateK8sClusterBody = z.infer<typeof CreateK8sClusterBodySchema>;
