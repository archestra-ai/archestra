import { randomUUID } from "node:crypto";

/** Who a validation replay runs for: its `archestra` annotator calls are filed under them. */
export type OpenappaReplayOwner = {
  organizationId: string;
  userId: string | null;
};

// A replay's trajectories live only in memory, so the annotator route cannot
// find their session rows. The native annotator presents this capability
// instead; it lives only until its replay settles and is never persisted.
const replays = new Map<string, OpenappaReplayOwner>();

export async function withOpenappaReplayOwner<T>(
  owner: OpenappaReplayOwner,
  run: (annotatorContext: string) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  replays.set(token, owner);
  try {
    return await run(token);
  } finally {
    replays.delete(token);
  }
}

/**
 * The replay a capability names, or null when it names none. Called only after
 * the route proves loopback and the process bridge bearer.
 */
export function openappaReplayOwner(
  token: string | undefined,
): OpenappaReplayOwner | null {
  return token === undefined ? null : (replays.get(token) ?? null);
}
