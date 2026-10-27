import packageJson from "../../package.json";

/** The running platform version; read on call so `.env` loading can set it. */
export function getAppVersion(): string {
  return process.env.ARCHESTRA_VERSION || packageJson.version;
}
