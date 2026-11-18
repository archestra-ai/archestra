// === Public API ===

/** What the platform can run in an environment's own cluster. */
export type EnvironmentClusterFeature =
  | "mcpServers"
  | "codeSandbox"
  | "agentRuntime";

/** An API the cluster serves only with a particular add-on installed. */
type ClusterAddOn = "cilium" | "gkeFqdn" | "awsAnp" | "agentSandbox";

export interface EnvironmentClusterPermission {
  /** The features that stop working without it. */
  features: EnvironmentClusterFeature[];
  apiGroup: string;
  resource: string;
  verbs: string[];
  /**
   * Set when the resource exists only with an add-on. The platform uses it
   * only on a cluster that has the add-on, so it is only needed there.
   */
  onlyWhen?: ClusterAddOn;
  /**
   * Not needed when the platform reaches the cluster through its cluster
   * agent, which does this itself from inside the cluster.
   */
  notThroughAgent?: true;
}

/**
 * Every Kubernetes permission the platform uses in an environment's own
 * cluster, in the namespace the environment names.
 *
 * It is the rule list the platform's Helm chart grants in the platform's own
 * cluster (`archestra-platform.mcpManagerRules`), less what only serves that
 * cluster, plus the port-forward the platform reaches HTTP MCP servers
 * through. A test holds the two lists together, so a permission added for the
 * platform's cluster is decided for environments' clusters too. The Role of
 * the `archestra-workloads` chart grants exactly this list, and "Test
 * connection" asks the cluster for each entry.
 */
export const ENVIRONMENT_CLUSTER_PERMISSIONS: EnvironmentClusterPermission[] = [
  {
    features: ["mcpServers", "agentRuntime"],
    apiGroup: "",
    resource: "pods",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["codeSandbox", "agentRuntime"],
    apiGroup: "",
    resource: "pods/exec",
    verbs: ["get", "create"],
  },
  {
    features: ["mcpServers"],
    apiGroup: "",
    resource: "pods/log",
    verbs: ["get", "list"],
  },
  {
    features: ["mcpServers"],
    apiGroup: "",
    resource: "pods/attach",
    verbs: ["get", "create"],
  },
  {
    // streamable-http MCP servers are reached through the API server, or
    // through the cluster agent, which connects to the pod itself.
    features: ["mcpServers"],
    apiGroup: "",
    resource: "pods/portforward",
    verbs: ["get", "create"],
    notThroughAgent: true,
  },
  {
    features: ["mcpServers"],
    apiGroup: "",
    resource: "services",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["mcpServers", "agentRuntime"],
    apiGroup: "",
    resource: "secrets",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["mcpServers"],
    apiGroup: "",
    resource: "events",
    verbs: ["get", "list", "watch"],
  },
  {
    features: ["codeSandbox"],
    apiGroup: "",
    resource: "configmaps",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["mcpServers"],
    apiGroup: "apps",
    resource: "deployments",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["codeSandbox"],
    apiGroup: "apps",
    resource: "statefulsets",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["codeSandbox", "agentRuntime"],
    apiGroup: "",
    resource: "persistentvolumeclaims",
    verbs: ["get", "list", "delete"],
  },
  {
    features: ["agentRuntime"],
    apiGroup: "agents.x-k8s.io",
    resource: "sandboxes",
    verbs: ["get", "list", "create", "patch", "delete"],
    onlyWhen: "agentSandbox",
  },
  {
    features: ["agentRuntime"],
    apiGroup: "agents.x-k8s.io",
    resource: "sandboxes/status",
    verbs: ["get"],
    onlyWhen: "agentSandbox",
  },
  {
    // Read and deleted together with a workspace's Sandbox.
    features: ["agentRuntime"],
    apiGroup: "extensions.agents.x-k8s.io",
    resource: "sandboxclaims",
    verbs: ["get", "list", "create", "patch", "delete"],
    onlyWhen: "agentSandbox",
  },
  {
    features: ["mcpServers", "codeSandbox", "agentRuntime"],
    apiGroup: "networking.k8s.io",
    resource: "networkpolicies",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
  },
  {
    features: ["mcpServers", "codeSandbox", "agentRuntime"],
    apiGroup: "cilium.io",
    resource: "ciliumnetworkpolicies",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
    onlyWhen: "cilium",
  },
  {
    features: ["mcpServers", "codeSandbox", "agentRuntime"],
    apiGroup: "networking.gke.io",
    resource: "fqdnnetworkpolicies",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
    onlyWhen: "gkeFqdn",
  },
  {
    features: ["mcpServers", "codeSandbox", "agentRuntime"],
    apiGroup: "networking.k8s.aws",
    resource: "applicationnetworkpolicies",
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"],
    onlyWhen: "awsAnp",
  },
];
