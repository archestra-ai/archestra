import { randomUUID } from "node:crypto";
import type { BatteryTargetName } from "@/types/openappa-batteries";

/**
 * What a battery helper runs as for a draft policy: the battery, target and
 * credential keys the draft composes, as an install row would record them.
 */
export type DraftHelperSource = {
  organizationId: string;
  batteryName: string;
  packageHash: string | null;
  target: BatteryTargetName | null;
  credentialBindings: Record<string, string>;
};

// A draft policy has no install rows, so its helper endpoints name these
// instead. Each lives only until the replay that registered it settles and is
// never persisted; the helper route still proves loopback and the bridge bearer.
const sources = new Map<string, DraftHelperSource & { id: string }>();

/**
 * Run `run` with a `register` that gives a draft battery an install id its
 * helper endpoint can name. Every id it hands out is dropped when `run` settles.
 */
export async function withDraftHelperSources<T>(
  run: (register: (source: DraftHelperSource) => string) => Promise<T>,
): Promise<T> {
  const ids: string[] = [];
  try {
    return await run((source) => {
      const id = randomUUID();
      sources.set(id, { ...source, id });
      ids.push(id);
      return id;
    });
  } finally {
    for (const id of ids) sources.delete(id);
  }
}

/** The draft battery an install id names, or null when it names none. */
export function draftHelperSource(
  installId: string,
): (DraftHelperSource & { id: string }) | null {
  return sources.get(installId) ?? null;
}
