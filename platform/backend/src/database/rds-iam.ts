import fs from "node:fs";
import tls, { type ConnectionOptions } from "node:tls";
import { fileURLToPath } from "node:url";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import pg, { type ClientConfig, type PoolConfig } from "pg";

type AwsCredentialsInput = ConstructorParameters<
  typeof SignatureV4
>[0]["credentials"];

interface RdsIamRegionOptions {
  hostname?: string;
  awsRegion?: string;
  env?: NodeJS.ProcessEnv;
}

interface GenerateRdsIamAuthTokenOptions {
  hostname: string;
  port?: number;
  username: string;
  region: string;
  credentials?: AwsCredentialsInput;
}

interface CreateRdsIamPasswordCallbackOptions {
  hostname: string;
  port?: number;
  username: string;
  awsRegion?: string;
  credentials?: AwsCredentialsInput;
  env?: NodeJS.ProcessEnv;
}

interface RdsIamConnectionOptions {
  iamAuthEnabled?: boolean;
  awsRegion?: string;
  credentials?: AwsCredentialsInput;
  env?: NodeJS.ProcessEnv;
}

const RDS_HOSTNAME_REGION_PATTERN =
  /\.([a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d+)\.rds\.amazonaws\.com(?:\.cn)?\.?$/i;

const RDS_IAM_TOKEN_EXPIRES_IN_SECONDS = 900;

const BUNDLED_CLOUD_CA_PATHS = [
  "/etc/ssl/certs/cloud-database-ca-bundle.pem",
  fileURLToPath(
    new URL("../../../docker/certs/aws-rds-global-bundle.pem", import.meta.url),
  ),
];

let cachedDefaultCloudCaList: string[] | null | undefined;

function loadDefaultCloudCaList(): string[] | null {
  if (cachedDefaultCloudCaList !== undefined) {
    return cachedDefaultCloudCaList;
  }
  for (const candidatePath of BUNDLED_CLOUD_CA_PATHS) {
    try {
      if (fs.existsSync(candidatePath)) {
        const pem = fs.readFileSync(candidatePath, "utf8");
        if (pem.trim().length > 0) {
          cachedDefaultCloudCaList = [...tls.rootCertificates, pem];
          return cachedDefaultCloudCaList;
        }
      }
    } catch {
      // Ignore unreadable candidate path and continue fallback chain.
    }
  }
  cachedDefaultCloudCaList = null;
  return cachedDefaultCloudCaList;
}

function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Returns true when RDS IAM database authentication is enabled in the environment.
 * @public — exported for unit tests
 */
export function isRdsIamAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ARCHESTRA_DATABASE_IAM_AUTH_ENABLED === "true";
}

/**
 * Extracts the AWS region from an RDS, Aurora, or RDS Proxy endpoint hostname.
 * Returns null when the hostname does not match the RDS endpoint pattern.
 * @public — exported for unit tests
 */
