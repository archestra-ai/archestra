import type { SupportedProvider } from "@archestra/shared";
import { Key } from "lucide-react";
import Image from "next/image";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";

/** Small provider logo, matching the icon shown in the LLM key dropdowns. */
export function ProviderIcon({
  provider,
  size = 16,
}: {
  provider: SupportedProvider;
  size?: number;
}) {
  const config = PROVIDER_CONFIG[provider];
  if (!config?.icon) {
    return <Key className="shrink-0" style={{ width: size, height: size }} />;
  }
  return (
    <Image
      src={config.icon}
      alt={config.name}
      width={size}
      height={size}
      className="shrink-0 rounded dark:invert"
    />
  );
}
