import { Agent, fetch } from 'undici';
import { z } from 'zod';

import { imageInspectLibpod } from '@backend/clients/libpod/gen';
import config from '@backend/config';
import log from '@backend/utils/logger';

const PodmanImageStatusSummarySchema = z.object({
  /**
   * pullPercentage is a number between 0 and 100 that represents the percentage of the base image pull that has been completed.
   */
  pullPercentage: z.number().min(0).max(100),
  /**
   * pullMessage is a string that gives a human-readable description of the current state of the base image pull.
   */
  pullMessage: z.string().nullable(),
  /**
   * pullError is a string that gives a human-readable description of the error that occurred during the base image pull (if one has)
   */
  pullError: z.string().nullable(),
});

type PodmanImageStatusSummary = z.infer<typeof PodmanImageStatusSummarySchema>;

export default class PodmanImage {
  private BASE_IMAGE_NAME = config.sandbox.baseDockerImage;

  private pullPercentage = 0;
  private pullMessage: string | null = null;
  private pullError: string | null = null;

  // Checks if the base image already exists locally
  async checkBaseImageExists(): Promise<boolean> {
    try {
      const response = await imageInspectLibpod({
        path: {
          name: this.BASE_IMAGE_NAME,
        },
      });

      if (response.error) {
        return false;
      }

      return !!response.data;
    } catch {
      return false;
    }
  }

  // Ensures the base image is available locally, pulling it only if necessary.
  async ensureBaseImageAvailable(machineSocketPath: string) {
    this.pullPercentage = 0;
    this.pullMessage = `Checking if base image ${this.BASE_IMAGE_NAME} exists locally...`;
    this.pullError = null;

    try {
      const imageExists = await this.checkBaseImageExists();

      if (imageExists) {
        this.pullPercentage = 100;
        this.pullMessage = `Base image ${this.BASE_IMAGE_NAME} already exists locally`;
        return;
      }

      await this.pullBaseImage(machineSocketPath);
    } catch (error) {
      log.error(`Error ensuring base image availability:`, error);
      this.pullPercentage = 0;
      this.pullMessage = null;
      this.pullError =
        error instanceof Error
          ? error.message
          : `Unknown error ensuring base image ${this.BASE_IMAGE_NAME} availability`;
      throw error;
    }
  }

  /**
   * Pulls the base image using Podman's image pull API.
   *
   * https://docs.podman.io/en/v5.5.2/_static/api.html#tag/images/operation/ImagePullLibpod
   *
   * Note: We're using undici's fetch directly instead of the generated `imagePullLibpod` client
   * because the generated client doesn't properly handle streaming responses. The Podman API
   * returns newline-delimited JSON during the pull process, but the generated client returns
   * immediately without processing the stream, resulting in undefined data. By using fetch
   * directly, we can properly read and parse the streaming response to track pull progress.
   */
  async pullBaseImage(machineSocketPath: string) {
    // Reset state at the beginning
    this.pullPercentage = 0;
    this.pullMessage = `Preparing to pull image ${this.BASE_IMAGE_NAME}`;
    this.pullError = null;

    try {
      // Update state before making the API call
      this.pullPercentage = 5;
      this.pullMessage = `Initiating pull for ${this.BASE_IMAGE_NAME}`;

      // Construct the URL for the image pull endpoint
      const url = `http://localhost/v5.0.0/libpod/images/pull?reference=${encodeURIComponent(this.BASE_IMAGE_NAME)}`;

      log.info(`Pulling image ${this.BASE_IMAGE_NAME} from ${machineSocketPath}...`);

      // Make the request using undici fetch with unix socket
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        dispatcher: new Agent({
          connect: {
            socketPath: machineSocketPath,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to pull image: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Process the streaming response
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body available');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let blobCount = 0;
      let totalBlobs = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          // Decode the chunk and add to buffer
          buffer += decoder.decode(value, { stream: true });

          // Process complete lines (newline-delimited JSON)
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const jsonData = JSON.parse(line);

                // Update progress based on stream message
                if (jsonData.stream) {
                  const streamMessage = jsonData.stream.trim();
                  log.debug(`Pull stream: ${streamMessage}`);
                  this.pullMessage = streamMessage;

                  // Track progress based on different stages
                  if (streamMessage.includes('Resolved')) {
                    this.pullPercentage = 10;
                  } else if (streamMessage.includes('Trying to pull')) {
                    this.pullPercentage = 15;
                  } else if (streamMessage.includes('Getting image source signatures')) {
                    this.pullPercentage = 20;
                  } else if (streamMessage.includes('Copying blob')) {
                    // Count blobs to estimate progress
                    blobCount++;
                    // Estimate 7 blobs total (common for container images)
                    totalBlobs = Math.max(totalBlobs, 7);
                    // Blobs take up 20-80% of the progress
                    this.pullPercentage = 20 + Math.min((blobCount / totalBlobs) * 60, 60);
                  } else if (streamMessage.includes('Copying config')) {
                    this.pullPercentage = 85;
                  } else if (streamMessage.includes('Writing manifest')) {
                    this.pullPercentage = 95;
                  }
                }

                // Check for error
                if (jsonData.error) {
                  throw new Error(jsonData.error);
                }

                // Check for completion (images array present)
                if (jsonData.images && jsonData.images.length > 0) {
                  this.pullPercentage = 100;
                  this.pullMessage = `Successfully pulled ${this.BASE_IMAGE_NAME}`;
                  log.info(`Image ${this.BASE_IMAGE_NAME} pulled successfully: ${jsonData.id}`);
                }
              } catch (parseError) {
                log.warn(`Failed to parse JSON line during pull: ${line}`, parseError);
              }
            }
          }
        }

        // Process any remaining data in buffer
        if (buffer.trim()) {
          try {
            const jsonData = JSON.parse(buffer);
            if (jsonData.error) {
              throw new Error(jsonData.error);
            }
            if (jsonData.images && jsonData.images.length > 0) {
              this.pullPercentage = 100;
              this.pullMessage = `Successfully pulled ${this.BASE_IMAGE_NAME}`;
            }
          } catch (parseError) {
            log.warn(`Failed to parse final JSON buffer: ${buffer}`, parseError);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Ensure we reached 100% if no error occurred
      if (this.pullError === null && this.pullPercentage < 100) {
        this.pullPercentage = 100;
        this.pullMessage = `Successfully pulled ${this.BASE_IMAGE_NAME}`;
      }

      log.info(`Base image ${this.BASE_IMAGE_NAME} pull completed`);
      return;
    } catch (error) {
      log.error(`Error pulling image ${this.BASE_IMAGE_NAME}`, error);

      // Update state on error
      this.pullPercentage = 0;
      this.pullMessage = null;
      this.pullError = error instanceof Error ? error.message : `Unknown error pulling image ${this.BASE_IMAGE_NAME}`;

      throw error;
    }
  }

  get statusSummary(): PodmanImageStatusSummary {
    return {
      pullPercentage: this.pullPercentage,
      pullMessage: this.pullMessage,
      pullError: this.pullError,
    };
  }
}
