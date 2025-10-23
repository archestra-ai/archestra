import type { ProviderInfo } from "@shared";
import { getDisplayProxyUrl } from "./config";

export const PROVIDER_INFO = {
  openai: {
    label: "OpenAI",
    baseUrl: `${getDisplayProxyUrl()}/openai`,
    docs: "https://platform.openai.com/docs",
    snippet: `import OpenAI from 'openai';

const client = new OpenAI({
baseURL: '${getDisplayProxyUrl()}/openai',
apiKey: process.env.OPENAI_API_KEY,
});`,
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: `${getDisplayProxyUrl()}/anthropic`,
    docs: "https://docs.anthropic.com/",
    snippet: `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: '${getDisplayProxyUrl()}/anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
});`,
  },
} as { openai: ProviderInfo; anthropic: ProviderInfo };
export type Provider = keyof typeof PROVIDER_INFO;
