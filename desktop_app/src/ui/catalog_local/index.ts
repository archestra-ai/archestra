import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';

// Mark local catalog items with a special property
export interface LocalMcpServerManifest extends ArchestraMcpServerManifest {
  isLocalDeveloper?: boolean;
}

// Only load local catalog in development mode
let catalogFiles: Record<string, any> = {};
if (import.meta.env.DEV) {
  // Dynamically import all JSON files in this folder
  // Vite's import.meta.glob allows us to import all matching files
  catalogFiles = import.meta.glob('./*.json', { eager: true });
}

// Process all imported JSON files and mark them as local developer servers
// In production, this will be an empty array
export const localCatalogServers: LocalMcpServerManifest[] = import.meta.env.DEV
  ? Object.entries(catalogFiles).map(([path, module]) => {
      // The module is the imported JSON content
      const server = module as ArchestraMcpServerManifest;

      return {
        ...server,
        isLocalDeveloper: true,
      };
    })
  : [];

// Helper to check if a server is from local catalog
export const isLocalCatalogServer = (serverName: string): boolean => {
  return localCatalogServers.some((server) => server.name === serverName);
};

// Log loaded local catalog servers for debugging
if (import.meta.env.DEV && localCatalogServers.length > 0) {
  console.log(
    `Loaded ${localCatalogServers.length} local catalog servers:`,
    localCatalogServers.map((s) => s.name)
  );
}
