import { z } from "zod";

export const ModelCapabilitySchema = z.enum([
  "chat", "vision", "multimodal", "audio", "code", "reasoning",
  "function-calling", "json-mode", "streaming", "parallel-tools", "system-prompt", "context-window",
  "image-gen", "embedding", "fine-tuned"
]);

export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export interface ModelCapabilityPatterns {
  patterns: { capability: ModelCapability; pattern: RegExp; priority?: number }[];
}

export const ModelCapabilitiesSchema = z.object({
  capabilities: z.array(ModelCapabilitySchema),
  metadata: z.object({
    maxTokens: z.number().optional(),
    supportsImages: z.boolean().optional(),
    supportsAudio: z.boolean().optional(),
    supportsVideo: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsFunctionCalling: z.boolean().optional(),
    supportsJsonMode: z.boolean().optional(),
    hasReasoning: z.boolean().optional(),
  }).optional(),
});

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const CAPABILITY_INFO: Record<ModelCapability, { icon: string; label: string; description: string; priority: number }> = {
  reasoning: { icon: "Brain", label: "Reasoning", description: "Extended chain-of-thought reasoning", priority: 1 },
  vision: { icon: "Eye", label: "Vision", description: "Can analyze and understand images", priority: 2 },
  multimodal: { icon: "Layers", label: "Multimodal", description: "Supports mixed inputs (text, images, audio)", priority: 3 },
  audio: { icon: "Mic", label: "Audio", description: "Can process audio input/output", priority: 4 },
  code: { icon: "Code2", label: "Code", description: "Optimized for code tasks", priority: 5 },
  chat: { icon: "MessageSquare", label: "Chat", description: "General conversation", priority: 6 },
  "function-calling": { icon: "Zap", label: "Tools", description: "Function/tool calling support", priority: 7 },
  "json-mode": { icon: "FileJson", label: "JSON", description: "Guaranteed JSON output", priority: 8 },
  streaming: { icon: "Zap", label: "Streaming", description: "Streaming responses", priority: 9 },
  "parallel-tools": { icon: "GitBranch", label: "Parallel", description: "Parallel tool execution", priority: 10 },
  "system-prompt": { icon: "Terminal", label: "System", description: "System prompts supported", priority: 11 },
  "context-window": { icon: "Expand", label: "Large Context", description: "Extended context window", priority: 12 },
  "image-gen": { icon: "ImagePlus", label: "Images", description: "Image generation", priority: 13 },
  embedding: { icon: "Database", label: "Embeddings", description: "Text embeddings", priority: 14 },
  "fine-tuned": { icon: "Sparkles", label: "Fine-tuned", description: "Custom fine-tuned model", priority: 15 },
};
