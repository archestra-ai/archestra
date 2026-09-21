import { AppaPluginArchestra } from "./plugin";
import { APPA_CLIENT_ADAPTERS } from "./session-identity";

export function createAppaLlmProxyPlugin(): AppaPluginArchestra {
  return new AppaPluginArchestra(APPA_CLIENT_ADAPTERS);
}
