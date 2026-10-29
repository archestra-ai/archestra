import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

export async function createPrivateRemedyWitness({
  directory,
  maxEntries = 1200,
  maxBytes = 512 * 1024 * 1024,
  maxBodyBytes = 4 * 1024 * 1024,
}) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    [maxEntries, maxBytes, maxBodyBytes].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  )
    throw witnessError("private_witness_options_invalid");
  let handle;
  try {
    await noSymlinkAncestors(dirname(directory));
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const initial = await lstat(directory, { bigint: true });
    if (
      !initial.isDirectory() ||
      initial.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        initial.uid !== BigInt(process.getuid())) ||
      (await readdir(directory)).length !== 0
    )
      throw witnessError("private_witness_directory_invalid");
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const owned = await handle.stat({ bigint: true });
    if (owned.dev !== initial.dev || owned.ino !== initial.ino)
      throw witnessError("private_witness_directory_invalid");
    await handle.chmod(0o700);
    const owner = await open(
      join(directory, ".private-remedy-witness-owner"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await owner.writeFile("private-remedy-witness-v1\n");
    } finally {
      await owner.close();
    }
    let chain = Promise.resolve();
    let closed = false;
    let usedEntries = 0;
    let usedBytes = 0;
    let queuedEntries = 0;
    let queuedBytes = 0;
    let temporary = 0;
    const reserved = new Set();
    const rootUnchanged = async () => {
      await noSymlinkAncestors(dirname(directory));
      const current = await lstat(directory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== owned.dev ||
        current.ino !== owned.ino
      )
        throw witnessError("private_witness_directory_changed");
    };
    const append = (entry) => {
      if (closed) return Promise.reject(witnessError("private_witness_closed"));
      // Snapshot at the actual checkpoint, not later when queued disk work runs.
      // Otherwise a transport's subsequent body mutation could falsify evidence.
      try {
        if (
          !entry ||
          Object.keys(entry).some(
            (key) => !["kind", "ordinal", "body"].includes(key),
          )
        )
          throw witnessError("private_witness_entry_invalid");
        rejectAuthEnvelope(entry.body);
        if (
          entry.body &&
          typeof entry.body === "object" &&
          !Buffer.isBuffer(entry.body) &&
          !Array.isArray(entry.body) &&
          ![Object.prototype, null].includes(Object.getPrototypeOf(entry.body))
        )
          throw witnessError("private_witness_entry_invalid");
        const value = Buffer.isBuffer(entry.body)
          ? entry.body
          : typeof entry.body === "string"
            ? entry.body
            : JSON.stringify(entry.body);
        if (value === undefined)
          throw witnessError("private_witness_entry_invalid");
        const size = Buffer.isBuffer(value)
          ? value.length
          : Buffer.byteLength(value);
        if (size > maxBodyBytes) throw witnessError("private_witness_body_cap");
        if (
          usedEntries + queuedEntries >= maxEntries ||
          usedBytes + queuedBytes + size > maxBytes
        )
          throw witnessError("private_witness_disk_cap");
        entry = {
          kind: entry.kind,
          ordinal: entry.ordinal,
          body: Buffer.from(value),
        };
        queuedEntries++;
        queuedBytes += size;
      } catch (error) {
        return Promise.reject(
          witnessError(
            CODES.has(error?.code)
              ? error.code
              : "private_witness_entry_invalid",
          ),
        );
      }
      let pending = true;
      const release = () => {
        if (pending) {
          pending = false;
          queuedEntries--;
          queuedBytes -= entry.body.length;
        }
      };
      const work = chain.then(async () => {
        if (closed) throw witnessError("private_witness_closed");
        if (
          !entry ||
          Object.keys(entry).some(
            (key) => !["kind", "ordinal", "body"].includes(key),
          ) ||
          !KINDS.has(entry.kind) ||
          !Number.isSafeInteger(entry.ordinal) ||
          entry.ordinal < 1
        )
          throw witnessError("private_witness_entry_invalid");
        let bytes;
        try {
          rejectAuthEnvelope(entry.body);
          if (
            entry.body &&
            typeof entry.body === "object" &&
            !Buffer.isBuffer(entry.body) &&
            !Array.isArray(entry.body) &&
            ![Object.prototype, null].includes(
              Object.getPrototypeOf(entry.body),
            )
          )
            throw witnessError("private_witness_entry_invalid");
          if (
            (Buffer.isBuffer(entry.body) && entry.body.length > maxBodyBytes) ||
            (typeof entry.body === "string" &&
              Buffer.byteLength(entry.body) > maxBodyBytes)
          )
            throw witnessError("private_witness_body_cap");
          bytes = Buffer.isBuffer(entry.body)
            ? Buffer.from(entry.body)
            : typeof entry.body === "string"
              ? Buffer.from(entry.body)
              : Buffer.from(JSON.stringify(entry.body));
          if (bytes.length > maxBodyBytes)
            throw witnessError("private_witness_body_cap");
          // Also reject accidentally pre-serialized transport envelopes.
          {
            const text = bytes.toString("utf8");
            if (
              /^\s*HTTP\/\d|^\s*(?:authorization|cookie|set-cookie|x-api-key):/i.test(
                text,
              )
            )
              throw witnessError("private_witness_auth_envelope");
            try {
              rejectAuthEnvelope(JSON.parse(text));
            } catch (error) {
              if (error.code === "private_witness_auth_envelope") throw error;
            }
          }
        } catch (error) {
          throw witnessError(
            CODES.has(error?.code)
              ? error.code
              : "private_witness_entry_invalid",
          );
        }
        const ref = `${entry.kind}:${entry.ordinal}`;
        if (reserved.has(ref)) throw witnessError("private_witness_duplicate");
        if (usedEntries >= maxEntries || usedBytes + bytes.length > maxBytes)
          throw witnessError("private_witness_disk_cap");
        await rootUnchanged();
        const extension = ["provider_response", "proxy_response"].includes(
          entry.kind,
        )
          ? "sse"
          : "json";
        const name = `${String(entry.ordinal).padStart(6, "0")}-${entry.kind}.${extension}`;
        const final = join(directory, name);
        const temp = join(directory, `.partial-${++temporary}`);
        let file;
        let created = false;
        let published = false;
        let written;
        try {
          file = await open(
            temp,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          created = true;
          written = await file.stat({ bigint: true });
          await file.writeFile(bytes);
          await file.sync();
          await file.close();
          file = null;
          await rootUnchanged();
          // link() publishes a complete inode atomically and NEVER replaces an
          // existing file or symlink, unlike rename(). Names contain no user data.
          await link(temp, final);
          published = true;
          await rootUnchanged();
          const actual = await lstat(final, { bigint: true });
          if (
            !actual.isFile() ||
            actual.isSymbolicLink() ||
            actual.dev !== written.dev ||
            actual.ino !== written.ino
          )
            throw witnessError("private_witness_write_failed");
          release();
          reserved.add(ref);
          usedEntries++;
          usedBytes += bytes.length;
          return {
            kind: entry.kind,
            ordinal: entry.ordinal,
            ref,
            hash: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          };
        } catch (error) {
          if (published) throw witnessError("private_witness_write_failed");
          throw witnessError(
            error.code === "EEXIST"
              ? "private_witness_duplicate"
              : CODES.has(error.code)
                ? error.code
                : "private_witness_write_failed",
          );
        } finally {
          await file?.close().catch(() => {});
          if (created) await unlink(temp).catch(() => {});
        }
      });
      const safe = work
        .catch((error) => {
          throw witnessError(
            CODES.has(error?.code)
              ? error.code
              : "private_witness_write_failed",
          );
        })
        .finally(release);
      chain = safe.catch(() => {});
      return safe;
    };
    return {
      append,
      flush: async () => {
        await chain;
      },
      close: async () => {
        await chain;
        if (!closed) {
          closed = true;
          try {
            await handle.close();
          } catch {
            throw witnessError("private_witness_write_failed");
          }
        }
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw witnessError(
      CODES.has(error?.code) ? error.code : "private_witness_directory_invalid",
    );
  }
}

async function noSymlinkAncestors(path) {
  let current = parse(path).root;
  for (const segment of relative(current, path)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw witnessError("private_witness_directory_invalid");
  }
}
function rejectAuthEnvelope(body) {
  if (!body || typeof body !== "object" || Buffer.isBuffer(body)) return;
  if (Array.isArray(body)) {
    for (const value of body) rejectAuthEnvelope(value);
    return;
  }
  if (
    "headers" in body ||
    Object.keys(body).some((key) => AUTH_FIELDS.has(key.toLowerCase())) ||
    [body.request, body.response].some(
      (value) =>
        value &&
        typeof value === "object" &&
        Object.keys(value).some((key) => AUTH_FIELDS.has(key.toLowerCase())),
    )
  )
    throw witnessError("private_witness_auth_envelope");
}
function witnessError(code) {
  return Object.assign(new Error(code), { code });
}
const KINDS = new Set([
  "provider_request",
  "provider_response",
  "client_request",
  "proxy_response",
  "gateway_request",
  "gateway_response",
]);
const AUTH_FIELDS = new Set([
  "headers",
  "authorization",
  "auth",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "client_secret",
  "id_token",
  "bearer_token",
  "oauth",
  "cookie",
  "cookies",
  "set-cookie",
  "x-api-key",
]);
const CODES = new Set([
  "private_witness_options_invalid",
  "private_witness_directory_invalid",
  "private_witness_directory_changed",
  "private_witness_closed",
  "private_witness_entry_invalid",
  "private_witness_auth_envelope",
  "private_witness_body_cap",
  "private_witness_duplicate",
  "private_witness_disk_cap",
  "private_witness_write_failed",
]);
