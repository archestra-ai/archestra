import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";

/**
 * What the "Choose what to include" switches say to include. The copied
 * command carries whatever is off (the prompt, for generic agents); this
 * browser keeps the switches as they were left, per client. A stale or missing
 * entry reads as everything included.
 */
export interface ConnectChoices {
  tools: boolean;
  skills: boolean;
  proxy: boolean;
  plugins: boolean;
}

export const ALL_INCLUDED: ConnectChoices = {
  tools: true,
  skills: true,
  proxy: true,
  plugins: true,
};

/**
 * Picks that go past the switches. null keeps the default: the org's
 * gateway, and every plugin on offer (including ones approved later).
 */
export interface ConnectPicks {
  gatewayId: string | null;
  /** The plugins kept, as a snapshot of ids. */
  pluginIds: string[] | null;
}

export const DEFAULT_PICKS: ConnectPicks = { gatewayId: null, pluginIds: null };

// Long enough to survive a reload or a detour, short enough that a later
// visit starts from the full setup again.
const MAX_AGE_MS = 3 * CONNECTION_SETUP_WINDOW_MS;

const storageKey = (clientId: string) =>
  `archestra:connect-choices:${clientId}`;

type Saved = Partial<ConnectChoices & ConnectPicks> & { savedAt?: number };

/** The saved entry for this client, unless it is missing or stale. */
function readSaved(clientId: string): Saved | null {
  try {
    const raw = window.localStorage.getItem(storageKey(clientId));
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    if (!saved.savedAt || Date.now() - saved.savedAt > MAX_AGE_MS) return null;
    return saved;
  } catch {
    return null;
  }
}

export function readConnectChoices(clientId: string): ConnectChoices {
  const saved = readSaved(clientId);
  if (!saved) return ALL_INCLUDED;
  return {
    tools: saved.tools !== false,
    skills: saved.skills !== false,
    proxy: saved.proxy !== false,
    plugins: saved.plugins !== false,
  };
}

export function readConnectPicks(clientId: string): ConnectPicks {
  const saved = readSaved(clientId);
  return {
    gatewayId: typeof saved?.gatewayId === "string" ? saved.gatewayId : null,
    pluginIds: Array.isArray(saved?.pluginIds)
      ? saved.pluginIds.filter((id): id is string => typeof id === "string")
      : null,
  };
}

export function saveConnectChoices(
  clientId: string,
  choices: ConnectChoices,
  picks: ConnectPicks = DEFAULT_PICKS,
) {
  try {
    window.localStorage.setItem(
      storageKey(clientId),
      JSON.stringify({ ...choices, ...picks, savedAt: Date.now() }),
    );
  } catch {
    // Storage unavailable: the approval page falls back to the full setup.
  }
}
