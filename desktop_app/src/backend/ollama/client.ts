import { z } from 'zod';

import config from '@backend/config';
import { ToolAnalysisResultSchema } from '@backend/database/schema/tool';
import log from '@backend/utils/logger';
import WebSocketService from '@backend/websocket';

const OllamaGenerateRequestSchema = z.object({
  model: z.string(),
  prompt: z.string(),
  stream: z.boolean().optional().default(false),
  format: z.enum(['json']).optional(),
  options: z
    .object({
      temperature: z.number().optional(),
      top_k: z.number().optional(),
      top_p: z.number().optional(),
      num_predict: z.number().optional(),
      stop: z.array(z.string()).optional(),
    })
    .optional(),
});

const OllamaGenerateResponseSchema = z.object({
  model: z.string(),
  created_at: z.string(),
  response: z.string(),
  done: z.boolean(),
  context: z.array(z.number()).optional(),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  eval_count: z.number().optional(),
  eval_duration: z.number().optional(),
});

const OllamaPullRequestSchema = z.object({
  name: z.string(),
  insecure: z.boolean().optional(),
  stream: z.boolean().optional(),
});

const OllamaPullResponseSchema = z.object({
  status: z.string(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
});

const OllamaListResponseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string(),
      modified_at: z.string(),
      size: z.number(),
      digest: z.string(),
      details: z
        .object({
          parent_model: z.string().optional(),
          format: z.string().optional(),
          family: z.string().optional(),
          families: z.array(z.string()).optional(),
          parameter_size: z.string().optional(),
          quantization_level: z.string().optional(),
        })
        .optional(),
    })
  ),
});

type OllamaGenerateRequest = z.infer<typeof OllamaGenerateRequestSchema>;
type OllamaGenerateResponse = z.infer<typeof OllamaGenerateResponseSchema>;
type OllamaPullRequest = z.infer<typeof OllamaPullRequestSchema>;
type OllamaListResponse = z.infer<typeof OllamaListResponseSchema>;

