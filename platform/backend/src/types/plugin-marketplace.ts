import type { ClientType } from "./plugin";

export interface PluginMarketplaceDiscoveryEntry {
  marketplacePath: string;
  name: string;
  description: string;
  version: string;
  clientType: ClientType | null;
  sourceRepoUrl: string | null;
  sourceRef: string | null;
  sourceSubdir: string;
  sourceCommitSha: string | null;
  fileCount: number;
  supported: boolean;
  reason: string | null;
}

export interface PluginMarketplaceDiscovery {
  repoUrl: string;
  ref: string | null;
  commitSha: string;
  marketplacePath: string | null;
  entries: PluginMarketplaceDiscoveryEntry[];
  reason: string | null;
}
