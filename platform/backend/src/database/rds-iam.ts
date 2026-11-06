import crypto from "node:crypto";
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

interface RefreshingCredentialProviderOptions {
  env?: NodeJS.ProcessEnv;
  providerFactory?: () => ReturnType<typeof fromNodeProviderChain>;
  now?: () => number;
  maxAgeMs?: number;
}

interface CreateRdsIamPasswordCallbackOptions {
  hostname: string;
  port?: number;
  username: string;
  awsRegion?: string;
  credentials?: AwsCredentialsInput;
  env?: NodeJS.ProcessEnv;
  providerFactory?: () => ReturnType<typeof fromNodeProviderChain>;
  now?: () => number;
}

export interface RdsIamConnectionOptions {
  iamAuthEnabled?: boolean;
  awsRegion?: string;
  credentials?: AwsCredentialsInput;
  env?: NodeJS.ProcessEnv;
  handshakeTimeoutMs?: number;
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

/**
 * Wraps the AWS credential provider chain so rotated projected WebIdentity
 * token files (`AWS_WEB_IDENTITY_TOKEN_FILE`), shared credential files, or
 * expired provider instances are rebuilt automatically.
 * @public — exported for unit tests
 */
export function createRefreshingCredentialProvider({
  env = process.env,
  providerFactory = () => fromNodeProviderChain(),
  now = () => Date.now(),
  maxAgeMs = CREDENTIAL_PROVIDER_MAX_AGE_MS,
}: RefreshingCredentialProviderOptions = {}): ReturnType<
  typeof fromNodeProviderChain
> {
  let cachedProvider: ReturnType<typeof fromNodeProviderChain> | null = null;
  let cachedFingerprint = "";
  let cachedAt = 0;

  return async (options) => {
    const currentTime = now();
    const fingerprint = computeCredentialFingerprint(env);
    if (
      !cachedProvider ||
      fingerprint !== cachedFingerprint ||
      currentTime - cachedAt >= maxAgeMs ||
      options?.forceRefresh
    ) {
      cachedProvider = providerFactory();
      cachedFingerprint = fingerprint;
      cachedAt = currentTime;
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
  providerFactory,
  now,
}: CreateRdsIamPasswordCallbackOptions): () => Promise<string> {
  const region = resolveDatabaseAwsRegion({ hostname, awsRegion, env });
  const resolvedCredentials =
    credentials ??
    createRefreshingCredentialProvider({
      env,
      providerFactory,
      now,
    });
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

  if (
    sslMode === "disable" ||
    sslParam === "false" ||
    sslParam === "0" ||
    sslMode === "no-verify" ||
    sslParam === "no-verify"
  ) {
    throw new Error(
      "TLS must stay enabled when RDS IAM database authentication is enabled; sslmode=disable and sslmode=no-verify are not permitted. Use the bundled RDS CA bundle or set sslrootcert / PGSSLROOTCERT.",
    );
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

const PG_SSL_REQUEST_CODE = 80877103;
const PG_STARTUP_PROTOCOL_V3 = 0x00030000;
const PG_SSL_REQUEST_PACKET = Buffer.from([
  0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f,
]);
const PG_AUTH_CLEARTEXT_REQUEST_PACKET = Buffer.from([
  0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x03,
]);
const DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_BRIDGE_HANDSHAKE_BYTES = 16 * 1024;
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
  if (
    existing &&
    options.credentials === undefined &&
    options.handshakeTimeoutMs === undefined
  ) {
    return existing;
  }

  const pgConfig = buildPgConnectionConfig(connectionString, {}, options);
  const rdsHost = pgConfig.host;
  const rdsPort = Number(pgConfig.port || 5432);
  const sslConfig = pgConfig.ssl;
  const passwordCallback = pgConfig.password;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS;

  if (!rdsHost || typeof passwordCallback !== "function") {
    return connectionString;
  }

  const createBridgePromise = (async () => {
    const bridgeSecret = crypto.randomBytes(32).toString("hex");
    const expectedSecretBytes = Buffer.from(bridgeSecret, "utf8");

    const server = net.createServer((clientSocket) => {
      clientSocket.unref();
      let clientBuf = Buffer.alloc(0);
      let startupMsg: Buffer | null = null;
      let localAuthenticated = false;
      let upstreamStarted = false;
      let upstreamTcp: net.Socket | null = null;
      let upstreamSocket: net.Socket | tls.TLSSocket | null = null;
      let upstreamBuf = Buffer.alloc(0);
      let upstreamChallengeConsumed = false;
      let passthrough = false;

      const destroyBoth = (err?: Error) => {
        clearTimeout(handshakeTimer);
        if (err) {
          clientSocket.destroy(err);
        } else {
          clientSocket.destroy();
        }
        if (upstreamSocket) {
          upstreamSocket.destroy();
        } else if (upstreamTcp) {
          upstreamTcp.destroy();
        }
      };

      const handshakeTimer = setTimeout(() => {
        destroyBoth(new Error("RDS IAM loopback bridge handshake timed out."));
      }, handshakeTimeoutMs);
      handshakeTimer.unref();

      const startUpstreamConnection = () => {
        if (upstreamStarted || !startupMsg) {
          return;
        }
        upstreamStarted = true;
        const validatedStartupMsg = startupMsg;
        const tokenPromise = Promise.resolve().then(() => passwordCallback());
        tokenPromise.catch(() => {});

        const tcpSock = net.connect(rdsPort, rdsHost);
        tcpSock.unref();
        upstreamTcp = tcpSock;

        tcpSock.once("connect", () => {
          tcpSock.write(PG_SSL_REQUEST_PACKET);
          tcpSock.once("data", (resp: Buffer) => {
            if (resp[0] !== 0x53) {
              destroyBoth(
                new Error(
                  "Upstream PostgreSQL server rejected SSLRequest required for RDS IAM authentication.",
                ),
              );
              return;
            }
            const tlsSock = tls.connect({
              socket: tcpSock,
              host: rdsHost,
              ...(net.isIP(rdsHost) === 0 ? { servername: rdsHost } : {}),
              ...(typeof sslConfig === "object" ? sslConfig : {}),
            });
            tlsSock.unref();
            upstreamSocket = tlsSock;
            tlsSock.once("secureConnect", () => {
              tlsSock.write(validatedStartupMsg);
              tlsSock.on("data", (d: Buffer) => {
                if (passthrough) {
                  clientSocket.write(d);
                  return;
                }
                if (
                  upstreamBuf.length + d.length >
                  MAX_BRIDGE_HANDSHAKE_BYTES
                ) {
                  destroyBoth(
                    new Error(
                      "Upstream PostgreSQL handshake buffer limit exceeded.",
                    ),
                  );
                  return;
                }
                upstreamBuf = Buffer.concat([upstreamBuf, d]);
                if (upstreamChallengeConsumed || upstreamBuf.length < 5) {
                  return;
                }
                const msgType = upstreamBuf[0];
                const msgLen = upstreamBuf.readInt32BE(1);
                if (msgLen < 4 || 1 + msgLen > MAX_BRIDGE_HANDSHAKE_BYTES) {
                  destroyBoth(
                    new Error(
                      "Invalid upstream PostgreSQL handshake message length.",
                    ),
                  );
                  return;
                }
                if (upstreamBuf.length < 1 + msgLen) {
                  return;
                }
                upstreamChallengeConsumed = true;
                if (
                  msgType === 0x52 &&
                  msgLen === 8 &&
                  upstreamBuf.readInt32BE(5) === 3
                ) {
                  upstreamBuf = upstreamBuf.subarray(9);
                  tokenPromise
                    .then((token) => {
                      clearTimeout(handshakeTimer);
                      const tokenBytes = Buffer.from(`${token}\0`, "utf8");
                      const msg = Buffer.allocUnsafe(1 + 4 + tokenBytes.length);
                      msg[0] = 0x70;
                      msg.writeInt32BE(4 + tokenBytes.length, 1);
                      tokenBytes.copy(msg, 5);
                      tlsSock.write(msg);
                      if (upstreamBuf.length > 0) {
                        clientSocket.write(upstreamBuf);
                        upstreamBuf = Buffer.alloc(0);
                      }
                      if (clientBuf.length > 0) {
                        tlsSock.write(clientBuf);
                        clientBuf = Buffer.alloc(0);
                      }
                      passthrough = true;
                    })
                    .catch((err: unknown) => {
                      destroyBoth(
                        err instanceof Error ? err : new Error(String(err)),
                      );
                    });
                } else {
                  clearTimeout(handshakeTimer);
                  passthrough = true;
                  clientSocket.write(upstreamBuf);
                  upstreamBuf = Buffer.alloc(0);
                }
              });
              tlsSock.on("end", () => clientSocket.end());
              tlsSock.on("close", () => clientSocket.destroy());
            });
            tlsSock.on("error", (err) => destroyBoth(err));
          });
        });

        tcpSock.on("error", (err) => destroyBoth(err));
      };

      const processLocalHandshake = () => {
        if (!startupMsg) {
          if (
            clientBuf.length >= 8 &&
            clientBuf.readInt32BE(0) === 8 &&
            clientBuf.readInt32BE(4) === PG_SSL_REQUEST_CODE
          ) {
            clientBuf = clientBuf.subarray(8);
            clientSocket.write(Buffer.from([0x4e]));
          }
          if (clientBuf.length < 4) {
            return;
          }
          const startupLen = clientBuf.readInt32BE(0);
          if (startupLen < 8 || startupLen > MAX_BRIDGE_HANDSHAKE_BYTES) {
            destroyBoth(
              new Error(
                "Rejected RDS IAM loopback bridge client: invalid StartupMessage length.",
              ),
            );
            return;
          }
          if (clientBuf.length < 8) {
            return;
          }
          if (clientBuf.readInt32BE(4) !== PG_STARTUP_PROTOCOL_V3) {
            destroyBoth(
              new Error(
                "Rejected RDS IAM loopback bridge client: unsupported startup protocol.",
              ),
            );
            return;
          }
          if (clientBuf.length < startupLen) {
            return;
          }
          startupMsg = Buffer.from(clientBuf.subarray(0, startupLen));
          clientBuf = clientBuf.subarray(startupLen);
          clientSocket.write(PG_AUTH_CLEARTEXT_REQUEST_PACKET);
        }

        if (startupMsg && !localAuthenticated) {
          if (clientBuf.length < 5) {
            return;
          }
          if (clientBuf[0] !== 0x70) {
            destroyBoth(
              new Error(
                "Rejected RDS IAM loopback bridge client: expected PasswordMessage.",
              ),
            );
            return;
          }
          const msgLen = clientBuf.readInt32BE(1);
          if (msgLen < 4 || 1 + msgLen > MAX_BRIDGE_HANDSHAKE_BYTES) {
            destroyBoth(
              new Error(
                "Rejected RDS IAM loopback bridge client: invalid PasswordMessage length.",
              ),
            );
            return;
          }
          if (clientBuf.length < 1 + msgLen) {
            return;
          }
          const rawPasswordPayload = clientBuf.subarray(5, 1 + msgLen);
          const nullIndex = rawPasswordPayload.indexOf(0);
          const clientSecretBytes =
            nullIndex >= 0
              ? rawPasswordPayload.subarray(0, nullIndex)
              : rawPasswordPayload;
          clientBuf = clientBuf.subarray(1 + msgLen);

          if (
            clientSecretBytes.length !== expectedSecretBytes.length ||
            !crypto.timingSafeEqual(clientSecretBytes, expectedSecretBytes)
          ) {
            destroyBoth(
              new Error(
                "Rejected RDS IAM loopback bridge client: invalid per-bridge secret.",
              ),
            );
            return;
          }

          localAuthenticated = true;
          startUpstreamConnection();
        }
      };

      clientSocket.on("data", (chunk: Buffer) => {
        if (passthrough && upstreamSocket) {
          upstreamSocket.write(chunk);
          return;
        }
        if (clientBuf.length + chunk.length > MAX_BRIDGE_HANDSHAKE_BYTES) {
          destroyBoth(
            new Error(
              "Rejected RDS IAM loopback bridge client: handshake buffer limit exceeded.",
            ),
          );
          return;
        }
        clientBuf = Buffer.concat([clientBuf, chunk]);
        processLocalHandshake();
      });

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
    parsedUrl.password = bridgeSecret;
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

  if (
    options.credentials === undefined &&
    options.handshakeTimeoutMs === undefined
  ) {
    nativeBridgePromises.set(cacheKey, createBridgePromise);
  }
  return createBridgePromise;
}

const TRANSIENT_NATIVE_STORAGE_PATTERN =
  /SQLSTATE (?:57P0[123]|0800[01346])|connection closed|broken pipe|connection reset|unexpected EOF/i;

/**
 * Returns true when a native storage error represents a dropped or terminated
 * PostgreSQL connection that may be retried on a fresh pool connection for
 * read-only or idempotent operations.
 * @public — exported for unit tests
 */
export function isTransientNativeStorageDisconnect(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return TRANSIENT_NATIVE_STORAGE_PATTERN.test(error.message);
}

/**
 * Retries a read-only or idempotent native OpenAPPA storage operation with
 * bounded exponential backoff when an idle pooled connection was terminated
 * (e.g. `57P01` or `connection closed`). Never wrap non-idempotent mutations
 * (`dispatchHook`, `executeRemedyByOffer`, `readPeerMessage`, `sendPeerMessage`)
 * in this helper.
 * @public — exported for unit tests
 */
export async function withNativeStorageRetry<T>(
  fn: () => Promise<T>,
  {
    maxRetries = 2,
    baseDelayMs = 25,
    maxDelayMs = 200,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const boundedRetries = Math.max(0, maxRetries);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        !isTransientNativeStorageDisconnect(error) ||
        attempt >= boundedRetries
      ) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
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
