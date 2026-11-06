import fs from "node:fs";
import net from "node:net";
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
const CREDENTIAL_PROVIDER_MAX_AGE_MS = 60_000;

function safeFileMtimeMs(filePath: string | undefined): number {
  if (!filePath) {
    return 0;
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function computeCredentialFingerprint(env: NodeJS.ProcessEnv): string {
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  const sharedCredsFile = env.AWS_SHARED_CREDENTIALS_FILE;
  return [
    env.AWS_ACCESS_KEY_ID ?? "",
    env.AWS_SECRET_ACCESS_KEY ?? "",
    env.AWS_SESSION_TOKEN ?? "",
    env.AWS_PROFILE ?? "",
    env.AWS_ROLE_ARN ?? "",
    tokenFile ?? "",
    String(safeFileMtimeMs(tokenFile)),
    sharedCredsFile ?? "",
    String(safeFileMtimeMs(sharedCredsFile)),
  ].join("|");
}

function createRefreshingCredentialProvider(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof fromNodeProviderChain> {
  let cachedProvider: ReturnType<typeof fromNodeProviderChain> | null = null;
  let cachedFingerprint = "";
  let cachedAt = 0;

  return async (options) => {
    if (
      env !== process.env &&
      env.AWS_ACCESS_KEY_ID &&
      env.AWS_SECRET_ACCESS_KEY
    ) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      };
    }
    const now = Date.now();
    const fingerprint = computeCredentialFingerprint(env);
    if (
      !cachedProvider ||
      fingerprint !== cachedFingerprint ||
      now - cachedAt >= CREDENTIAL_PROVIDER_MAX_AGE_MS ||
      options?.forceRefresh
    ) {
      cachedProvider = fromNodeProviderChain();
      cachedFingerprint = fingerprint;
      cachedAt = now;
    }
    try {
      return await cachedProvider(options);
    } catch (error) {
      cachedProvider = null;
      throw error;
    }
  };
}

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
  const resolvedCredentials =
    credentials ?? createRefreshingCredentialProvider(env);
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

  Object.defineProperty(sslConfig, "toJSON", {
    value: () => ({
      rejectUnauthorized: sslConfig.rejectUnauthorized,
    }),
    enumerable: false,
  });

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

const PG_SSL_REQUEST_PACKET = Buffer.from([
  0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f,
]);
const PG_CANCEL_REQUEST_CODE = 80877102;
const nativeBridgePromises = new Map<string, Promise<string>>();
const nativeBridgeServers = new Set<net.Server>();

/**
 * Resolves a PostgreSQL connection URL for embedded native Rust consumers
 * (`@archestra/openappa-rs` / `rust-postgres`) that accept only a static URL
 * string and cannot invoke a per-connection JS password callback.
 *
 * When RDS IAM auth is disabled (default), returns `connectionString` unchanged.
 *
 * When RDS IAM auth is enabled, starts an in-process loopback bridge on
 * `127.0.0.1` that opens a verified TLS connection (using the RDS CA bundle
 * and hostname verification) to the upstream RDS instance and injects a fresh
 * presigned RDS IAM token into the PostgreSQL `PasswordMessage` of every new
 * connection opened by the native pool.
 */
export async function resolveNativeDatabaseConnectionString(
  connectionString: string,
  options: RdsIamConnectionOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const iamAuthEnabled = options.iamAuthEnabled ?? isRdsIamAuthEnabled(env);

  if (!iamAuthEnabled) {
    return connectionString;
  }

  const cacheKey = `${connectionString}|${options.awsRegion ?? env.ARCHESTRA_DATABASE_AWS_REGION ?? ""}`;
  const existing = nativeBridgePromises.get(cacheKey);
  if (existing && options.credentials === undefined) {
    return existing;
  }

  const pgConfig = buildPgConnectionConfig(connectionString, {}, options);
  const rdsHost = pgConfig.host;
  const rdsPort = Number(pgConfig.port || 5432);
  const sslConfig = pgConfig.ssl;
  const passwordCallback = pgConfig.password;

  if (!rdsHost || typeof passwordCallback !== "function") {
    return connectionString;
  }

  const createBridgePromise = (async () => {
    const server = net.createServer((clientSocket) => {
      clientSocket.unref();
      const upstreamTcp = net.connect(rdsPort, rdsHost);
      upstreamTcp.unref();
      let clientBuf = Buffer.alloc(0);
      let upstreamSocket: net.Socket | tls.TLSSocket | null = null;
      let upstreamReady = false;
      let startupForwarded = false;
      let passwordIntercepted = false;
      let passthrough = false;

      const destroyBoth = (err?: Error) => {
        if (err) {
          clientSocket.destroy(err);
        } else {
          clientSocket.destroy();
        }
        if (upstreamSocket) {
          upstreamSocket.destroy();
        } else {
          upstreamTcp.destroy();
        }
      };

      const pumpClient = () => {
        if (!upstreamReady || !upstreamSocket) {
          return;
        }
        if (!startupForwarded) {
          if (clientBuf.length < 4) {
            return;
          }
          const startupLen = clientBuf.readInt32BE(0);
          if (startupLen < 8 || clientBuf.length < startupLen) {
            return;
          }
          const startupMsg = clientBuf.subarray(0, startupLen);
          clientBuf = clientBuf.subarray(startupLen);
          startupForwarded = true;
          upstreamSocket.write(startupMsg);

          if (
            startupLen === 16 &&
            startupMsg.readInt32BE(4) === PG_CANCEL_REQUEST_CODE
          ) {
            passthrough = true;
          }
        }

        if (startupForwarded && !passwordIntercepted && !passthrough) {
          if (clientBuf.length < 5) {
            return;
          }
          if (clientBuf[0] !== 0x70) {
            upstreamSocket.write(clientBuf);
            clientBuf = Buffer.alloc(0);
            passthrough = true;
            return;
          }
          const msgLen = clientBuf.readInt32BE(1);
          if (msgLen < 4 || clientBuf.length < 1 + msgLen) {
            return;
          }
          clientBuf = clientBuf.subarray(1 + msgLen);
          passwordIntercepted = true;

          Promise.resolve(passwordCallback())
            .then((token) => {
              const tokenBytes = Buffer.from(`${token}\0`, "utf8");
              const msg = Buffer.allocUnsafe(1 + 4 + tokenBytes.length);
              msg[0] = 0x70;
              msg.writeInt32BE(4 + tokenBytes.length, 1);
              tokenBytes.copy(msg, 5);
              upstreamSocket?.write(msg);
              if (clientBuf.length > 0) {
                upstreamSocket?.write(clientBuf);
                clientBuf = Buffer.alloc(0);
              }
              passthrough = true;
            })
            .catch((err: unknown) => {
              destroyBoth(err instanceof Error ? err : new Error(String(err)));
            });
        }
      };

      clientSocket.on("data", (chunk: Buffer) => {
        if (passthrough && upstreamSocket) {
          upstreamSocket.write(chunk);
          return;
        }
        clientBuf = Buffer.concat([clientBuf, chunk]);
        pumpClient();
      });

      upstreamTcp.once("connect", () => {
        if (sslConfig === false) {
          upstreamSocket = upstreamTcp;
          upstreamReady = true;
          upstreamTcp.on("data", (d) => clientSocket.write(d));
          upstreamTcp.on("end", () => clientSocket.end());
          upstreamTcp.on("close", () => clientSocket.destroy());
          pumpClient();
          return;
        }

        upstreamTcp.write(PG_SSL_REQUEST_PACKET);
        upstreamTcp.once("data", (resp: Buffer) => {
          if (resp[0] !== 0x53) {
            destroyBoth(
              new Error(
                "Upstream PostgreSQL server rejected SSLRequest required for RDS IAM authentication.",
              ),
            );
            return;
          }
          const tlsSock = tls.connect({
            socket: upstreamTcp,
            host: rdsHost,
            servername: rdsHost,
            ...(typeof sslConfig === "object" ? sslConfig : {}),
          });
          tlsSock.unref();
          upstreamSocket = tlsSock;
          tlsSock.once("secureConnect", () => {
            upstreamReady = true;
            tlsSock.on("data", (d) => clientSocket.write(d));
            tlsSock.on("end", () => clientSocket.end());
            tlsSock.on("close", () => clientSocket.destroy());
            tlsSock.on("error", () => clientSocket.destroy());
            pumpClient();
          });
          tlsSock.on("error", () => clientSocket.destroy());
        });
      });

      upstreamTcp.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => destroyBoth());
      clientSocket.on("close", () => destroyBoth());
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    server.unref();
    nativeBridgeServers.add(server);
    server.once("close", () => {
      nativeBridgeServers.delete(server);
      nativeBridgePromises.delete(cacheKey);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to bind RDS IAM loopback bridge.");
    }

    const { parsedUrl } = parseDatabaseUrl(connectionString, env);
    parsedUrl.hostname = "127.0.0.1";
    parsedUrl.port = String(address.port);
    parsedUrl.password = "rds-iam-bridge";
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
    parsedUrl.searchParams.set("sslmode", "disable");
    return parsedUrl.toString();
  })().catch((err) => {
    nativeBridgePromises.delete(cacheKey);
    throw err;
  });

  if (options.credentials === undefined) {
    nativeBridgePromises.set(cacheKey, createBridgePromise);
  }
  return createBridgePromise;
}

/**
 * Closes any active in-process RDS IAM loopback bridges (for test cleanup).
 * @public — exported for unit tests
 */
export async function closeRdsIamNativeBridges(): Promise<void> {
  const servers = [...nativeBridgeServers];
  nativeBridgeServers.clear();
  nativeBridgePromises.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
}
