"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { InstalledServer } from "./mcp-server-card";

/**
 * The installs of the catalog items on the registry's current page. The list
 * loads them once per page (`GET /api/mcp_server?catalogIds=…`) and every row
 * reads them from here instead of loading every install in the organization.
 */
const RegistryPageServersContext = createContext<InstalledServer[] | undefined>(
  undefined,
);

export function RegistryPageServersProvider({
  servers,
  children,
}: {
  servers: InstalledServer[] | undefined;
  children: ReactNode;
}) {
  return (
    <RegistryPageServersContext.Provider value={servers}>
      {children}
    </RegistryPageServersContext.Provider>
  );
}

/** Undefined while the page's installs are loading. */
export function useRegistryPageServers(): InstalledServer[] | undefined {
  return useContext(RegistryPageServersContext);
}
