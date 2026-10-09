import type { SupportedProvider } from "./model-constants";

/** Droid's BYOK dialect and local credential variable for each proxy wire. */
export const DROID_PROVIDER_ROUTES = [
  {
    provider: "anthropic",
    dialect: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    credentialHosts: ["api.anthropic.com"],
  },
  {
    provider: "openai",
    dialect: "openai",
    credentialEnv: "OPENAI_API_KEY",
    credentialHosts: ["api.openai.com"],
  },
  ...(
    [
      ["openrouter", "OPENROUTER_API_KEY", "openrouter.ai"],
      ["vllm", "VLLM_API_KEY", ""],
      ["ollama", "OLLAMA_API_KEY", "ollama.com"],
      ["groq", "GROQ_API_KEY", "api.groq.com"],
      ["mistral", "MISTRAL_API_KEY", "api.mistral.ai"],
      ["deepseek", "DEEPSEEK_API_KEY", "api.deepseek.com"],
      ["xai", "XAI_API_KEY", "api.x.ai"],
      ["cerebras", "CEREBRAS_API_KEY", "api.cerebras.ai"],
    ] as const satisfies readonly (readonly [
      SupportedProvider,
      string,
      string,
    ])[]
  ).map(([provider, credentialEnv, credentialHost]) => ({
    provider,
    dialect: "generic-chat-completion-api",
    credentialEnv,
    credentialHosts: credentialHost ? [credentialHost] : [],
  })),
] as const;
