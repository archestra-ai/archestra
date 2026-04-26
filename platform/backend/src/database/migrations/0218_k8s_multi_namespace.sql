-- Support different k8s cluster or namespace for Personal MCP servers
-- Adds per-team and org-level namespace/kubeconfig overrides (issue #3857)

ALTER TABLE "team" ADD COLUMN "k8s_namespace" text;
ALTER TABLE "team" ADD COLUMN "k8s_kubeconfig_base64" text;

ALTER TABLE "organization" ADD COLUMN "k8s_namespace" text;
ALTER TABLE "organization" ADD COLUMN "k8s_kubeconfig_base64" text;
