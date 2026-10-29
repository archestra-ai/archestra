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
 *
 * Domain rules match exactly, so an apex entry does not cover its subdomains.
 * Registries and mirrors serve from subdomains (`proxy.golang.org`,
 * `repo1.maven.org`, `deb.debian.org`), so each apex a preset trusts is paired
 * with a `*.` wildcard entry.
 */
const COMMON_DEPENDENCY_DOMAINS = Object.freeze([
  "alpinelinux.org",
  "*.alpinelinux.org",
  "archlinux.org",
  "*.archlinux.org",
  "bitbucket.org",
  "*.bitbucket.org",
  "centos.org",
  "*.centos.org",
  "crates.io",
  "*.crates.io",
  "debian.org",
  "*.debian.org",
  "docker.com",
  "*.docker.com",
  "docker.io",
  "*.docker.io",
  "fedoraproject.org",
  "*.fedoraproject.org",
  "files.pythonhosted.org",
  "gcr.io",
  "*.gcr.io",
  "ghcr.io",
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "*.gitlab.com",
  "golang.org",
  "*.golang.org",
  "goproxy.io",
  "gradle.org",
  "*.gradle.org",
  "hex.pm",
  "*.hex.pm",
  "maven.org",
  "*.maven.org",
  "mcr.microsoft.com",
  "*.data.mcr.microsoft.com",
  "nodejs.org",
  "*.nodejs.org",
  "npmjs.com",
  "*.npmjs.com",
  "npmjs.org",
  "*.npmjs.org",
  "nuget.org",
  "*.nuget.org",
  "packagecloud.io",
  "*.packagecloud.io",
  "packages.microsoft.com",
  "packagist.org",
  "*.packagist.org",
  "pkg.go.dev",
  "production.cloudflare.docker.com",
  "pub.dev",
  "*.pub.dev",
  "pypa.io",
  "*.pypa.io",
  "pypi.org",
  "*.pypi.org",
  "pypi.python.org",
  "pythonhosted.org",
  "*.pythonhosted.org",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "quay.io",
  "*.quay.io",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "ruby-lang.org",
  "*.ruby-lang.org",
  "rubygems.org",
  "*.rubygems.org",
  "rustup.rs",
  "*.rustup.rs",
  "ubuntu.com",
  "*.ubuntu.com",
  "yarnpkg.com",
  "*.yarnpkg.com",
]);

const PACKAGE_MANAGER_DOMAINS = Object.freeze([
  "crates.io",
  "*.crates.io",
  // apt mirrors used by the Debian-based sandbox and MCP server images.
  "deb.debian.org",
  "security.debian.org",
  "files.pythonhosted.org",
  "gcr.io",
  "*.gcr.io",
  "ghcr.io",
  "github.com",
  "*.github.com",
  "githubusercontent.com",
  "*.githubusercontent.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "golang.org",
  "*.golang.org",
  "goproxy.io",
  "gradle.org",
  "*.gradle.org",
  "hex.pm",
  "*.hex.pm",
  "maven.org",
  "*.maven.org",
  "mcr.microsoft.com",
  "*.data.mcr.microsoft.com",
  "npmjs.com",
  "*.npmjs.com",
  "npmjs.org",
  "*.npmjs.org",
  "nuget.org",
  "*.nuget.org",
  "packagist.org",
  "*.packagist.org",
  "pkg.go.dev",
  "registry-1.docker.io",
  "registry.npmjs.org",
  "rubygems.org",
  "*.rubygems.org",
  "rustup.rs",
  "*.rustup.rs",
  "pub.dev",
  "*.pub.dev",
  "pypi.org",
  "*.pypi.org",
  "pypi.python.org",
  "pythonhosted.org",
  "*.pythonhosted.org",
  "quay.io",
  "*.quay.io",
  "docker.io",
  "*.docker.io",
  "production.cloudflare.docker.com",
  "yarnpkg.com",
  "*.yarnpkg.com",
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
