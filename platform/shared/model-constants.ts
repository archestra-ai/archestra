import type { SupportedProviders } from "./hey-api/clients/api";

type Providers = Extract<SupportedProviders, "openai" | "anthropic">;

export const providerDisplayNames: Record<Providers, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export const modelsByProvider: Record<Providers, string[]> = {
  anthropic: [
    "claude-opus-4.5",
    "claude-haiku-4.5",
    "claude-sonnet-4.5",
    "claude-opus-4.1",
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-3.7-sonnet",
    "claude-3.5-haiku",
    "claude-3.5-sonnet",
    "claude-3-haiku",
    "claude-3-opus",
  ],
  openai: [
    "gpt-5.1",
    "gpt-5.1-chat",
    "gpt-5-pro",
    "gpt-5-chat",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-4",
    "o1-pro",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
  ],
};
