import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import PodmanImage from '@backend/sandbox/podman/image';
import { getBinariesDirectory, getBinaryExecPath } from '@backend/utils/binaries';
import log from '@backend/utils/logger';
import { PODMAN_REGISTRY_AUTH_FILE_PATH } from '@backend/utils/paths';

import { parsePodmanMachineInstallationProgress } from './utils';

export const PodmanRuntimeStatusSummarySchema = z.object({
  /**
   * startupPercentage is a number between 0 and 100 that represents the percentage of the startup process that has been completed.
   */
  startupPercentage: z.number().min(0).max(100),
  /**
   * startupMessage is a string that gives a human-readable description of the current state of the startup process.
   */
  startupMessage: z.string().nullable(),
  /**
   * startupError is a string that gives a human-readable description of the error that occurred during the startup process (if one has)
   */
  startupError: z.string().nullable(),
  /**
   * Machine-specific fields for detailed tracking
   */
  machineStartupPercentage: z.number().min(0).max(100).optional(),
  machineStartupMessage: z.string().nullable().optional(),
  machineStartupError: z.string().nullable().optional(),
  /**
   * Image pull-specific fields for detailed tracking
   */
  pullPercentage: z.number().min(0).max(100).optional(),
  pullMessage: z.string().nullable().optional(),
  pullError: z.string().nullable().optional(),
});

type PodmanRuntimeStatusSummary = z.infer<typeof PodmanRuntimeStatusSummarySchema>;

