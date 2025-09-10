/**
 * This file is used to get the path to the binaries for a list of supported binaries.
 *
 * See https://stackoverflow.com/questions/33152533/bundling-precompiled-binary-into-electron-app
 */
import { app } from 'electron';
import fs from 'fs';
import { arch, platform } from 'os';
import path from 'path';

import type { SupportedArchitecture, SupportedBinary, SupportedPlatform } from '@backend/types';

const getPlatform = (): SupportedPlatform => {
  switch (platform()) {
    case 'aix':
    case 'freebsd':
    case 'linux':
    case 'openbsd':
    case 'android':
      return 'linux';
    case 'darwin':
    case 'sunos':
      return 'mac';
    case 'win32':
      return 'win';
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
};

const getArchitecture = (): SupportedArchitecture => {
  switch (arch()) {
    // 32-bit ARM, different from aarch64
    // case 'arm':
    //   return 'arm';
    // case 'ia32':
    //   return 'x86';
    case 'arm64':
      return 'arm64';
    // this is the same as x86_64
    case 'x64':
      return 'x86_64';
    default:
      throw new Error(`Unsupported architecture: ${arch()}`);
  }
};

const PLATFORM = getPlatform();
const ARCHITECTURE = getArchitecture();

/**
 * Get the path to the "binaries" directory
 *
 * The first conditional bit is to handle the case where this function is referenced/invoked
 * in a context where an electron app is not available (e.g. during codegen).
 */
export const getBinariesDirectory = () => {
  if (typeof app === 'undefined' || !app || !app.isPackaged) {
    return path.join(process.cwd(), 'resources', 'bin', PLATFORM, ARCHITECTURE);
  }

  return app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources', 'bin', PLATFORM, ARCHITECTURE);
};

export const getBinaryExecPath = (binaryName: SupportedBinary) => {
  const binaryPath = path.resolve(
    path.join(getBinariesDirectory(), `${binaryName}${PLATFORM === 'win' ? '.exe' : ''}`)
  );
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary ${binaryName} not found at ${binaryPath}`);
  }
  return binaryPath;
};
