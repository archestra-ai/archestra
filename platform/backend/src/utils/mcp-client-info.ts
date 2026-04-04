import config from "@/config";

export function buildMcpClientInfo(name: string): {
  name: string;
  version: string;
} {
  return {
    name,
    version: config.api.version,
  };
}
