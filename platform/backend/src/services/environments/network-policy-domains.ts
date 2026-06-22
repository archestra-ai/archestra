import type { NetworkPolicy, NetworkPolicyDomainPreset } from "@/types";

// === Public API ===

/**
 * The full set of allowlisted domains a restricted policy permits: the chosen
 * preset's domains plus any custom domains configured on the policy.
 *
 * This lives in a k8s-free module so both the K8s NetworkPolicy renderer and
 * the application-level remote-server URL check share one source of truth.
 */
export function networkPolicyDomains(policy: NetworkPolicy): string[] {
  return [...presetDomains(policy.domainPreset), ...policy.allowedDomains];
}

// === Internal helpers ===

/**
 * Preset allowlists are inspired by OpenAI Codex cloud internet access
 * presets and Claude Code web's trusted network access defaults.
 */
const COMMON_DEPENDENCY_DOMAINS = Object.freeze([
  "alpinelinux.org",
  "archlinux.org",
  "bitbucket.org",
  "centos.org",
  "crates.io",
  "debian.org",
  "docker.com",
  "docker.io",
  "*.docker.io",
  "fedoraproject.org",
  "files.pythonhosted.org",
  "gcr.io",
  "ghcr.io",
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "golang.org",
  "goproxy.io",
  "gradle.org",
  "hex.pm",
  "maven.org",
  "mcr.microsoft.com",
  "nodejs.org",
  "npmjs.com",
  "npmjs.org",
  "nuget.org",
  "packagecloud.io",
  "packages.microsoft.com",
  "packagist.org",
  "pkg.go.dev",
  "production.cloudflare.docker.com",
  "pub.dev",
  "pypa.io",
  "pypi.org",
  "pypi.python.org",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "quay.io",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "ruby-lang.org",
  "rubygems.org",
  "rustup.rs",
  "ubuntu.com",
  "yarnpkg.com",
]);

const PACKAGE_MANAGER_DOMAINS = Object.freeze([
  "crates.io",
  "files.pythonhosted.org",
  "gcr.io",
  "ghcr.io",
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "golang.org",
  "goproxy.io",
  "gradle.org",
  "hex.pm",
  "maven.org",
  "mcr.microsoft.com",
  "npmjs.com",
  "npmjs.org",
  "nuget.org",
  "packagist.org",
  "pkg.go.dev",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "rubygems.org",
  "rustup.rs",
  "pub.dev",
  "pypi.org",
  "pypi.python.org",
  "pythonhosted.org",
  "quay.io",
  "docker.io",
  "*.docker.io",
  "production.cloudflare.docker.com",
  "yarnpkg.com",
]);

function presetDomains(preset: NetworkPolicyDomainPreset): readonly string[] {
  switch (preset) {
    case "common_dependencies":
      return COMMON_DEPENDENCY_DOMAINS;
    case "package_managers":
      return PACKAGE_MANAGER_DOMAINS;
    case "none":
      return [];
  }
}
