import config from "@/config";
import { afterEach, describe, expect, test } from "@/test";
import type { AgentBackgroundExecution } from "@/types";
import { resolveAgentDeployment } from "./pod-execution";

const originalEnabled = config.agentBackgroundExecution.enabled;

afterEach(() => {
  config.agentBackgroundExecution.enabled = originalEnabled;
});

describe("resolveAgentDeployment", () => {
  test("does not change foreground delegation while Background execution is disabled", () => {
    config.agentBackgroundExecution.enabled = false;

    expect(resolveAgentDeployment(agentWithDeployment)).toBeNull();
  });

  test("resolves the Agent deployment after the independent feature is enabled", () => {
    config.agentBackgroundExecution.enabled = true;

    expect(resolveAgentDeployment(agentWithDeployment)).toEqual({
      ...backgroundExecution,
      agentId: "agent-1",
      organizationId: "organization-1",
      environmentId: "environment-1",
      secretId: "secret-1",
    });
  });
});

const backgroundExecution = {
  image: "example.com/coding-agent:latest",
  command: null,
  inferenceProtocol: "openai_responses",
  backend: "kubernetes",
  steerMode: "pipe",
  privileged: false,
  resources: null,
  environment: null,
  credentials: null,
  ttlHours: null,
  idleTimeoutMinutes: null,
} satisfies AgentBackgroundExecution;

const agentWithDeployment = {
  id: "agent-1",
  organizationId: "organization-1",
  environmentId: "environment-1",
  backgroundExecution,
  backgroundExecutionSecretId: "secret-1",
};
