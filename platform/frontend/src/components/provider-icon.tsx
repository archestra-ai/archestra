import type { ClientFamily, SupportedProvider } from "@archestra/shared";
import { Key } from "lucide-react";
import Image from "next/image";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";

/**
 * Logo for a client family: its own mark when it has one (Cursor), else its
 * vendor's provider logo (Claude → Anthropic, Codex → OpenAI).
 */
export function ClientIcon({
  client,
  size = 16,
}: {
  client: Pick<ClientFamily, "label" | "provider" | "icon">;
  size?: number;
}) {
  if (client.icon) {
    return (
      <Image
        src={client.icon}
        alt={client.label}
        width={size}
        height={size}
        className="shrink-0 rounded dark:invert"
      />
    );
  }
  return <ProviderIcon provider={client.provider} size={size} />;
}

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