export function rdsRegionFromHostname(
  hostname: string | undefined | null,
): string | null {
  if (!hostname || typeof hostname !== "string") {
    return null;
  }
  const match = hostname.trim().match(RDS_HOSTNAME_REGION_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resolves the AWS region used to sign RDS IAM authentication tokens.
 * Precedence:
 * 1. Explicit `awsRegion` option
 * 2. `ARCHESTRA_DATABASE_AWS_REGION` environment variable
 * 3. Region embedded in the `*.rds.amazonaws.com` hostname
 * 4. `AWS_REGION` or `AWS_DEFAULT_REGION` environment variable
 * @public — exported for unit tests
 */
export function resolveDatabaseAwsRegion({
  hostname,
  awsRegion,
  env = process.env,
}: RdsIamRegionOptions = {}): string {
  const explicit = awsRegion?.trim();
  if (explicit) {
    return explicit;
  }

  const fromArchestraEnv = env.ARCHESTRA_DATABASE_AWS_REGION?.trim();
  if (fromArchestraEnv) {
    return fromArchestraEnv;
  }

  const fromHost = rdsRegionFromHostname(hostname);
  if (fromHost) {
    return fromHost;
  }

  const fromAwsEnv = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (fromAwsEnv) {
    return fromAwsEnv;
  }

  throw new Error(
    "Cannot determine AWS region for RDS IAM database authentication. Set ARCHESTRA_DATABASE_AWS_REGION or AWS_REGION, or use an *.rds.amazonaws.com database hostname.",
  );
}

/**
 * Generates a presigned 15-minute RDS IAM authentication token for `rds-db:connect`.
 * @public — exported for unit tests
 */
export async function generateRdsIamAuthToken({
  hostname,
  port = 5432,
  username,
  region,
  credentials = fromNodeProviderChain(),
}: GenerateRdsIamAuthTokenOptions): Promise<string> {
  const trimmedHost = hostname?.trim().replace(/\.$/, "");
  if (!trimmedHost) {
    throw new Error("RDS IAM authentication requires a database hostname.");
  }
  const trimmedUser = username?.trim();
  if (!trimmedUser) {
    throw new Error("RDS IAM authentication requires a database username.");
  }
  const trimmedRegion = region?.trim();
  if (!trimmedRegion) {
    throw new Error("RDS IAM authentication requires an AWS region.");
  }
  const numericPort = Number(port);
  if (
    !Number.isInteger(numericPort) ||
    numericPort < 1 ||
    numericPort > 65535
  ) {
    throw new Error(`Invalid database port for RDS IAM auth: ${String(port)}`);
  }

  const signer = new SignatureV4({
    service: "rds-db",
    region: trimmedRegion,
    credentials,
    sha256: Sha256,
  });

  const presigned = await signer.presign(
    {
      method: "GET",
      protocol: "https:",
      hostname: trimmedHost,
      port: numericPort,
      path: "/",
      query: {
        Action: "connect",
        DBUser: trimmedUser,
      },
      headers: {
        host: `${trimmedHost}:${numericPort}`,
      },
    },
    {
      expiresIn: RDS_IAM_TOKEN_EXPIRES_IN_SECONDS,
    },
  );

  const queryString = Object.entries(presigned.query ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${escapeUri(key)}=${escapeUri(String(value))}`)
    .join("&");

  return `${presigned.hostname}:${presigned.port}${presigned.path}?${queryString}`;
}

/**
 * Creates a node-postgres dynamic `password` callback that signs a fresh RDS IAM
 * token on every new connection.
 * @public — exported for unit tests
 */
export function createRdsIamPasswordCallback({
  hostname,
  port = 5432,
  username,
  awsRegion,
  credentials,
  env = process.env,
}: CreateRdsIamPasswordCallbackOptions): () => Promise<string> {
  const region = resolveDatabaseAwsRegion({ hostname, awsRegion, env });
  const resolvedCredentials = credentials ?? fromNodeProviderChain();
  return () =>
    generateRdsIamAuthToken({
      hostname,
      port,
      username,
      region,
      credentials: resolvedCredentials,
    });
}

function parseDatabaseUrl(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    throw new Error("Invalid database connection URL.");
  }

  const params = parsedUrl.searchParams;
  const host =
    params.get("host") || decodeURIComponent(parsedUrl.hostname || "");
  const rawPort = params.get("port") || parsedUrl.port;
  const port = rawPort ? Number.parseInt(rawPort, 10) : 5432;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid database port in connection URL: ${rawPort}`);
  }

  const user =
    params.get("user") ||
    decodeURIComponent(parsedUrl.username || "") ||
    env.PGUSER ||
    "";
  const pathname = parsedUrl.pathname.replace(/^\/+/, "");
  const database =
    params.get("dbname") ||
    params.get("database") ||
    (pathname ? decodeURIComponent(pathname) : undefined) ||
    env.PGDATABASE ||
    user ||
    undefined;

  const optionalParams: Record<string, string | number> = {};
  for (const key of [
    "application_name",
    "fallback_application_name",
    "options",
    "client_encoding",
  ]) {
    const value = params.get(key);
    if (value !== null) {
      optionalParams[key] = value;
    }
  }
  if (!optionalParams.options && env.PGOPTIONS) {
    optionalParams.options = env.PGOPTIONS;
  }
  if (!optionalParams.application_name && env.PGAPPNAME) {
    optionalParams.application_name = env.PGAPPNAME;
  }

  for (const numericKey of [
    "statement_timeout",
    "lock_timeout",
    "idle_in_transaction_session_timeout",
    "query_timeout",
  ]) {
    const raw = params.get(numericKey);
    if (raw !== null && raw !== "") {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        optionalParams[numericKey] = parsed;
      }
    }
  }

  return {
    parsedUrl,
    host,
    port,
    user,
    database,
    optionalParams,
  };
}

/**
 * Resolves the node-postgres `ssl` option for RDS IAM connections while keeping
 * TLS certificate and hostname verification with the RDS CA bundle.
 * @public — exported for unit tests
 */
