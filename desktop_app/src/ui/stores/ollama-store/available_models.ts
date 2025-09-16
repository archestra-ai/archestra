// NOTE: see this comment here https://github.com/ollama/ollama/issues/3922#issuecomment-2079189550
// as of this writing, this list of available models was pulled from https://ollama-models.zwz.workers.dev/
// because ollama does not expose a public API for listing available models

export interface OllamaModelTag {
  tag: string;
  context: string;
  size: string;
  inputs: string[];
}

export interface OllamaModel {
  name: string;
  description: string;
  labels: string[];
  tags: OllamaModelTag[];
}

export const AVAILABLE_MODELS: OllamaModel[] = [
  {
    name: 'deepseek-r1',
    description:
      'DeepSeek-R1 is a family of open reasoning models with performance approaching that of leading models, such as O3 and Gemini 2.5 Pro',
    labels: ['tools', 'thinking', 'reasoning'],
    tags: [
      {
        tag: '1.5b',
        context: '128K',
        size: '1.1GB',
        inputs: ['Text'],
      },
      {
        tag: '7b',
        context: '128K',
        size: '4.7GB',
        inputs: ['Text'],
      },
      {
        tag: '8b',
        context: '128K',
        size: '5.2GB',
        inputs: ['Text'],
      },
      {
        tag: '14b',
        context: '128K',
        size: '9.0GB',
        inputs: ['Text'],
      },
      {
        tag: '32b',
        context: '128K',
        size: '20GB',
        inputs: ['Text'],
      },
      {
        tag: '70b',
        context: '128K',
        size: '43GB',
        inputs: ['Text'],
      },
      {
        tag: '671b',
        context: '160K',
        size: '404GB',
        inputs: ['Text'],
      },
    ],
  },
  {
    name: 'qwen3',
    description:
      'Qwen3 is the latest generation of large language models in the Qwen series, offering a comprehensive suite of dense and mixture-of-experts (MoE) models. It features seamless switching between thinking and non-thinking modes, enhanced reasoning, superior human preference alignment, agent capabilities, and support for 100+ languages.',
    labels: ['tools', 'thinking', 'reasoning', 'qwen', 'moe', 'multilingual'],
    tags: [
      {
        tag: '0.6b',
        context: '40K',
        size: '523MB',
        inputs: ['Text'],
      },
      {
        tag: '1.7b',
        context: '40K',
        size: '1.4GB',
        inputs: ['Text'],
      },
      {
        tag: '4b',
        context: '40K',
        size: '2.6GB',
        inputs: ['Text'],
      },
      {
        tag: '8b',
        context: '40K',
        size: '5.2GB',
        inputs: ['Text'],
      },
      {
        tag: '14b',
        context: '40K',
        size: '9.3GB',
        inputs: ['Text'],
      },
      {
        tag: '30b',
        context: '40K',
        size: '19GB',
        inputs: ['Text'],
      },
      {
        tag: '32b',
        context: '40K',
        size: '20GB',
        inputs: ['Text'],
      },
      {
        tag: '30b-a3b',
        context: '40K',
        size: '19GB',
        inputs: ['Text'],
      },
      {
        tag: '235b',
        context: '40K',
        size: '142GB',
        inputs: ['Text'],
      },
      {
        tag: '235b-a22b',
        context: '40K',
        size: '142GB',
        inputs: ['Text'],
      },
      {
        tag: 'latest',
        context: '40K',
        size: '5.2GB',
        inputs: ['Text'],
      },
    ],
  },
  {
    name: 'gpt-oss',
    description:
      "GPT-OSS is OpenAI's open-weight language model family with MXFP4 quantization for efficient deployment. Features native capabilities for function calling, web browsing, and structured outputs under Apache 2.0 license.",
    labels: ['tools', 'reasoning', 'openai', 'efficient'],
    tags: [
      {
        tag: '20b',
        context: '128K',
        size: '12GB',
        inputs: ['Text'],
      },
      {
        tag: '120b',
        context: '128K',
        size: '70GB',
        inputs: ['Text'],
      },
    ],
  },
];
