import { syncDueModels } from "@/services/model-sync-schedule";

/**
 * Periodic tick that keeps the model catalog current: models.dev metadata and
 * the models of every API key whose provider TTL has passed. Model listing
 * routes only read what this writes.
 */
export async function handleLlmModelSync(): Promise<void> {
  await syncDueModels();
}
