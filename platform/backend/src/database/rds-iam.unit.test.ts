import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import pg from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — plain ESM module used by docker-entrypoint.sh and drizzle.config.ts
import * as mjsRdsIam from "../../scripts/rds-iam.mjs";
import * as tsRdsIam from "./rds-iam";

const TEST_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "AQoDYXdzEJr1234567890",
};

type RdsIamModule = typeof tsRdsIam;

const MODULES: Array<[string, RdsIamModule]> = [
  ["src/database/rds-iam.ts", tsRdsIam],
  ["scripts/rds-iam.mjs", mjsRdsIam as unknown as RdsIamModule],
];

describe.each(MODULES)("rds-iam (%s)", (_moduleName, rdsIam) => {
  const {
    buildPgConnectionConfig,
    configurePgDefaultsForRdsIam,
    createRdsIamPasswordCallback,
    createRefreshingCredentialProvider,
    generateRdsIamAuthToken,
    isRdsIamAuthEnabled,
    rdsRegionFromHostname,
    resolveDatabaseAwsRegion,
    resolvePgSslConfig,
  } = rdsIam;

  const originalPgDefaultPassword = pg.defaults.password;
  const originalPgDefaultSsl = pg.defaults.ssl;

  afterEach(async () => {
    pg.defaults.password = originalPgDefaultPassword;
    pg.defaults.ssl = originalPgDefaultSsl;
    await tsRdsIam.closeRdsIamNativeBridges();
  });

  test("rdsRegionFromHostname extracts regions from RDS, Aurora, Proxy, GovCloud, and China endpoints", () => {
    expect(
      rdsRegionFromHostname("mydb.123456789012.eu-west-1.rds.amazonaws.com"),
    ).toBe("eu-west-1");
    expect(
      rdsRegionFromHostname(
        "myaurora.cluster-123456789012.us-east-2.rds.amazonaws.com.",
      ),
    ).toBe("us-east-2");
    expect(
      rdsRegionFromHostname(
        "myproxy.proxy-123456789012.ap-southeast-1.rds.amazonaws.com",
      ),
    ).toBe("ap-southeast-1");
    expect(
      rdsRegionFromHostname(
        "govdb.123456789012.us-gov-west-1.rds.amazonaws.com",
      ),
    ).toBe("us-gov-west-1");
    expect(
      rdsRegionFromHostname(
        "cndb.123456789012.cn-north-1.rds.amazonaws.com.cn",
      ),
    ).toBe("cn-north-1");
    expect(rdsRegionFromHostname("postgres.internal.example.com")).toBeNull();
    expect(rdsRegionFromHostname("localhost")).toBeNull();
    expect(rdsRegionFromHostname("")).toBeNull();
  });

  test("resolveDatabaseAwsRegion follows precedence and throws when no region can be resolved", () => {
    expect(
      resolveDatabaseAwsRegion({
        hostname: "mydb.123456789012.eu-west-1.rds.amazonaws.com",
        awsRegion: "ap-northeast-1",
        env: {
          ARCHESTRA_DATABASE_AWS_REGION: "us-west-2",
          AWS_REGION: "us-east-1",
        },
      }),
    ).toBe("ap-northeast-1");

    expect(
      resolveDatabaseAwsRegion({
        hostname: "mydb.123456789012.eu-west-1.rds.amazonaws.com",
        env: {
          ARCHESTRA_DATABASE_AWS_REGION: "us-west-2",
          AWS_REGION: "us-east-1",
        },
      }),
    ).toBe("us-west-2");

    expect(
      resolveDatabaseAwsRegion({
        hostname: "mydb.123456789012.eu-west-1.rds.amazonaws.com",
        env: {
          AWS_REGION: "us-east-1",
        },
      }),
    ).toBe("eu-west-1");

    expect(
      resolveDatabaseAwsRegion({
        hostname: "pg.internal.example.com",
        env: {
          AWS_DEFAULT_REGION: "eu-central-1",
        },
      }),
    ).toBe("eu-central-1");

    expect(() =>
      resolveDatabaseAwsRegion({
        hostname: "pg.internal.example.com",
        env: {},
      }),
    ).toThrow(/Cannot determine AWS region/);
  });

  test("isRdsIamAuthEnabled checks ARCHESTRA_DATABASE_IAM_AUTH_ENABLED", () => {
    expect(isRdsIamAuthEnabled({})).toBe(false);
    expect(
      isRdsIamAuthEnabled({ ARCHESTRA_DATABASE_IAM_AUTH_ENABLED: "false" }),
    ).toBe(false);
    expect(
      isRdsIamAuthEnabled({ ARCHESTRA_DATABASE_IAM_AUTH_ENABLED: "true" }),
    ).toBe(true);
  });

  test("generateRdsIamAuthToken produces a 15-minute presigned rds-db connect token without scheme", async () => {
    const token = await generateRdsIamAuthToken({
      hostname: "mydb.123456789012.eu-west-1.rds.amazonaws.com",
      port: 5432,
      username: "archestra_iam",
      region: "eu-west-1",
      credentials: TEST_CREDENTIALS,
    });

    expect(token.startsWith("https://")).toBe(false);
    expect(
      token.startsWith("mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/?"),
    ).toBe(true);

    const parsed = new URL(`https://${token}`);
    expect(parsed.searchParams.get("Action")).toBe("connect");
    expect(parsed.searchParams.get("DBUser")).toBe("archestra_iam");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Security-Token")).toBe(
      TEST_CREDENTIALS.sessionToken,
    );
    expect(parsed.searchParams.get("X-Amz-Credential")).toContain(
      "/eu-west-1/rds-db/aws4_request",
    );
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("buildPgConnectionConfig leaves non-IAM config untouched", () => {
    const url = "postgresql://archestra:secret@localhost:5432/archestra_dev";
    const result = buildPgConnectionConfig(
      url,
      { max: 25, idleTimeoutMillis: 30_000 },
      { iamAuthEnabled: false },
    );

    expect(result).toEqual({
      connectionString: url,
      max: 25,
      idleTimeoutMillis: 30_000,
    });
  });

  test("buildPgConnectionConfig generates a fresh RDS IAM token per new pg.Pool and pg.Client connection", async () => {
    let callCount = 0;
    const credentialsProvider = vi.fn(async () => {
      callCount += 1;
      return {
        accessKeyId: `AKIAEXAMPLE${callCount}`,
        secretAccessKey: `secretKeyExample${callCount}`,
        sessionToken: `session-token-${callCount}`,
      };
    });

    const url =
      "postgresql://archestra_iam:stale_static_password@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full&application_name=archestra-web";

    const poolConfig = buildPgConnectionConfig(
      url,
      { max: 10, connectionTimeoutMillis: 10_000 },
      {
        iamAuthEnabled: true,
        credentials: credentialsProvider,
        env: {},
      },
    );

    expect(poolConfig.connectionString).toBeUndefined();
    expect(poolConfig.host).toBe(
      "mydb.123456789012.eu-west-1.rds.amazonaws.com",
    );
    expect(poolConfig.port).toBe(5432);
    expect(poolConfig.user).toBe("archestra_iam");
    expect(poolConfig.database).toBe("archestra");
    expect(poolConfig.application_name).toBe("archestra-web");
    expect(typeof poolConfig.password).toBe("function");

    const pool = new pg.Pool(poolConfig);
    try {
      const poolOptions = (pool as unknown as { options: pg.ClientConfig })
        .options;
      const client1 = new pg.Client(poolOptions) as unknown as {
        password: () => Promise<string>;
      };
      const client2 = new pg.Client(poolOptions) as unknown as {
        password: () => Promise<string>;
      };

      expect(typeof client1.password).toBe("function");
      expect(typeof client2.password).toBe("function");

      const token1 = await client1.password();
      const token2 = await client2.password();

      expect(credentialsProvider).toHaveBeenCalledTimes(2);
      expect(token1).toContain("session-token-1");
      expect(token2).toContain("session-token-2");
      expect(token1).not.toBe(token2);
    } finally {
      await pool.end();
    }

    const notifyClientConfig = buildPgConnectionConfig(
      url,
      { connectionTimeoutMillis: 1_000, keepAlive: true },
      {
        iamAuthEnabled: true,
        credentials: credentialsProvider,
        env: {},
      },
    );
    const notifyClient = new pg.Client(notifyClientConfig) as unknown as {
      password: () => Promise<string>;
    };
    const token3 = await notifyClient.password();
    expect(credentialsProvider).toHaveBeenCalledTimes(3);
    expect(token3).toContain("session-token-3");
  });

  test("resolvePgSslConfig keeps TLS certificate and hostname verification with the RDS CA bundle", () => {
    const rdsUrl =
      "postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?uselibpqcompat=true&sslmode=require";

    const ssl = resolvePgSslConfig(rdsUrl, {
      iamAuthEnabled: true,
      env: {},
    });

    expect(ssl).toBeDefined();
    expect(typeof ssl).toBe("object");
    if (ssl && typeof ssl === "object") {
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.checkServerIdentity).toBeUndefined();
      expect(Array.isArray(ssl.ca)).toBe(true);
      const caList = ssl.ca as string[];
      expect(caList.some((cert) => cert.includes("BEGIN CERTIFICATE"))).toBe(
        true,
      );
      expect(JSON.stringify(ssl)).toBe('{"rejectUnauthorized":true}');
    }
  });

  test("resolvePgSslConfig loads custom sslrootcert and rejects sslmode=disable and sslmode=no-verify", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-ca-test-"));
    const caFile = path.join(tempDir, "custom-rds-ca.pem");
    const customPem =
      "-----BEGIN CERTIFICATE-----\nMIIB...custom-rds-ca\n-----END CERTIFICATE-----\n";
    fs.writeFileSync(caFile, customPem, "utf8");

    try {
      const urlWithRootCert = `postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full&sslrootcert=${encodeURIComponent(caFile)}`;
      const ssl = resolvePgSslConfig(urlWithRootCert, {
        iamAuthEnabled: true,
        env: {},
      });

      expect(ssl).toEqual({
        rejectUnauthorized: true,
        ca: customPem,
      });

      expect(() =>
        resolvePgSslConfig(
          "postgresql://archestra_iam@localhost:5432/archestra?sslmode=disable",
          { iamAuthEnabled: true, env: {} },
        ),
      ).toThrow(
        /TLS must stay enabled when RDS IAM database authentication is enabled/,
      );

      expect(() =>
        resolvePgSslConfig(
          "postgresql://archestra_iam@localhost:5432/archestra?ssl=false",
          { iamAuthEnabled: true, env: {} },
        ),
      ).toThrow(
        /TLS must stay enabled when RDS IAM database authentication is enabled/,
      );

      expect(() =>
        resolvePgSslConfig(
          "postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=no-verify",
          { iamAuthEnabled: true, env: {} },
        ),
      ).toThrow(
        /TLS must stay enabled when RDS IAM database authentication is enabled/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("configurePgDefaultsForRdsIam configures pg.defaults for drizzle-kit Pool connections", async () => {
    let seq = 0;
    const env: NodeJS.ProcessEnv = {
      ARCHESTRA_DATABASE_IAM_AUTH_ENABLED: "true",
      PGPASSWORD: "old-env-password",
      PGSSLMODE: "prefer",
    };

    const rawUrl =
      "postgresql://archestra_iam:expired_url_token@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full";

    const sanitizedUrl = configurePgDefaultsForRdsIam(rawUrl, {
      env,
      credentials: async () => {
        seq += 1;
        return {
          accessKeyId: `AKIA${seq}`,
          secretAccessKey: `SECRET${seq}`,
          sessionToken: `drizzle-session-${seq}`,
        };
      },
    });

    expect(sanitizedUrl).toBe(
      "postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra",
    );
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PGSSLMODE).toBeUndefined();

    const drizzlePool = new pg.Pool({
      connectionString: sanitizedUrl,
      max: 1,
    });
    try {
      const poolOptions = (
        drizzlePool as unknown as { options: pg.ClientConfig }
      ).options;
      const c1 = new pg.Client(poolOptions) as unknown as {
        password: () => Promise<string>;
        ssl: pg.ClientConfig["ssl"];
      };
      const c2 = new pg.Client(poolOptions) as unknown as {
        password: () => Promise<string>;
        ssl: pg.ClientConfig["ssl"];
      };

      expect(typeof c1.password).toBe("function");
      expect(await c1.password()).toContain("drizzle-session-1");
      expect(await c2.password()).toContain("drizzle-session-2");
      expect(c1.ssl).toMatchObject({ rejectUnauthorized: true });
    } finally {
      await drizzlePool.end();
    }
  });

  test("createRefreshingCredentialProvider caches within TTL and rebuilds on env/file rotation, TTL expiry, or provider failure", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-webid-test-"));
    const tokenFile = path.join(tempDir, "token.jwt");
    fs.writeFileSync(tokenFile, "jwt-v1", "utf8");
    const initialMtime = new Date(1_700_000_000_000);
    fs.utimesSync(tokenFile, initialMtime, initialMtime);

    let currentTime = 1_000;
    let factoryCount = 0;
    let shouldFail = false;
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIA_INITIAL",
      AWS_SECRET_ACCESS_KEY: "secret_initial",
      AWS_SESSION_TOKEN: "session_initial",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test-role",
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
    };

    const providerFactory = vi.fn(() => {
      factoryCount += 1;
      const instanceId = factoryCount;
      return async () => {
        if (shouldFail) {
          throw new Error("Simulated STS failure");
        }
        return {
          accessKeyId: `${env.AWS_ACCESS_KEY_ID}_${instanceId}`,
          secretAccessKey: `${env.AWS_SECRET_ACCESS_KEY}_${instanceId}`,
          sessionToken: `${env.AWS_SESSION_TOKEN}_${instanceId}`,
        };
      };
    });

    try {
      const refreshingProvider = createRefreshingCredentialProvider({
        env,
        providerFactory,
        now: () => currentTime,
        maxAgeMs: 60_000,
      });

      // 1. Initial call creates provider #1; second call within TTL reuses cached provider #1
      const creds1 = await refreshingProvider();
      currentTime += 10_000;
      const creds2 = await refreshingProvider();
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(creds1.accessKeyId).toBe("AKIA_INITIAL_1");
      expect(creds2.accessKeyId).toBe("AKIA_INITIAL_1");

      // 2. Projected AWS_WEB_IDENTITY_TOKEN_FILE mtime changes on disk -> rebuilds provider #2
      const rotatedMtime = new Date(1_700_000_060_000);
      fs.writeFileSync(tokenFile, "jwt-v2", "utf8");
      fs.utimesSync(tokenFile, rotatedMtime, rotatedMtime);
      const creds3 = await refreshingProvider();
      expect(providerFactory).toHaveBeenCalledTimes(2);
      expect(creds3.accessKeyId).toBe("AKIA_INITIAL_2");

      // 3. Env credential change -> rebuilds provider #3
      env.AWS_ACCESS_KEY_ID = "AKIA_ROTATED";
      const creds4 = await refreshingProvider();
      expect(providerFactory).toHaveBeenCalledTimes(3);
      expect(creds4.accessKeyId).toBe("AKIA_ROTATED_3");

      // 4. Advance clock past 60s TTL -> rebuilds provider #4
      currentTime += 60_001;
      const creds5 = await refreshingProvider();
      expect(providerFactory).toHaveBeenCalledTimes(4);
      expect(creds5.accessKeyId).toBe("AKIA_ROTATED_4");

      // 5. Provider error clears cachedProvider so the next call rebuilds provider #5
      shouldFail = true;
      await expect(refreshingProvider()).rejects.toThrow(
        "Simulated STS failure",
      );
      shouldFail = false;
      const creds6 = await refreshingProvider();
      expect(providerFactory).toHaveBeenCalledTimes(5);
      expect(creds6.accessKeyId).toBe("AKIA_ROTATED_5");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("createRdsIamPasswordCallback signs fresh tokens on each call and picks up rotated env credentials", async () => {
    const rotatingEnv: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIA_INITIAL_KEY",
      AWS_SECRET_ACCESS_KEY: "secret_initial",
      AWS_SESSION_TOKEN: "session_initial",
    };
    const callback = createRdsIamPasswordCallback({
      hostname: "mydb.123456789012.us-west-2.rds.amazonaws.com",
      port: 5432,
      username: "archestra_user",
      env: rotatingEnv,
      providerFactory: () => async () => ({
        accessKeyId: rotatingEnv.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: rotatingEnv.AWS_SECRET_ACCESS_KEY ?? "",
        sessionToken: rotatingEnv.AWS_SESSION_TOKEN,
      }),
    });

    const token1 = await callback();
    expect(token1).toContain(
      "mydb.123456789012.us-west-2.rds.amazonaws.com:5432/?",
    );
    expect(token1).toContain("DBUser=archestra_user");
    expect(token1).toContain("AKIA_INITIAL_KEY");
    expect(token1).toContain("session_initial");

    rotatingEnv.AWS_ACCESS_KEY_ID = "AKIA_ROTATED_KEY";
    rotatingEnv.AWS_SECRET_ACCESS_KEY = "secret_rotated";
    rotatingEnv.AWS_SESSION_TOKEN = "session_rotated";

    const token2 = await callback();
    expect(token2).toContain("AKIA_ROTATED_KEY");
    expect(token2).toContain("session_rotated");
  });
});

describe("rds-iam native bridge & retry helpers", () => {
  afterEach(async () => {
    await tsRdsIam.closeRdsIamNativeBridges();
  });

  test("resolveNativeDatabaseConnectionString injects fresh RDS IAM tokens over TLS per native connection and rejects invalid per-bridge secrets", async () => {
    const rawUrl = "postgresql://archestra_iam@127.0.0.1:5432/archestra";
    expect(
      await tsRdsIam.resolveNativeDatabaseConnectionString(rawUrl, {
        iamAuthEnabled: false,
        env: {},
      }),
    ).toBe(rawUrl);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-bridge-tls-"));
    const keyFile = path.join(tempDir, "server.key");
    const certFile = path.join(tempDir, "server.crt");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const serverKey = fs.readFileSync(keyFile, "utf8");
    const serverCert = fs.readFileSync(certFile, "utf8");

    const receivedPasswords: string[] = [];
    const mockPgServer = net.createServer((rawSocket) => {
      rawSocket.once("data", (sslReq) => {
        // Expect 8-byte PostgreSQL SSLRequest (80877103) and reply 'S' (0x53)
        if (sslReq.length === 8 && sslReq.readInt32BE(4) === 80877103) {
          rawSocket.write(Buffer.from([0x53]));
          const tlsSocket = new tls.TLSSocket(rawSocket, {
            isServer: true,
            key: serverKey,
            cert: serverCert,
          });
          let startupDone = false;
          tlsSocket.on("data", (data: Buffer) => {
            if (!startupDone) {
              startupDone = true;
              // Send AuthenticationCleartextPassword ('R', len=8, type=3)
              const authReq = Buffer.alloc(9);
              authReq[0] = 0x52;
              authReq.writeInt32BE(8, 1);
              authReq.writeInt32BE(3, 5);
              tlsSocket.write(authReq);
              return;
            }
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (buf[0] === 0x70) {
              const msgLen = buf.readInt32BE(1);
              const pwd = buf.subarray(5, 1 + msgLen - 1).toString("utf8");
              receivedPasswords.push(pwd);
              // Send AuthenticationOk ('R', len=8, type=0) + ReadyForQuery ('Z', len=5, 'I')
              const okAndReady = Buffer.from([
                0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x5a,
                0x00, 0x00, 0x00, 0x05, 0x49,
              ]);
              tlsSocket.write(okAndReady);
              tlsSocket.end();
            }
          });
          tlsSocket.on("error", () => rawSocket.destroy());
        } else {
          rawSocket.destroy();
        }
      });
    });

    await new Promise<void>((resolve) =>
      mockPgServer.listen(0, "127.0.0.1", resolve),
    );
    const serverAddr = mockPgServer.address();
    const upstreamPort =
      typeof serverAddr === "object" && serverAddr ? serverAddr.port : 0;

    try {
      let seq = 0;
      const credentialsSpy = vi.fn(async () => {
        seq += 1;
        return {
          accessKeyId: `AKIA_NATIVE_${seq}`,
          secretAccessKey: `SECRET_NATIVE_${seq}`,
          sessionToken: `native-token-${seq}`,
        };
      });

      const bridgeUrl = await tsRdsIam.resolveNativeDatabaseConnectionString(
        `postgresql://archestra_iam@127.0.0.1:${upstreamPort}/archestra?sslmode=verify-full&sslrootcert=${encodeURIComponent(certFile)}`,
        {
          iamAuthEnabled: true,
          awsRegion: "eu-central-1",
          credentials: credentialsSpy,
          env: {},
        },
      );

      const parsedBridgeUrl = new URL(bridgeUrl);
      expect(parsedBridgeUrl.hostname).toBe("127.0.0.1");
      expect(parsedBridgeUrl.password).toMatch(/^[0-9a-f]{64}$/);
      expect(parsedBridgeUrl.searchParams.get("sslmode")).toBe("disable");

      // Valid connections presenting the per-bridge secret receive fresh IAM tokens over upstream TLS
      for (let i = 0; i < 2; i++) {
        const client = new pg.Client({ connectionString: bridgeUrl });
        await client.connect();
        await client.end().catch(() => {});
      }

      expect(credentialsSpy).toHaveBeenCalledTimes(2);
      expect(receivedPasswords).toHaveLength(2);
      expect(receivedPasswords[0]).toContain("native-token-1");
      expect(receivedPasswords[1]).toContain("native-token-2");
      expect(receivedPasswords[0]).not.toBe(receivedPasswords[1]);

      // Unauthenticated local connection with wrong secret is rejected without calling credentialsSpy
      const badUrl = new URL(bridgeUrl);
      badUrl.password = "wrong-bridge-secret";
      const badClient = new pg.Client({
        connectionString: badUrl.toString(),
      });
      await expect(badClient.connect()).rejects.toThrow();
      await badClient.end().catch(() => {});

      expect(credentialsSpy).toHaveBeenCalledTimes(2);
      expect(receivedPasswords).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => mockPgServer.close(() => resolve()));
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("withNativeStorageRetry retries transient disconnect errors with bounded exponential backoff and does not retry non-transient errors", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await tsRdsIam.withNativeStorageRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(
            "db error: ERROR: terminating connection due to administrator command (SQLSTATE 57P01)",
          );
        }
        return "recovered";
      },
      {
        maxRetries: 2,
        baseDelayMs: 25,
        maxDelayMs: 200,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    expect(delays).toEqual([25, 50]);

    // Non-transient error fails immediately on attempt 1 without backoff
    let nonTransientAttempts = 0;
    await expect(
      tsRdsIam.withNativeStorageRetry(
        async () => {
          nonTransientAttempts += 1;
          throw new Error("duplicate key value violates unique constraint");
        },
        {
          maxRetries: 2,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toThrow("duplicate key value violates unique constraint");
    expect(nonTransientAttempts).toBe(1);

    // Exhausting maxRetries rethrows the transient error
    let exhaustedAttempts = 0;
    await expect(
      tsRdsIam.withNativeStorageRetry(
        async () => {
          exhaustedAttempts += 1;
          throw new Error("connection closed");
        },
        {
          maxRetries: 2,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("connection closed");
    expect(exhaustedAttempts).toBe(3);
  });
});
