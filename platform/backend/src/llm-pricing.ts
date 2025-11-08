export const pricing = {
  OpenAI: {
    // GPT-4o (recommended)
    "gpt-4o": {
      input: 2.50,
      output: 10.00,
      cachedInput: 1.25  // 50% discount for cached prompts
    },
    "gpt-4o-2024-11-20": { input: 2.50, output: 10.00, cachedInput: 1.25 },
    "gpt-4o-2024-08-06": { input: 2.50, output: 10.00, cachedInput: 1.25 },
    "gpt-4o-2024-05-13": { input: 5.00, output: 15.00, cachedInput: 2.50 },

    "gpt-4o-mini": {
      input: 0.15,
      output: 0.60,
      cachedInput: 0.075
    },
    "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.60, cachedInput: 0.075 },

    // GPT-4 Turbo
    "gpt-4-turbo": { input: 10.00, output: 30.00 },
    "gpt-4-turbo-2024-04-09": { input: 10.00, output: 30.00 },
    "gpt-4-turbo-preview": { input: 10.00, output: 30.00 },
    "gpt-4-0125-preview": { input: 10.00, output: 30.00 },
    "gpt-4-1106-preview": { input: 10.00, output: 30.00 },

    // GPT-4 (legacy)
    "gpt-4": { input: 30.00, output: 60.00 },
    "gpt-4-0613": { input: 30.00, output: 60.00 },
    "gpt-4-32k": { input: 60.00, output: 120.00 },
    "gpt-4-32k-0613": { input: 60.00, output: 120.00 },

    // GPT-3.5 Turbo
    "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
    "gpt-3.5-turbo-0125": { input: 0.50, output: 1.50 },
    "gpt-3.5-turbo-1106": { input: 1.00, output: 2.00 },

    // O1 (reasoning models)
    "o1": { input: 15.00, output: 60.00, cachedInput: 7.50 },
    "o1-2024-12-17": { input: 15.00, output: 60.00, cachedInput: 7.50 },
    "o1-preview": { input: 15.00, output: 60.00, cachedInput: 7.50 },
    "o1-preview-2024-09-12": { input: 15.00, output: 60.00, cachedInput: 7.50 },
    "o1-mini": { input: 3.00, output: 12.00, cachedInput: 1.50 },
    "o1-mini-2024-09-12": { input: 3.00, output: 12.00, cachedInput: 1.50 },
  } as const,
}
