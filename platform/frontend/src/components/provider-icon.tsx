import type { ClientFamily, SupportedProvider } from "@archestra/shared";
import { Key } from "lucide-react";
import Image from "next/image";
import { ClientMarkTile } from "@/components/client-mark-tile";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";

/**
 * Logo for a client family: its mark on its tile when it has one (OpenCode,
 * Kilo Code), drawn as the Connect page draws it; else its own image (Cursor);
 * else its vendor's provider logo (Claude → Anthropic, Codex → OpenAI).
 */
export function ClientIcon({
  client,
  size = 16,
}: {
  client: Pick<ClientFamily, "label" | "provider" | "icon" | "mark">;
  size?: number;
}) {
  if (client.mark) {
    return (
      <ClientMarkTile mark={client.mark} label={client.label} size={size} />
    );
  }
  if (client.icon) {
    return (
      <span
        className="relative block shrink-0"
        style={{ width: size, height: size }}
      >
        <Image
          src={client.icon}
          alt={client.label}
          fill
          sizes={`${size}px`}
          className="rounded object-contain dark:invert"
        />
      </span>
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