type RunCommandPipes<T extends object | object[]> = {
  onStdout?: {
    callback: (data: T | string) => void;
    attemptToParseOutputAsJson?: boolean;
  };
  onStderr?: (data: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onError?: (error: Error) => void;
};

type RunCommandOptions<T extends object | object[]> = {
  command: string[];
  pipes: RunCommandPipes<T>;
};

export type PodmanMachineListOutput = {
  Name: string;
  Default: boolean;
  Created: string;
  Running: boolean;
  Starting: boolean;
  LastUp: string;
  Stream: string;
  VMType: string;
  CPUs: number;
  Memory: string;
  DiskSize: string;
  Port: number;
  RemoteUsername: string;
  IdentityPath: string;
  UserModeNetworking: boolean;
}[];

export type PodmanMachineInspectOutput = {
  ConfigDir: {
    Path: string;
  };
  ConnectionInfo: {
    PodmanSocket: {
      Path: string;
    };
    PodmanPipe: null;
  };
  Resources: {
    CPUs: number;
    DiskSize: number;
    Memory: number;
    USBs: string[];
  };
  SSHConfig: {
    IdentityPath: string;
    Port: number;
    RemoteUsername: string;
  };
  UserModeNetworking: boolean;
  Rootful: boolean;
  Rosetta: boolean;
}[];

/**
 * https://docs.podman.io/en/latest/markdown/podman-machine.1.html
 */
export default class PodmanRuntime {
  private ARCHESTRA_MACHINE_NAME = 'archestra-ai-machine';

  private machineStartupPercentage = 0;
  private machineStartupMessage: string | null = null;
  private machineStartupError: string | null = null;

  private onMachineInstallationSuccess: () => void = () => {};
  private onMachineInstallationError: (error: Error) => void = () => {};

  private registryAuthFilePath: string;
  private binaryPath = getBinaryExecPath('podman-remote-static-v5.5.2');

  private baseImage: PodmanImage;
  private initRetryCount = 0;
  private readonly MAX_INIT_RETRIES = 2;

  /**
   * NOTE: see here as to why we need to bundle, and configure, `gvproxy` + `vfkit`, alongside `podman`:
   * https://podman-desktop.io/docs/troubleshooting/troubleshooting-podman-on-macos#unable-to-set-custom-binary-path-for-podman-on-macos
   * https://github.com/containers/podman/issues/11960#issuecomment-953672023
   *
   * Basically, when you install podman via the "pkginstaller" (https://github.com/containers/podman/blob/v5.5.2/contrib/pkginstaller/README.md?plain=1#L14)
   * it comes with `gvproxy` and `vfkit` binaries "baked in". We need to do a bit more configuration here to
   * tell the podman binary where to find these "helper" binaries.
   *
   * NOTE: `gvproxy` and `vfkit` MUST be named explicitly `gvproxy` and `vfkit` respectively.
   *
   * It cannot have the version appended to it, this is because `podman` internally is looking specifically for that
   * binary naming convention. As of this writing, the versions we are using are:
   * - `gvproxy` is [`v0.8.6`](https://github.com/containers/gvisor-tap-vsock/releases/tag/v0.8.6) -- podman v5.5.2 comes with this version (see https://github.com/containers/podman/blob/v5.5.2/go.mod#L18)
   * - `vfkit` is [`v0.6.0`](https://github.com/crc-org/vfkit/releases/tag/v0.6.0) -- podman v5.5.2 comes with this version (see https://github.com/containers/podman/blob/v5.5.2/go.mod#L26)
   *   - NOTE: in the releases of `vfkit` they have `vfkit` + `vfkit-unsigned` (we are using `vfkit`.. honestly not sure of the difference?)
   *
   * See also `CONTAINERS_HELPER_BINARY_DIR` env var which is being passed into our podman commands below.
   */
  private helperBinariesDirectory = getBinariesDirectory();

  constructor(onMachineInstallationSuccess: () => void, onMachineInstallationError: (error: Error) => void) {
    this.baseImage = new PodmanImage();

    this.onMachineInstallationSuccess = onMachineInstallationSuccess;
    this.onMachineInstallationError = onMachineInstallationError;

    this.registryAuthFilePath = PODMAN_REGISTRY_AUTH_FILE_PATH;

    // https://docs.podman.io/en/v5.2.2/markdown/podman-create.1.html#authfile-path
    if (!fs.existsSync(this.registryAuthFilePath)) {
      fs.mkdirSync(path.dirname(this.registryAuthFilePath), { recursive: true });
      fs.writeFileSync(this.registryAuthFilePath, '{}');
    }
  }

  async pullBaseImageOnMachineInstallationSuccess(machineSocketPath: string) {
    try {
      await this.baseImage.ensureBaseImageAvailable(machineSocketPath);
    } catch (error) {
      throw error;
    }
  }

  private runCommand<T extends object | object[]>({
    command,
    pipes: { onStdout, onStderr, onExit, onError },
  }: RunCommandOptions<T>): void {
    const commandForLogs = `${this.binaryPath} ${command.join(' ')}`;

    log.info(`[Podman command]: running ${commandForLogs}`);

    const commandProcess = spawn(this.binaryPath, command, {
      env: {
        ...process.env,
        /**
         * See here, `CONTAINERS_HELPER_BINARY_DIR` isn't well documented, but here is what I've found:
         * https://github.com/containers/podman/blob/0c4c9e4fbc0cf9cdcdcb5ea1683a2ffeddb03e77/hack/bats#L131
         * https://docs.podman.io/en/stable/markdown/podman.1.html#environment-variables
         */
        CONTAINERS_HELPER_BINARY_DIR: this.helperBinariesDirectory,

        /**
         * Add our helper binaries directory to PATH so virtiofsd can be found.
         * This is needed for Podman machine to work properly on Linux.
         */
        PATH: `${this.helperBinariesDirectory}:${process.env.PATH}`,

        /**
         * Basically we don't want the podman machine to use the user's docker config (if one exists)
         *
         * From the podman docs (https://docs.podman.io/en/v5.2.2/markdown/podman-create.1.html#authfile-path):
         *
         * Path of the authentication file. Default is ${XDG_RUNTIME_DIR}/containers/auth.json on Linux, and $HOME/.
         * config/containers/auth.json on Windows/macOS. The file is created by podman login. If the authorization
         * state is not found there, $HOME/.docker/config.json is checked, which is set using docker login.
         *
         * Note: There is also the option to override the default path of the authentication file by setting the
         * REGISTRY_AUTH_FILE environment variable. This can be done with export REGISTRY_AUTH_FILE=path.
         */
        REGISTRY_AUTH_FILE: this.registryAuthFilePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (onStdout) {
      commandProcess.stdout?.on('data', (data) => {
        log.info(`[Podman stdout]: ${commandForLogs} ${data}`);

        let parsedData: T | string;
        if (onStdout.attemptToParseOutputAsJson) {
          try {
            parsedData = JSON.parse(data.toString()) as T;
          } catch (e) {
            log.error(
              `[Podman stdout]: ${commandForLogs} error parsing JSON: ${data}. Falling back to string parsing.`,
              e
            );
            parsedData = data.toString();
          }
        } else {
          parsedData = data.toString();
        }

        onStdout.callback(parsedData);
      });
    }

    if (onStderr) {
      commandProcess.stderr?.on('data', (data) => {
        log.info(`[Podman stderr]: ${commandForLogs} ${data}`);
        onStderr(data.toString());
      });
    }

    if (onExit) {
      commandProcess.on('exit', (code, signal) => {
        log.info(`[Podman exit]: ${commandForLogs} code=${code} signal=${signal}`);
        onExit(code, signal);
      });
    }

    if (onError) {
      commandProcess.on('error', (error) => {
        log.info(`[Podman error]: ${commandForLogs} ${error}`);
        onError(error);
      });
    }
  }

  /**
   * Helper method to handle errors consistently by setting the error state
   * and then calling the error callback
   */
  private handleMachineError(error: Error) {
    this.machineStartupError = error.message;
    this.machineStartupPercentage = 0;
    this.machineStartupMessage = error.message;
    this.onMachineInstallationError(error);
  }

  /**
   * Output looks like this:
   * ❯ ./podman-remote-static-v5.5.2 machine start archestra-ai-machine
   * Starting machine "archestra-ai-machine"
   *
   * This machine is currently configured in rootless mode. If your containers
   * require root permissions (e.g. ports < 1024), or if you run into compatibility
   * issues with non-podman clients, you can switch using the following command:
   *
   *   podman machine set --rootful archestra-ai-machine
   *
   * API forwarding listening on: /var/run/docker.sock
   * Docker API clients default to this address. You do not need to set DOCKER_HOST.
   *
   * Machine "archestra-ai-machine" started successfully
   */
  private async startArchestraMachine() {
    let stderrOutput = '';

    this.runCommand({
      command: ['machine', 'start', this.ARCHESTRA_MACHINE_NAME],
      pipes: {
        onStdout: {
          callback: (data) => {
            const output = typeof data === 'string' ? data : JSON.stringify(data);
            // Look for "Starting machine" to indicate progress
            if (output.includes('Starting machine')) {
              this.machineStartupPercentage = 50;
              this.machineStartupMessage = 'Starting podman machine...';
            } else if (output.includes('started successfully')) {
              this.machineStartupPercentage = 100;
              this.machineStartupMessage = 'Podman machine started successfully';
            }
          },
        },
        onStderr: (data) => {
          stderrOutput += data;
        },
        onExit: (code, signal) => {
          if (code === 0) {
            this.machineStartupPercentage = 100;
            this.machineStartupMessage = 'Podman machine started successfully';

            // Call the success callback - socket setup will happen there first
            this.onMachineInstallationSuccess();
          } else {
            this.handleMachineError(
              new Error(`Podman machine start failed with code ${code} and signal ${signal}. Error: ${stderrOutput}`)
            );
          }
        },
        onError: this.handleMachineError.bind(this),
      },
    });
  }

  /**
   * Output looks like this (while installing):
   * ❯ ./podman-remote-static-v5.5.2 machine init archestra-ai-machine --now
   * Looking up Podman Machine image at quay.io/podman/machine-os:5.5 to create VM
   * Extracting compressed file: podman-machine-default-arm64.raw [=============================================================================>] 885.6MiB / 885.7MiB
   *
   *
   * Once installation is complete, and the machine is started, output looks like this:
   *
   * ❯ ./podman-remote-static-v5.5.2 machine init archestra-ai-machine --now
   * Looking up Podman Machine image at quay.io/podman/machine-os:5.5 to create VM
   * Extracting compressed file: archestra-ai-machine-arm64.raw: done
   * Machine init complete
   * Starting machine "archestra-ai-machine"
   *
   * This machine is currently configured in rootless mode. If your containers
   * require root permissions (e.g. ports < 1024), or if you run into compatibility
   * issues with non-podman clients, you can switch using the following command:
   *
   *   podman machine set --rootful archestra-ai-machine
   *
   * API forwarding listening on: /var/run/docker.sock
   * Docker API clients default to this address. You do not need to set DOCKER_HOST.
   *
   *   Machine "archestra-ai-machine" started successfully
   *
   * ==============================
   * --now = Start machine now
   *
   */
  private initArchestraMachine() {
    this.machineStartupPercentage = 0;
    this.machineStartupMessage = 'Initializing podman machine...';
    this.machineStartupError = null;

    let stderrOutput = '';

    this.runCommand({
      command: ['machine', 'init', '--now', this.ARCHESTRA_MACHINE_NAME],
      pipes: {
        onStdout: {
          callback: (data) => {
            const output = typeof data === 'string' ? data : JSON.stringify(data);
            const { percentage, message } = parsePodmanMachineInstallationProgress(output);

            this.machineStartupPercentage = percentage;
            this.machineStartupMessage = message;
          },
        },
        onStderr: (data) => {
          stderrOutput += data;
          log.error(`[Podman machine init stderr]: ${data}`);
        },
        onExit: (code, signal) => {
          if (code === 0) {
            // Call the success callback - socket setup will happen there first
            this.onMachineInstallationSuccess();
          } else {
            // Check if this is a connection conflict error that we can auto-resolve
            if (stderrOutput.includes('system connection') && stderrOutput.includes('already exists') && this.initRetryCount < this.MAX_INIT_RETRIES) {
              log.info(`Detected system connection conflict. Attempting automatic cleanup and retry... (attempt ${this.initRetryCount + 1}/${this.MAX_INIT_RETRIES})`);
              this.initRetryCount++;
              this.cleanupConflictingConnectionsAndRetry();
            } else {
              const errorMessage = `Podman machine init failed with code ${code} and signal ${signal}`;
              const fullError = stderrOutput ? `${errorMessage}. Error: ${stderrOutput}` : errorMessage;

              if (this.initRetryCount >= this.MAX_INIT_RETRIES) {
                log.error(`Max retry attempts (${this.MAX_INIT_RETRIES}) reached for machine initialization`);
              }

              this.handleMachineError(new Error(fullError));
            }
          }
        },
        onError: this.handleMachineError.bind(this),
      },
    });
  }

  /**
   * Clean up conflicting system connections and retry machine initialization.
   * This handles the case where stale connections prevent machine creation.
   */
  private cleanupConflictingConnectionsAndRetry() {
    this.machineStartupMessage = 'Cleaning up conflicting connections...';

    // First, try to remove any existing connections for our machine
    this.runCommand({
      command: ['system', 'connection', 'rm', this.ARCHESTRA_MACHINE_NAME],
      pipes: {
        onStderr: (data) => {
          // It's OK if this fails - the connection might not exist
          log.info(`[Podman connection cleanup stderr]: ${data}`);
        },
        onExit: (code) => {
          // Try to remove the root connection as well
          this.runCommand({
            command: ['system', 'connection', 'rm', `${this.ARCHESTRA_MACHINE_NAME}-root`],
            pipes: {
              onStderr: (data) => {
                // It's OK if this fails - the connection might not exist
                log.info(`[Podman root connection cleanup stderr]: ${data}`);
              },
              onExit: () => {
                // Try to remove any existing machine with the same name
                this.runCommand({
                  command: ['machine', 'rm', '--force', this.ARCHESTRA_MACHINE_NAME],
                  pipes: {
                    onStderr: (data) => {
                      // It's OK if this fails - the machine might not exist
                      log.info(`[Podman machine cleanup stderr]: ${data}`);
                    },
                    onExit: () => {
                      // Now retry the initialization
                      log.info('Cleanup complete. Retrying machine initialization...');
                      this.machineStartupMessage = 'Retrying machine initialization...';
                      this.initArchestraMachine();
                    },
                    onError: (error) => {
                      log.error('Error during machine cleanup:', error);
                      // Still try to proceed with initialization
                      this.initArchestraMachine();
                    },
                  },
                });
              },
              onError: (error) => {
                log.error('Error during root connection cleanup:', error);
                // Still proceed with machine cleanup
                this.runCommand({
                  command: ['machine', 'rm', '--force', this.ARCHESTRA_MACHINE_NAME],
                  pipes: {
                    onExit: () => this.initArchestraMachine(),
                    onError: () => this.initArchestraMachine(),
                  },
                });
              },
            },
          });
        },
        onError: (error) => {
          log.error('Error during connection cleanup:', error);
          // Still proceed with other cleanup steps
          this.runCommand({
            command: ['system', 'connection', 'rm', `${this.ARCHESTRA_MACHINE_NAME}-root`],
            pipes: {
              onExit: () => this.initArchestraMachine(),
              onError: () => this.initArchestraMachine(),
            },
          });
        },
      },
    });
  }

  /**
   * Clean up all Archestra-related Podman data for testing purposes.
   * This removes machines, connections, and any related files.
   */
  cleanupAllArchestraData(): Promise<void> {
    return new Promise((resolve) => {
      log.info('Starting comprehensive cleanup of all Archestra Podman data...');

      // Step 1: Stop machine if running
      this.runCommand({
        command: ['machine', 'stop', this.ARCHESTRA_MACHINE_NAME],
        pipes: {
          onExit: () => {
            // Step 2: Remove machine
            this.runCommand({
              command: ['machine', 'rm', '--force', this.ARCHESTRA_MACHINE_NAME],
              pipes: {
                onExit: () => {
                  // Step 3: Remove connections
                  this.runCommand({
                    command: ['system', 'connection', 'rm', this.ARCHESTRA_MACHINE_NAME],
                    pipes: {
                      onExit: () => {
                        // Step 4: Remove root connection
                        this.runCommand({
                          command: ['system', 'connection', 'rm', `${this.ARCHESTRA_MACHINE_NAME}-root`],
                          pipes: {
                            onExit: () => {
                              log.info('Comprehensive cleanup completed successfully');
                              resolve();
                            },
                            onError: () => {
                              log.info('Cleanup completed (some steps may have failed, but that\'s expected)');
                              resolve();
                            },
                          },
                        });
                      },
                      onError: () => {
                        log.info('Cleanup completed (some steps may have failed, but that\'s expected)');
                        resolve();
                      },
                    },
                  });
                },
                onError: () => {
                  log.info('Cleanup completed (some steps may have failed, but that\'s expected)');
                  resolve();
                },
              },
            });
          },
          onError: () => {
            // Machine might not be running, continue with removal
            this.runCommand({
              command: ['machine', 'rm', '--force', this.ARCHESTRA_MACHINE_NAME],
              pipes: {
                onExit: () => resolve(),
                onError: () => resolve(),
              },
            });
          },
        },
      });
    });
  }

  /**
   * Reset the initialization retry count. Called when starting a fresh initialization attempt.
   */
  private resetRetryCount() {
    this.initRetryCount = 0;
  }

  /**
   * This method will check if the archesta podman machine is installed and running.
   * - If it's not installed, it will install it and start it.
   * - If it's installed but not running, it will start it.
   * - If it's installed and running, it will do nothing.
   *
   * ==============================
   *
   * NOTE: not sure under which circumstances podman machine ls will exit with a non-zero code,
   * or output to stderr, so we're not going to do anything with it for now
   */
  ensureArchestraMachineIsRunning() {
    // Reset retry count for fresh initialization attempt
    this.resetRetryCount();
    let stderrOutput = '';

    this.runCommand<PodmanMachineListOutput>({
      command: ['machine', 'ls', '--format', 'json'],
      pipes: {
        onStdout: {
          attemptToParseOutputAsJson: true,
          callback: (installedPodmanMachines) => {
            if (!Array.isArray(installedPodmanMachines)) {
              this.handleMachineError(
                new Error(`Podman machine ls returned non-array data: ${installedPodmanMachines}`)
              );
              return;
            }

            const archestraMachine = installedPodmanMachines.find(
              (machine) => machine.Name === this.ARCHESTRA_MACHINE_NAME
            );

            if (!archestraMachine) {
              // archestra podman machine is not installed, install (and start it)
              this.initArchestraMachine();
            } else if (archestraMachine.Running) {
              // We're all good to go. The archesta podman machine is installed and running.
              this.machineStartupPercentage = 100;
              this.machineStartupMessage = 'Podman machine is running';

              // Call the success callback - socket setup will happen there first
              this.onMachineInstallationSuccess();
            } else {
              // The archesta podman machine is installed, but not running. Let's start it.
              this.machineStartupPercentage = 25;
              this.machineStartupMessage = 'Podman machine is installed! Starting it...';

              this.startArchestraMachine();
            }
          },
        },
        onStderr: (data) => {
          stderrOutput += data;
          log.error(`[Podman machine ls stderr]: ${data}`);
        },
        onExit: (code, signal) => {
          if (code !== 0) {
            const errorMessage = `Podman machine ls failed with code ${code} and signal ${signal}`;
            const fullError = stderrOutput ? `${errorMessage}. Error: ${stderrOutput}` : errorMessage;
            this.handleMachineError(new Error(fullError));
          }
        },
        onError: this.handleMachineError.bind(this),
      },
    });
  }

  /**
   * This method will stop the archesta podman machine.
   *
   * NOTE: for now we can just ignore stdio, stderr, and onExit callbacks..
   */
  stopArchestraMachine() {
    this.runCommand({
      command: ['machine', 'stop', this.ARCHESTRA_MACHINE_NAME],
      pipes: {
        onExit: (code) => {
          if (code === 0) {
            this.machineStartupPercentage = 0;
            this.machineStartupMessage = 'Podman machine stopped successfully';
            this.machineStartupError = null;
          }
        },
        onError: this.handleMachineError.bind(this),
      },
    });
  }

  /**
   * This method will remove the archesta podman machine.
   * https://docs.podman.io/en/v5.2.2/markdown/podman-machine-rm.1.html
   *
   * @param force - Force removal of the machine, even if it is running
   */
  async removeArchestraMachine(force: boolean = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = ['machine', 'rm'];

      if (force) {
        command.push('--force');
      }

      command.push(this.ARCHESTRA_MACHINE_NAME);

      let stderrOutput = '';

      this.runCommand({
        command,
        pipes: {
          onStderr: (data) => {
            stderrOutput += data;
          },
          onExit: (code) => {
            if (code === 0) {
              this.machineStartupPercentage = 0;
              this.machineStartupMessage = 'Podman machine removed successfully';
              this.machineStartupError = null;
              log.info(`Podman machine ${this.ARCHESTRA_MACHINE_NAME} removed successfully`);
              resolve();
            } else {
              const errorMessage = `Failed to remove podman machine: ${stderrOutput}`;
              log.error(errorMessage);
              reject(new Error(errorMessage));
            }
          },
          onError: (error) => {
            log.error('Error removing podman machine:', error);
            reject(error);
          },
        },
      });
    });
  }

  /**
   * Get the socket address from the running podman machine.
   * This is needed to avoid conflicts with Docker/Orbstack.
   *
   * https://github.com/containers/podman/issues/16725#issuecomment-1338382533
   *
   * Output of this command looks like:
   *
   * $ podman machine inspect archestra-ai-machine --format '{{ .ConnectionInfo.PodmanSocket.Path }}'
   * /Users/myuser/.local/share/containers/podman/machine/archestra-ai-machine/podman.sock
   */
  async getSocketAddress(): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      this.runCommand({
        command: [
          'machine',
          'inspect',
          this.ARCHESTRA_MACHINE_NAME,
          '--format',
          '{{ .ConnectionInfo.PodmanSocket.Path }}',
        ],
        pipes: {
          onStdout: {
            callback: (data) => {
              output += data.toString();
            },
          },
          onExit: (code) => {
            if (code === 0) {
              const socketPath = output.trim();
              if (socketPath) {
                log.info(`Found podman socket path: ${socketPath}`);
                resolve(socketPath);
              } else {
                reject(new Error('Could not find socket path in podman machine inspect output'));
              }
            } else {
              reject(new Error(`Failed to inspect podman machine. Exit code: ${code}`));
            }
          },
          onError: (error) => {
            reject(error);
          },
        },
      });
    });
  }

  /**
   * the startup progress is a function of the startup progress of the podman machine and the base image pull
   *
   * If the podman machine is still starting up then we show messages/errors related to that process, otherwise
   * if the machine is done starting up, we show messages/errors related to the base image pull
   */
  get statusSummary(): PodmanRuntimeStatusSummary {
    let startupMessage: string | null;
    let startupError: string | null;

    if (this.machineStartupPercentage < 100) {
      startupMessage = this.machineStartupMessage;
      startupError = this.machineStartupError;
    } else {
      startupMessage = this.baseImage.statusSummary.pullMessage;
      startupError = this.baseImage.statusSummary.pullError;
    }

    return {
      startupPercentage: (this.machineStartupPercentage + this.baseImage.statusSummary.pullPercentage) / 2,
      startupMessage,
      startupError,
      // Include detailed machine and pull fields
      machineStartupPercentage: this.machineStartupPercentage,
      machineStartupMessage: this.machineStartupMessage,
      machineStartupError: this.machineStartupError,
      pullPercentage: this.baseImage.statusSummary.pullPercentage,
      pullMessage: this.baseImage.statusSummary.pullMessage,
      pullError: this.baseImage.statusSummary.pullError,
    };
  }
}