export function resolvePgSslConfig(
  connectionString: string,
  {
    iamAuthEnabled = true,
    env = process.env,
  }: { iamAuthEnabled?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean | ConnectionOptions | undefined {
  if (!iamAuthEnabled) {
    return undefined;
  }

  const { parsedUrl } = parseDatabaseUrl(connectionString, env);
  const params = parsedUrl.searchParams;
  const sslMode = (params.get("sslmode") ?? env.PGSSLMODE ?? "").toLowerCase();
  const sslParam = (params.get("ssl") ?? "").toLowerCase();

  if (sslMode === "disable" || sslParam === "false" || sslParam === "0") {
    return false;
  }

  if (sslMode === "no-verify" || sslParam === "no-verify") {
    return { rejectUnauthorized: false };
  }

  const sslConfig: ConnectionOptions = {
    rejectUnauthorized: true,
  };

  const sslRootCertPath = params.get("sslrootcert") || env.PGSSLROOTCERT;
  if (sslRootCertPath) {
    sslConfig.ca = fs.readFileSync(sslRootCertPath, "utf8");
  } else {
    const defaultCloudCa = loadDefaultCloudCaList();
    if (defaultCloudCa) {
      sslConfig.ca = defaultCloudCa;
    }
  }

  const sslCertPath = params.get("sslcert") || env.PGSSLCERT;
  if (sslCertPath) {
    sslConfig.cert = fs.readFileSync(sslCertPath, "utf8");
  }

  const sslKeyPath = params.get("sslkey") || env.PGSSLKEY;
  if (sslKeyPath) {
    sslConfig.key = fs.readFileSync(sslKeyPath, "utf8");
  }

  return sslConfig;
}

/**
 * Builds a node-postgres Pool or Client configuration object.
 *
 * When RDS IAM auth is disabled (default), returns `{ connectionString, ...extraConfig }`
 * unchanged.
 *
 * When RDS IAM auth is enabled, omits `connectionString` (because node-postgres
 * overwrites a `password` callback with `""` when `connectionString` is present)
 * and supplies parsed host/port/user/database, TLS verification with the RDS CA
 * bundle, and a dynamic `password` callback that signs a fresh token per new
 * connection.
 */
export function buildPgConnectionConfig<
  TExtra extends PoolConfig | ClientConfig = PoolConfig,
>(
  connectionString: string,
  extraConfig: TExtra = {} as TExtra,
  options: RdsIamConnectionOptions = {},
): TExtra & PoolConfig & ClientConfig {
  const env = options.env ?? process.env;
  const iamAuthEnabled = options.iamAuthEnabled ?? isRdsIamAuthEnabled(env);

  if (!iamAuthEnabled) {
    return {
      connectionString,
      ...extraConfig,
    };
  }

  const { host, port, user, database, optionalParams } = parseDatabaseUrl(
    connectionString,
    env,
  );

  if (!host) {
    throw new Error(
      "RDS IAM database authentication requires a host in ARCHESTRA_DATABASE_URL.",
    );
  }
  if (!user) {
    throw new Error(
      "RDS IAM database authentication requires a username in ARCHESTRA_DATABASE_URL.",
    );
  }

  const password = createRdsIamPasswordCallback({
    hostname: host,
    port,
    username: user,
    awsRegion: options.awsRegion,
    credentials: options.credentials,
    env,
  });

  const ssl =
    extraConfig.ssl !== undefined
      ? extraConfig.ssl
      : resolvePgSslConfig(connectionString, { iamAuthEnabled: true, env });

  return {
    ...optionalParams,
    host,
    port,
    user,
    database,
    ...extraConfig,
    ssl,
    password,
  };
}

/**
 * Configures `pg.defaults` for tools like `drizzle-kit migrate` that accept only a
 * `dbCredentials.url` string and construct `new pg.Pool({ connectionString: url })`
 * internally.
 * @public — exported for unit tests
 */
export function configurePgDefaultsForRdsIam(
  connectionString: string,
  options: RdsIamConnectionOptions = {},
): string {
  const env = options.env ?? process.env;
  const iamAuthEnabled = options.iamAuthEnabled ?? isRdsIamAuthEnabled(env);

  if (!iamAuthEnabled) {
    return connectionString;
  }

  const pgConfig = buildPgConnectionConfig(connectionString, {}, options);
  (pg.defaults as { password?: unknown }).password = pgConfig.password;
  pg.defaults.ssl = pgConfig.ssl;

  delete env.PGPASSWORD;
  delete env.PGSSLMODE;

  const { parsedUrl } = parseDatabaseUrl(connectionString, env);
  parsedUrl.password = "";
  for (const param of [
    "password",
    "ssl",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "uselibpqcompat",
  ]) {
    parsedUrl.searchParams.delete(param);
  }

  return parsedUrl.toString();
}
