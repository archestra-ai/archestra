import { z } from "zod";
import { secretManager } from "@/secrets-manager";

export async function handleMcpCatalogSecretRetirement(
  payload: Record<string, unknown>,
): Promise<void> {
  const secretIds = z.array(z.string().uuid()).parse(payload.secretIds);
  for (const id of secretIds) {
    await secretManager().deleteSecret(id, { onlyIfUnreferenced: true });
  }
}
