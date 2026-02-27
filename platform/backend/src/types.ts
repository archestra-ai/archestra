```typescript
import { z } from "zod";

// ... existing code

export const SupportedChatProviderSchema = z.enum([
  "anthropic",
  "openai",
  "xai-grok", // Add x.ai (Grok) support
]);