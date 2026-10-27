import packageJson from "../../package.json";

/** The running platform version; read on call so `.env` loading can set it. */
export function getAppVersion(): string {
  return process.env.ARCHESTRA_VERSION || packageJson.version;
}

/**
 * The git ref of the running source: the `platform-v<version>` tag for a
 * release, else the version itself, which non-release builds set to the
 * commit SHA.
 */
export function getAppSourceRef(): string {
  const version = getAppVersion();
  return RELEASE_VERSION.test(version) ? `platform-v${version}` : version;
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
