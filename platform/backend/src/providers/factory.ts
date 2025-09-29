import { z } from 'zod';

import { OpenAIProvider } from './openai';
import type { LLMProvider } from './types';

export const SupportedProvidersSchema = z.enum(['openai']);
export type SupportedProviders = z.infer<typeof SupportedProvidersSchema>;

export const createProvider = (
  provider: SupportedProviders,
  apiKey: string
): LLMProvider => {
  switch (provider) {
    case 'openai':
      return new OpenAIProvider(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
};
