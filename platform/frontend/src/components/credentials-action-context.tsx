"use client";

import { createContext, useContext } from "react";

/**
 * Lets a credentials page inject its header action button (e.g. "Create OAuth
 * Client") into the surrounding credentials layout. Shared so the same OAuth
 * clients page can render under both the MCP gateways credentials layout and
 * the agents credentials layout — each layout mounts its own provider, and the
 * page reads whichever one is above it in the tree.
 */
type CredentialsActionContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

export const CredentialsActionContext =
  createContext<CredentialsActionContextType>({
    setActionButton: () => {},
  });

export function useSetCredentialsAction() {
  return useContext(CredentialsActionContext).setActionButton;
}
