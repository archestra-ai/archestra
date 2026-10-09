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

// Long enough to survive a reload or a detour, short enough that a later
// visit starts from the full setup again.
const MAX_AGE_MS = 3 * CONNECTION_SETUP_WINDOW_MS;

const storageKey = (clientId: string) =>
  `archestra:connect-choices:${clientId}`;

export function readConnectChoices(clientId: string): ConnectChoices {
  try {
    const raw = window.localStorage.getItem(storageKey(clientId));
    if (!raw) return ALL_INCLUDED;
    const saved = JSON.parse(raw) as Partial<ConnectChoices> & {
      savedAt?: number;
    };
    if (!saved.savedAt || Date.now() - saved.savedAt > MAX_AGE_MS) {
      return ALL_INCLUDED;
    }
    return {
      tools: saved.tools !== false,
      skills: saved.skills !== false,
      proxy: saved.proxy !== false,
      plugins: saved.plugins !== false,
    };
  } catch {
    return ALL_INCLUDED;
  }
}

export function saveConnectChoices(clientId: string, choices: ConnectChoices) {
  try {
    window.localStorage.setItem(
      storageKey(clientId),
      JSON.stringify({ ...choices, savedAt: Date.now() }),
    );
  } catch {
    // Storage unavailable: the approval page falls back to the full setup.
  }
}
