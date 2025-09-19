import config from '@ui/config';
import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';

// Only load local catalog in development mode
let catalogFiles: Record<string, ArchestraMcpServerManifest> = {};
if (config.isDev) {
  // Dynamically import all JSON files in this folder
  // Vite's import.meta.glob allows us to import all matching files
  catalogFiles = import.meta.glob('./*.json', { eager: true });
}

/**
 * Process all imported JSON files and mark them as local developer servers
 * In production, this will be an empty array
 */
export const localCatalogServers: ArchestraMcpServerManifest[] = config.isDev ? Object.values(catalogFiles) : [];

// Helper to check if a server is from local catalog
export const isLocalCatalogServer = (serverName: string): boolean => {
  return localCatalogServers.some((server) => server.name === serverName);
};

// Log loaded local catalog servers for debugging
if (config.isDev && localCatalogServers.length > 0) {
  console.log(
    `Loaded ${localCatalogServers.length} local catalog servers:`,
    localCatalogServers.map((s) => s.name)
  );
}
