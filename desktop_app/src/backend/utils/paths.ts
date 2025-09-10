import { app } from 'electron';
import path from 'node:path';

let DATABASE_FILE_NAME: string;
export let USER_DATA_DIRECTORY: string;
export let LOGS_DIRECTORY: string;

try {
  DATABASE_FILE_NAME = app.isPackaged ? 'archestra.db' : 'archestra-dev.db';
  USER_DATA_DIRECTORY = app.getPath('userData');
  LOGS_DIRECTORY = app.getPath('logs');
} catch (error) {
  /**
   * NOTE: in certain cases, such as when running the codegen commands, app, from electron, is not availaable
   * and hence why we default to /tmp.
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
  DATABASE_FILE_NAME = 'archestra-dev.db';
  USER_DATA_DIRECTORY = '/tmp';
  LOGS_DIRECTORY = '/tmp';
}

// Use different database path for development vs production
export const DATABASE_PATH = path.join(USER_DATA_DIRECTORY, DATABASE_FILE_NAME);
export const PODMAN_REGISTRY_AUTH_FILE_PATH = path.join(USER_DATA_DIRECTORY, 'podman', 'auth.json');
