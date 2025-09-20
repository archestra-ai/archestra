import fs from 'fs';
import * as os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/mock/app/path'),
  },
}));

// Mock fs
vi.mock('fs');

// Mock os - but don't set default values yet
vi.mock('os');

// Test setup helper to reduce duplication
function setupMocks(options: {
  platform: NodeJS.Platform | string;
  arch: NodeJS.Architecture | string;
  fileExists?: boolean;
  isPackaged?: boolean;
  appPath?: string;
  resourcesPath?: string;
}) {
  const { platform, arch, fileExists = true, isPackaged = false, appPath = '/mock/app/path', resourcesPath } = options;

  vi.mocked(os.platform).mockReturnValue(platform as NodeJS.Platform);
  vi.mocked(os.arch).mockReturnValue(arch as NodeJS.Architecture);
  vi.mocked(fs.existsSync).mockReturnValue(fileExists);

  if (isPackaged !== undefined || appPath !== '/mock/app/path') {
    vi.doMock('electron', () => ({
      app: {
        isPackaged,
        getAppPath: vi.fn(() => appPath),
      },
    }));
  }

  if (resourcesPath !== undefined) {
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    });
  }
}

describe('binaries utilities', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('getBinaryExecPath', () => {
    describe('platform detection', () => {
      it('should handle linux platforms', async () => {
        setupMocks({ platform: 'linux', arch: 'x64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toContain(path.join('linux', 'x86_64', 'ollama-v0.11.4'));
      });

      it('should handle mac platform', async () => {
        setupMocks({ platform: 'darwin', arch: 'arm64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toContain(path.join('mac', 'arm64', 'ollama-v0.11.4'));
      });

      it('should handle windows platform', async () => {
        setupMocks({ platform: 'win32', arch: 'x64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toContain(path.join('win', 'x86_64', 'ollama-v0.11.4.exe'));
      });

      it('should map various linux platform identifiers', async () => {
        const linuxPlatforms = ['aix', 'freebsd', 'linux', 'openbsd', 'android'];

        for (const platform of linuxPlatforms) {
          vi.resetModules();
          setupMocks({ platform, arch: 'x64' });

          const { getBinaryExecPath } = await import('./');
          const binaryPath = getBinaryExecPath('ollama-v0.11.4');
          expect(binaryPath).toContain(path.join('linux', 'x86_64'));
        }
      });

      it('should map darwin and sunos to mac', async () => {
        const macPlatforms = ['darwin', 'sunos'];

        for (const platform of macPlatforms) {
          vi.resetModules();
          setupMocks({ platform, arch: 'x64' });

          const { getBinaryExecPath } = await import('./');
          const binaryPath = getBinaryExecPath('ollama-v0.11.4');
          expect(binaryPath).toContain(path.join('mac', 'x86_64'));
        }
      });

      it('should throw error for unsupported platform', async () => {
        setupMocks({ platform: 'unsupported', arch: 'x64' });

        await expect(import('./')).rejects.toThrow('Unsupported platform: unsupported');
      });
    });

    describe('architecture detection', () => {
      it('should handle arm64 architecture', async () => {
        setupMocks({ platform: 'darwin', arch: 'arm64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toContain(path.join('mac', 'arm64'));
      });

      it('should map x64 to x86_64', async () => {
        setupMocks({ platform: 'linux', arch: 'x64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toContain(path.join('linux', 'x86_64'));
      });

      it('should throw error for unsupported architecture', async () => {
        setupMocks({ platform: 'linux', arch: 'ia32' });

        await expect(import('./')).rejects.toThrow('Unsupported architecture: ia32');
      });
    });

    describe('binary path resolution', () => {
      it('should use resources path when app is packaged', async () => {
        // First reset the module cache
        vi.resetModules();

        const originalResourcesPath = process.resourcesPath;
        setupMocks({
          platform: 'linux',
          arch: 'x64',
          isPackaged: true,
          resourcesPath: '/packaged/resources',
        });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toBe(path.resolve('/packaged/resources/ollama-v0.11.4'));

        // Restore original value
        Object.defineProperty(process, 'resourcesPath', {
          value: originalResourcesPath,
          configurable: true,
        });
      });

      it('should use app path when app is not packaged', async () => {
        // First reset the module cache
        vi.resetModules();

        // Mock process.cwd() since that's what getBinariesDirectory uses when app is undefined or not packaged
        const originalCwd = process.cwd;
        process.cwd = vi.fn(() => '/dev/app/path');

        setupMocks({
          platform: 'darwin',
          arch: 'arm64',
          isPackaged: false,
          appPath: '/dev/app/path',
        });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toBe(path.resolve('/dev/app/path/resources/bin/mac/arm64/ollama-v0.11.4'));

        // Restore original cwd
        process.cwd = originalCwd;
      });

      it('should add .exe extension on Windows', async () => {
        setupMocks({ platform: 'win32', arch: 'x64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toMatch(/ollama-v0\.11\.4\.exe$/);
      });

      it('should not add .exe extension on non-Windows platforms', async () => {
        const nonWindowsPlatforms = ['linux', 'darwin'];

        for (const platform of nonWindowsPlatforms) {
          vi.resetModules();
          setupMocks({ platform, arch: 'x64' });

          const { getBinaryExecPath } = await import('./');
          const binaryPath = getBinaryExecPath('ollama-v0.11.4');
          expect(binaryPath).not.toMatch(/\.exe$/);
        }
      });
    });

    describe('error handling', () => {
      it('should throw error when binary does not exist', async () => {
        setupMocks({ platform: 'linux', arch: 'x64', fileExists: false });

        const { getBinaryExecPath } = await import('./');
        expect(() => getBinaryExecPath('ollama-v0.11.4')).toThrow(/Binary ollama-v0\.11\.4 not found at/);
      });

      it('should include full path in error message', async () => {
        // First reset the module cache
        vi.resetModules();

        // Mock process.cwd() since that's what getBinariesDirectory uses when app is undefined or not packaged
        const originalCwd = process.cwd;
        process.cwd = vi.fn(() => '/test/app');

        setupMocks({
          platform: 'darwin',
          arch: 'arm64',
          fileExists: false,
          appPath: '/test/app',
        });

        const { getBinaryExecPath } = await import('./');
        expect(() => getBinaryExecPath('ollama-v0.11.4')).toThrow(
          'Binary ollama-v0.11.4 not found at /test/app/resources/bin/mac/arm64/ollama-v0.11.4'
        );

        // Restore original cwd
        process.cwd = originalCwd;
      });
    });

    describe('integration scenarios', () => {
      it('should handle multiple calls with same binary', async () => {
        setupMocks({ platform: 'linux', arch: 'x64' });

        const { getBinaryExecPath } = await import('./');
        const path1 = getBinaryExecPath('ollama-v0.11.4');
        const path2 = getBinaryExecPath('ollama-v0.11.4');

        expect(path1).toBe(path2);
        expect(fs.existsSync).toHaveBeenCalledTimes(2);
      });

      it('should return absolute paths', async () => {
        setupMocks({ platform: 'linux', arch: 'x64' });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(path.isAbsolute(binaryPath)).toBe(true);
      });

      it('should handle paths with spaces', async () => {
        // First reset the module cache
        vi.resetModules();

        // Mock process.cwd() since that's what getBinariesDirectory uses when app is undefined or not packaged
        const originalCwd = process.cwd;
        process.cwd = vi.fn(() => '/path with spaces/app');

        setupMocks({
          platform: 'darwin',
          arch: 'arm64',
          appPath: '/path with spaces/app',
        });

        const { getBinaryExecPath } = await import('./');
        const binaryPath = getBinaryExecPath('ollama-v0.11.4');
        expect(binaryPath).toBe(path.resolve('/path with spaces/app/resources/bin/mac/arm64/ollama-v0.11.4'));

        // Restore original cwd
        process.cwd = originalCwd;
      });
    });
  });
});
