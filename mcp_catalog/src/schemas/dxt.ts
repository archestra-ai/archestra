/**
 * The latest version of @anthropic-ai/dxt, as of this writing, is v0.2.6
 *
 * In this version, they use v3 zod schemas. However, for some of the fastify functionality that we use, we
 * need to use zod v4. v3 and v4 schemas don't seem to be compatible.
 *
 * So for now, the following exports represent a copy of what's in the latest version of @anthropic-ai/dxt,
 *
 * https://github.com/anthropics/dxt/blob/v0.2.6/src/schemas.ts
 */
import * as z from 'zod';

// DxtManifestSchema,
//   DxtManifestServerSchema,
//   DxtUserConfigurationOptionSchema,
//   McpServerConfigSchema,

export const McpServerConfigSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const DxtManifestAuthorSchema = z.strictObject({
  name: z.string(),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

const DxtManifestPlatformOverrideSchema = McpServerConfigSchema.partial();

const DxtManifestMcpConfigSchema = McpServerConfigSchema.extend({
  platform_overrides: z.record(z.string(), DxtManifestPlatformOverrideSchema).optional(),
});

export const DxtManifestServerSchema = z.strictObject({
  type: z.enum(['python', 'node', 'binary']),
  entry_point: z.string(),
  mcp_config: DxtManifestMcpConfigSchema,
});

const DxtManifestCompatibilitySchema = z
  .strictObject({
    claude_desktop: z.string().optional(),
    platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).optional(),
    runtimes: z
      .strictObject({
        python: z.string().optional(),
        node: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const DxtManifestToolSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
});

const DxtManifestPromptSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  text: z.string(),
});

export const DxtUserConfigurationOptionSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const DxtManifestSchema = z.strictObject({
  $schema: z.string().optional(),
  dxt_version: z.string(),
  name: z.string(),
  display_name: z.string().optional(),
  version: z.string(),
  description: z.string(),
  long_description: z.string().optional(),
  author: DxtManifestAuthorSchema,
  /**
   * NOTE: we don't use repository, so let's just omit it here
   */
  // repository: DxtManifestRepositorySchema.optional(),
  homepage: z.string().url().optional(),
  documentation: z.string().url().optional(),
  support: z.string().url().optional(),
  icon: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  server: DxtManifestServerSchema,
  tools: z.array(DxtManifestToolSchema).optional(),
  tools_generated: z.boolean().optional(),
  prompts: z.array(DxtManifestPromptSchema).optional(),
  prompts_generated: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
  license: z.string().optional(),
  compatibility: DxtManifestCompatibilitySchema.optional(),
  user_config: z.record(z.string(), DxtUserConfigurationOptionSchema).optional(),
});
