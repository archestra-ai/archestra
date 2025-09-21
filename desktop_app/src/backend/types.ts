import { type experimental_MCPClient } from 'ai';

export type SupportedPlatform = 'linux' | 'mac' | 'win';
export type SupportedArchitecture = 'arm64' | 'x86_64';

/**
 * NOTE: `gvproxy` and `vfkit` MUST be named explicitly `gvproxy` and `vfkit` respectively.
 *
 * For more details (and on which versions these correspond to) see comments in
 * `PodmanRuntime` (in `src/backend/sandbox/podman/runtime/index.ts`)
 */
export type SupportedBinary = 'ollama-v0.11.4' | 'podman-remote-static-v5.5.2' | 'gvproxy' | 'vfkit';

export type McpTools = Awaited<ReturnType<experimental_MCPClient['tools']>>;
