import type { SupportedProvider } from "./model-constants";

/** Droid's BYOK dialect and local credential variable for each proxy wire. */
export const DROID_PROVIDER_ROUTES = [
  {
    provider: "anthropic",
    dialect: "anthropic",
    credentialEnvs: ["ANTHROPIC_API_KEY"],
    credentialHosts: ["api.anthropic.com"],
  },
  {
    provider: "openai",
    dialect: "openai",
    credentialEnvs: ["OPENAI_API_KEY"],
    credentialHosts: ["api.openai.com"],
  },
  ...(
    [
      ["openrouter", ["OPENROUTER_API_KEY"], ["openrouter.ai"]],
      ["vllm", ["VLLM_API_KEY"], []],
      ["ollama", ["OLLAMA_API_KEY"], ["ollama.com"]],
      ["groq", ["GROQ_API_KEY"], ["api.groq.com"]],
      ["mistral", ["MISTRAL_API_KEY"], ["api.mistral.ai"]],
      ["deepseek", ["DEEPSEEK_API_KEY"], ["api.deepseek.com"]],
      ["xai", ["XAI_API_KEY"], ["api.x.ai"]],
      ["cerebras", ["CEREBRAS_API_KEY"], ["api.cerebras.ai"]],
      [
        "zhipuai",
        ["ZAI_API_KEY", "ZHIPU_API_KEY"],
        ["api.z.ai", "open.bigmodel.cn"],
      ],
      ["minimax", ["MINIMAX_API_KEY"], ["api.minimax.io", "api.minimaxi.com"]],
      [
        "kimi",
        ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        ["api.moonshot.ai", "api.moonshot.cn"],
      ],
    ] as const satisfies readonly (readonly [
      SupportedProvider,
      readonly string[],
      readonly string[],
    ])[]
  ).map(([provider, credentialEnvs, credentialHosts]) => ({
    provider,
    dialect: "generic-chat-completion-api",
    credentialEnvs,
    credentialHosts,
  })),
] as const;
