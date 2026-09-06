import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { GoogleAuth } from "google-auth-library";
import config from "@/config";
import {
  buildAnthropicVertexRequest,
  getAnthropicVertexApiRoot,
} from "./anthropic-vertex-request";

class AnthropicVertexClient {
  private googleAuth: GoogleAuth | null = null;
  private googleAuthConfigKey = "";

  isEnabled(): boolean {
    return config.llm.anthropic.vertexAi.enabled;
  }

  createModel(params: { modelId: string; fetch?: typeof globalThis.fetch }) {
    const { project, location, credentialsFile } = this.getConfig();
    const provider = createVertexAnthropic({
      project,
      location,
      fetch: params.fetch,
      googleAuthOptions: {
        projectId: project,
        ...(credentialsFile && { keyFilename: credentialsFile }),
      },
    });
    return provider(params.modelId);
  }

  createFetch(
    delegateFetch: typeof globalThis.fetch = globalThis.fetch,
  ): typeof globalThis.fetch {
    return async (input, init) => {
      const { project, location } = this.getConfig();
      const request = await buildAnthropicVertexRequest({
        input,
        init,
        project,
        location,
        authHeaders: await this.getRequestHeaders(),
      });
      return delegateFetch(request);
    };
  }

  getApiRoot(): string {
    return getAnthropicVertexApiRoot(this.getConfig().location);
  }

  async getRequestHeaders(): Promise<Headers> {
    const { project } = this.getConfig();
    const authClient = await this.getGoogleAuth().getClient();
    const googleHeaders = await authClient.getRequestHeaders();
    const headers = new Headers();
    googleHeaders.forEach((value, name) => {
      headers.set(name, value);
    });
    // Local user ADC needs an explicit quota project. Service-account and
    // workload-identity credentials also accept this header.
    headers.set("x-goog-user-project", project);
    return headers;
  }

  getProject(): string {
    return this.getConfig().project;
  }

  private getGoogleAuth(): GoogleAuth {
    const { project, credentialsFile } = this.getConfig();
    const configKey = `${project}\u0000${credentialsFile}`;
    if (this.googleAuth && this.googleAuthConfigKey === configKey) {
      return this.googleAuth;
    }

    this.googleAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      projectId: project,
      ...(credentialsFile && { keyFilename: credentialsFile }),
    });
    this.googleAuthConfigKey = configKey;
    return this.googleAuth;
  }

  private getConfig(): {
    project: string;
    location: string;
    credentialsFile: string;
  } {
    const { project, location, credentialsFile } =
      config.llm.anthropic.vertexAi;
    if (!project) {
      throw new Error(
        "Anthropic Vertex AI is enabled but ARCHESTRA_ANTHROPIC_VERTEX_AI_PROJECT is not set",
      );
    }
    return { project, location, credentialsFile };
  }
}

export const anthropicVertexClient = new AnthropicVertexClient();
