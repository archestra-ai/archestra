export const PROVIDER_INFO = {
  openai: {
    label: "OpenAI",
    baseUrl: "http://localhost:9000/v1/openai",
    docs: "https://platform.openai.com/docs",
    snippet: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:9000/v1/openai',
  apiKey: process.env.OPENAI_API_KEY,
});`,
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "http://localhost:9000/v1/anthropic",
    docs: "https://docs.anthropic.com/",
    snippet: `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:9000/v1/anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
});`,
  },
} as const;

export const FRAMEWORK_DOCS = {
  n8n: "https://archestra.ai/docs/platform-n8n-example",
  langchain: "https://archestra.ai/docs/platform-langchain-example",
  openwebui: "https://archestra.ai/docs/platform-openwebui-example",
} as const;
