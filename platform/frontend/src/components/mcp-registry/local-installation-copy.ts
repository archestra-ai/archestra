/**
 * Copy describing a hosted server's installations. A single-tenant install is
 * its own running instance; a multi-tenant catalog runs one shared deployment,
 * so each install is only a connection to it.
 */
export function getLocalInstallationCopy(multitenant: boolean) {
  return multitenant ? MULTITENANT_COPY : SINGLE_TENANT_COPY;
}

// ===

const SINGLE_TENANT_COPY = {
  section:
    "Running instances of this server, for one person or shared with a team.",
  personal: "A private hosted instance available only to its owner.",
  shared: "Hosted instances shared with a team or organization.",
  installForMe:
    "Install creates a private hosted instance available only to you.",
};

const MULTITENANT_COPY: typeof SINGLE_TENANT_COPY = {
  section:
    "Access to one shared deployment, for one person or shared with a team.",
  personal: "Access to the shared deployment, usable only by its owner.",
  shared: "Access to the shared deployment for a team or organization.",
  installForMe:
    "Install gives you access to the shared deployment; only you can use it.",
};
