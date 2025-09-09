import { app } from 'electron';
import path from 'node:path';

/**
 * NOTE: in certain cases, such as when running the codegen commands, these environment variables will not be
 * set and hence why we default to /tmp.
 *
 * Otherwise, you end up with:
 * node:path:1304
 *   validateString(arg, 'path');
 *   ^
 *
 * TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined
 *   at Object.join (node:path:1304:7)
 *   at path (./desktop_app/src/backend/utils/paths.ts:11:35)
 *   at Object.<anonymous> (./desktop_app/src/backend/utils/paths.ts:12:99)
 *   at Module._compile (node:internal/modules/cjs/loader:1738:14)
 *   at Object.transformer (./desktop_app/node_modules/tsx/dist/register-D46fvsV_.cjs:3:1104)
 *   at Module.load (node:internal/modules/cjs/loader:1472:32)
 *   at Module._load (node:internal/modules/cjs/loader:1289:12)
 *   at c._load (node:electron/js2c/node_init:2:18013)
 *   at TracingChannel.traceSync (node:diagnostics_channel:322:14)
 *   at wrapModuleLoad (node:internal/modules/cjs/loader:242:24) {
 *   code: 'ERR_INVALID_ARG_TYPE'
 */
export const USER_DATA_DIRECTORY = app.getPath('userData') || '/tmp';
export const LOGS_DIRECTORY = app.getPath('logs') || '/tmp';

export const DATABASE_PATH = path.join(USER_DATA_DIRECTORY, 'archestra.db');
export const PODMAN_REGISTRY_AUTH_FILE_PATH = path.join(USER_DATA_DIRECTORY, 'podman', 'auth.json');
