import config from "@/config";
import type { AppaControlServiceProvider } from "@/routes/mcp-gateway/appa-controls";
import {
  DurableAppaControlService,
  HttpAppaControlRuntime,
} from "./appa-control";

export const configuredAppaControlProvider: AppaControlServiceProvider = () => {
  const settings = config.llmProxy.appaHook;
  if (
    !settings?.nativeCodexEnabled ||
    !settings.runtimeToken ||
    !settings.approvalSigningSecret
  ) {
    return undefined;
  }
  return new DurableAppaControlService({
    runtime: new HttpAppaControlRuntime({
      url: settings.url,
      runtimeToken: settings.runtimeToken,
      timeoutMs: settings.timeoutMs,
    }),
    controlSessionSecret: settings.sessionHmacSecret,
    approvalSigningSecret: settings.approvalSigningSecret,
  });
};