class OllamaClient {
  private baseUrl: string;
  private modelAvailability: Record<string, boolean> = {};
  private modelAvailabilityPromises: Record<string, Promise<void>> = {};
  private contextWindowCache: Map<string, number> = new Map();

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || config.ollama.server.host;
  }

  /**
   * Wait for a specific model to be available
   */
  private async waitForModel(modelName: string): Promise<void> {
    // If model is already available, return immediately
    if (this.modelAvailability[modelName] === true) {
      return;
    }

    // If there's already a promise waiting for this model, reuse it
    if (modelName in this.modelAvailabilityPromises) {
      return this.modelAvailabilityPromises[modelName];
    }

    // Create a new promise to wait for the model
    this.modelAvailabilityPromises[modelName] = new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.modelAvailability[modelName] === true) {
          clearInterval(checkInterval);
          delete this.modelAvailabilityPromises[modelName];
          resolve();
        }
      }, 500); // Check every 500ms
    });

    return this.modelAvailabilityPromises[modelName];
  }

  /**
   * Generate a completion from a model
   * Waits for the requested model to be available before making the API call
   */
  private async generate(request: OllamaGenerateRequest): Promise<OllamaGenerateResponse> {
    try {
      // Wait for the model to be available before making the request
      await this.waitForModel(request.model);

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Ollama generate failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return OllamaGenerateResponseSchema.parse(data);
    } catch (error) {
      log.error('Failed to generate completion:', error);
      throw error;
    }
  }

  /**
   * Pull a model from the Ollama library
   */
  async pull(request: OllamaPullRequest): Promise<void> {
    try {
      const streamingRequest = { ...request, stream: true };

      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(streamingRequest),
      });

      if (!response.ok) {
        throw new Error(`Ollama pull failed: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      WebSocketService.broadcast({
        type: 'ollama-model-download-progress',
        payload: {
          model: request.name,
          status: 'downloading',
          progress: 0,
          message: 'Starting download',
        },
      });

      let lastBroadcastedProgress = 0;
      let lastStatus: 'downloading' | 'verifying' | 'completed' = 'downloading';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter((line) => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            const parsed = OllamaPullResponseSchema.parse(data);

            let status: 'downloading' | 'verifying' | 'completed' = 'downloading';
            let progress: number = 0;

            if (parsed.status === 'success') {
              status = 'completed';
              progress = 100;
            } else if (parsed.status.includes('verifying')) {
              status = 'verifying';
            } else if (parsed.total && parsed.completed) {
              progress = Math.round((parsed.completed / parsed.total) * 100);
            }

            /**
             * Only broadcast if we have a meaningful update:
             * - Status changed
             * - Progress increased by at least 1 integer percentage
             * - Completed
             */
            const shouldBroadcast =
              status !== lastStatus ||
              (progress !== undefined && progress > lastBroadcastedProgress) ||
              status === 'completed';

            if (shouldBroadcast) {
              WebSocketService.broadcast({
                type: 'ollama-model-download-progress',
                payload: {
                  model: request.name,
                  status,
                  progress,
                  message: parsed.status,
                },
              });

              if (progress !== undefined) {
                lastBroadcastedProgress = progress;
              }
              lastStatus = status;
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }

      WebSocketService.broadcast({
        type: 'ollama-model-download-progress',
        payload: {
          model: request.name,
          status: 'completed',
          progress: 100,
          message: 'Download complete!',
        },
      });
    } catch (error) {
      WebSocketService.broadcast({
        type: 'ollama-model-download-progress',
        payload: {
          model: request.name,
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
          progress: 0,
        },
      });

      log.error(`Failed to pull model ${request.name}:`, error);
      throw error;
    }
  }

  /**
   * List available models
   */
  async list(): Promise<OllamaListResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`Ollama list failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return OllamaListResponseSchema.parse(data);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Remove/uninstall a model
   */
  async remove(modelName: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/delete`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: modelName,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama remove failed: ${response.status} ${response.statusText}`);
      }

      // Update model availability after successful removal
      this.modelAvailability[modelName] = false;

      log.info(`Successfully removed model: ${modelName}`);
    } catch (error) {
      log.error(`Failed to remove model ${modelName}:`, error);
      throw error;
    }
  }

  /**
   * Get the context window size for a specific model
   * Uses the /api/show endpoint to get model details
   * Results are cached to avoid repeated API calls
   */
  async getModelContextWindow(modelName: string): Promise<number> {
    // Check cache first
    if (this.contextWindowCache.has(modelName)) {
      return this.contextWindowCache.get(modelName)!;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get model info: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Default context window size
      let contextLength = 128000;

      // Look for context_length in model_info
      // It's typically stored as {architecture}.context_length
      if (data.model_info) {
        for (const [key, value] of Object.entries(data.model_info)) {
          if (key.endsWith('.context_length') && typeof value === 'number') {
            contextLength = value;
            break;
          }
        }
      }

      // Cache the result
      this.contextWindowCache.set(modelName, contextLength);
      log.info(`Context window for ${modelName}: ${contextLength}`);

      return contextLength;
    } catch (error) {
      log.warn(`Failed to get context window for ${modelName}, using default:`, error);
      // Cache the default to avoid repeated failed attempts
      const defaultSize = 128000;
      this.contextWindowCache.set(modelName, defaultSize);
      return defaultSize;
    }
  }

  /**
   * Analyze tools and return structured analysis results
   * Will wait for the required model to be downloaded if not already available
   */
  async analyzeTools(
    tools: Array<{
      name: string;
      description: string;
      inputSchema?: any;
      annotations?: any;
    }>
  ): Promise<Record<string, z.infer<typeof ToolAnalysisResultSchema>>> {
    // Create example to help the model understand the exact format
    const exampleOutput = {
      getTodo: {
        is_read: true,
        is_write: false,
      },
      createTodo: {
        is_read: false,
        is_write: true,
      },
    };

    const prompt = `You are an expert at analyzing API tools. Your task is to analyze tools and output ONLY valid JSON.

EXAMPLE OUTPUT FORMAT:
${JSON.stringify(exampleOutput, null, 2)}

For each tool, determine:
- is_read: true if the tool reads/retrieves/fetches/gets/lists/searches data WITHOUT modifying anything
- is_write: true if the tool creates/updates/deletes/modifies/changes data

Common patterns:
- Tools with names containing "get", "list", "read", "search", "fetch", "find" are usually is_read: true
- Tools with names containing "create", "update", "delete", "add", "remove", "set", "write", "modify" are usually is_write: true
- Some tools can be both read AND write (e.g., "executeQuery" might read or write depending on the query)

Tools to analyze:
${JSON.stringify(tools, null, 2)}

CRITICAL: Your response MUST be valid JSON that matches this EXACT structure:
{
  "toolName1": {"is_read": boolean, "is_write": boolean},
  "toolName2": {"is_read": boolean, "is_write": boolean}
}

Replace toolName1, toolName2 with actual tool names from the input.
Every tool MUST have both is_read and is_write as boolean values (true or false).
Output ONLY the JSON object, starting with { and ending with }`;

    try {
      const response = await this.generate({
        model: config.ollama.generalModel,
        prompt,
        stream: false,
        format: 'json',
      });

      let rawResult: any;
      try {
        rawResult = JSON.parse(response.response);
      } catch (parseError) {
        log.error('Failed to parse Ollama response as JSON:', response.response);
        throw new Error('Invalid JSON response from Ollama');
      }

      // Debug log to see what the model actually returned
      log.debug('Raw analysis response from Ollama:', JSON.stringify(rawResult, null, 2));

      const result: Record<string, z.infer<typeof ToolAnalysisResultSchema>> = {};

      // Ensure we have analysis for all requested tools
      for (const tool of tools) {
        const toolName = tool.name;
        const analysis = rawResult[toolName];

        try {
          // Check if we have analysis for this tool
          if (!analysis) {
            log.warn(`No analysis returned for tool ${toolName}, using name-based inference`);
            result[toolName] = this.inferToolProperties(toolName, tool.description);
            continue;
          }

          // Check if the analysis is in the correct format
          if (typeof analysis !== 'object' || analysis === null) {
            log.warn(`Tool ${toolName} has invalid format (not an object):`, analysis);
            result[toolName] = this.inferToolProperties(toolName, tool.description);
            continue;
          }

          // Ensure both required fields are present
          const validatedAnalysis = {
            is_read:
              typeof analysis.is_read === 'boolean' ? analysis.is_read : this.inferIsRead(toolName, tool.description),
            is_write:
              typeof analysis.is_write === 'boolean'
                ? analysis.is_write
                : this.inferIsWrite(toolName, tool.description),
          };

          // Validate with schema
          result[toolName] = ToolAnalysisResultSchema.parse(validatedAnalysis);
        } catch (error) {
          log.warn(`Failed to validate analysis for tool ${toolName}:`, error);
          log.debug(`Raw analysis data for ${toolName}:`, analysis);
          // Use inference as fallback
          result[toolName] = this.inferToolProperties(toolName, tool.description);
        }
      }

      return result;
    } catch (error) {
      log.error('Failed to analyze tools:', error);
      // Return inferred results for all tools as ultimate fallback
      const fallbackResult: Record<string, z.infer<typeof ToolAnalysisResultSchema>> = {};
      for (const tool of tools) {
        fallbackResult[tool.name] = this.inferToolProperties(tool.name, tool.description);
      }
      return fallbackResult;
    }
  }

  /**
   * Infer tool properties based on name and description
   */
  private inferToolProperties(name: string, description?: string): z.infer<typeof ToolAnalysisResultSchema> {
    const lowerName = name.toLowerCase();
    const lowerDesc = (description || '').toLowerCase();
    const combined = `${lowerName} ${lowerDesc}`;

    return {
      is_read: this.inferIsRead(name, description),
      is_write: this.inferIsWrite(name, description),
    };
  }

  /**
   * Infer if a tool is a read operation
   */
  private inferIsRead(name: string, description?: string): boolean {
    const lowerName = name.toLowerCase();
    const lowerDesc = (description || '').toLowerCase();
    const combined = `${lowerName} ${lowerDesc}`;

    const readPatterns = [
      'get',
      'list',
      'read',
      'search',
      'fetch',
      'find',
      'query',
      'retrieve',
      'show',
      'view',
      'describe',
      'check',
      'verify',
      'examine',
      'inspect',
      'status',
      'info',
      'detail',
      'lookup',
    ];

    return readPatterns.some((pattern) => combined.includes(pattern));
  }

  /**
   * Infer if a tool is a write operation
   */
  private inferIsWrite(name: string, description?: string): boolean {
    const lowerName = name.toLowerCase();
    const lowerDesc = (description || '').toLowerCase();
    const combined = `${lowerName} ${lowerDesc}`;

    const writePatterns = [
      'create',
      'update',
      'delete',
      'add',
      'remove',
      'set',
      'write',
      'modify',
      'edit',
      'change',
      'insert',
      'append',
      'replace',
      'clear',
      'reset',
      'submit',
      'post',
      'put',
      'patch',
      'destroy',
      'drop',
      'truncate',
      'execute',
      'run',
      'apply',
      'commit',
      'save',
      'store',
    ];

    return writePatterns.some((pattern) => combined.includes(pattern));
  }

  /**
   * Generate a chat title based on messages
   * Will wait for the required model to be downloaded if not already available
   */
  async generateChatTitle(messages: string[]): Promise<string> {
    const prompt = `Generate a short, concise title (3-6 words) for a chat conversation that includes the following messages:

${messages.join('\n\n')}

The title should capture the main topic or theme of the conversation. Respond with ONLY the title, no quotes, no explanation. DON'T WRAP THE TITLE IN QUOTES!!!`;

    try {
      const response = await this.generate({
        model: config.ollama.generalModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.5,
          num_predict: 15,
        },
      });

      return response.response.trim();
    } catch (error) {
      log.error('Failed to generate chat title:', error);
      throw error;
    }
  }

  /**
   * Wait for the Ollama server to be ready to accept requests
   */
  private async waitForServerReady(maxRetries = 30, retryDelay = 1000): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.list();
        log.info('Ollama server is ready');
        return;
      } catch (error) {
        if (i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
    throw new Error('Ollama server failed to become ready after maximum retries');
  }

  /**
   * Ensure that required models are available, downloading them if necessary
   * Populates the model availability map which is used by generate() to wait for models
   */
  async ensureModelsAvailable(): Promise<void> {
    await this.waitForServerReady();

    try {
      const { models: installedModels } = await this.list();
      const installedModelNames = installedModels.map((m) => m.name);

      // Update model availability for all installed models
      installedModelNames.forEach((modelName) => {
        this.modelAvailability[modelName] = true;
      });

      const modelsToDownload = config.ollama.requiredModels.filter(
        ({ model: modelName }) => !installedModelNames.includes(modelName)
      );

      log.info(`Downloading ${modelsToDownload.length} required models...`);

      const downloadPromises = modelsToDownload.map(async ({ model: modelName }) => {
        log.info(`Starting download for model '${modelName}'...`);
        try {
          await this.pull({ name: modelName });
          log.info(`Successfully downloaded model '${modelName}'`);
          // Mark model as available after successful download
          this.modelAvailability[modelName] = true;
        } catch (error) {
          log.error(`Failed to download model '${modelName}':`, error);
          // Don't throw - allow other models to continue downloading
        }
      });

      await Promise.all(downloadPromises);

      log.info('Finished downloading required models');
    } catch (error) {
      log.error('Failed to ensure models are available:', error);
      // Don't throw here - server should still work even if models aren't downloaded
    }
  }
}

export default new OllamaClient();
