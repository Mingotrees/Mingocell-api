import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, link, lstat, mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Pool } from "pg";
import { logger as defaultLogger, type Logger } from "../logging.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PAGE_PIXELS = 4_000_000;
export const MAX_TOTAL_PIXELS = 20_000_000;
export const MAX_TIFF_PAGES = 20;
export const DEFAULT_OWNER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_STORAGE_RESERVATION_BYTES = 32 * 1024 * 1024;

const PRODUCTION_STORAGE_ROOT = "/data/users/s22101440/mingocell-storage";
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export type ImageStorageOptions = {
  pool: Pool;
  root: string;
  originals: string;
  previews: string;
  temporary: string;
  ownerQuotaBytes: number;
  minFreeBytes: number;
};

export function imageStorageOptions(
  pool: Pool,
  environment: NodeJS.ProcessEnv = process.env,
): ImageStorageOptions {
  const configured = environment.IMAGE_STORAGE_ROOT
    || (environment.NODE_ENV === "production" ? PRODUCTION_STORAGE_ROOT : "storage");
  if (environment.NODE_ENV === "production" && !isAbsolute(configured)) {
    throw new Error("IMAGE_STORAGE_ROOT must be an absolute path in production.");
  }

  const root = resolve(configured);
  return {
    pool,
    root,
    originals: join(root, "originals"),
    previews: join(root, "previews"),
    temporary: join(root, "tmp"),
    ownerQuotaBytes: readPositiveInteger(
      "IMAGE_OWNER_QUOTA_BYTES",
      environment.IMAGE_OWNER_QUOTA_BYTES,
      DEFAULT_OWNER_QUOTA_BYTES,
    ),
    minFreeBytes: readPositiveInteger(
      "IMAGE_MIN_FREE_BYTES",
      environment.IMAGE_MIN_FREE_BYTES,
      DEFAULT_MIN_FREE_BYTES,
    ),
  };
}

export async function initializeImageStorage(options: ImageStorageOptions) {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(options.originals, { recursive: true, mode: 0o700 }),
    mkdir(options.previews, { recursive: true, mode: 0o700 }),
    mkdir(options.temporary, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    secureDirectory(options.root),
    secureDirectory(options.originals),
    secureDirectory(options.previews),
    secureDirectory(options.temporary),
  ]);
  await checkImageStorageStructure(options);
  await probeImageStorage(options);
}

export async function checkImageStorage(options: ImageStorageOptions) {
  await checkImageStorageStructure(options);
  await checkImageStorageCapacity(options);
  await probeImageStorage(options);
}

async function checkImageStorageStructure(options: ImageStorageOptions) {
  for (const directory of [options.root, options.originals, options.previews, options.temporary]) {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Image storage path must be a directory.");
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  }
}

export async function checkImageStorageCapacity(
  options: ImageStorageOptions,
  requiredBytes = UPLOAD_STORAGE_RESERVATION_BYTES,
) {
  const filesystem = await statfs(options.root);
  const freeBytes = BigInt(filesystem.bavail) * BigInt(filesystem.bsize);
  if (freeBytes < BigInt(options.minFreeBytes + requiredBytes)) {
    throw new Error("Image storage free-space reserve reached.");
  }
}

export function resolveStorageKey(options: ImageStorageOptions, key: string) {
  const path = resolve(options.root, key);
  const fromRoot = relative(options.root, path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Invalid storage key.");
  }
  return path;
}

export async function publishTemporaryFile(
  temporaryPath: string,
  storageKey: string,
  options: ImageStorageOptions,
) {
  const destination = resolveStorageKey(options, storageKey);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await chmod(temporaryPath, 0o600);
  await link(temporaryPath, destination);
  await rm(temporaryPath, { force: true });
  return destination;
}

export async function reconcileImageStorage(
  options: ImageStorageOptions,
  log: Logger = defaultLogger,
  now = Date.now(),
) {
  const references = await options.pool.query<{ storage_key: string }>(`
    SELECT original_storage_key AS storage_key FROM mingocell_data.images
    UNION ALL
    SELECT preview_storage_key AS storage_key FROM mingocell_data.submissions
  `);
  const referenced = new Set(references.rows.map((row) => row.storage_key));
  const cutoff = now - ORPHAN_GRACE_MS;
  let staleTemporaryCount = 0;
  let orphanCount = 0;
  let missingCount = 0;

  for (const path of await listFiles(options.temporary)) {
    if ((await stat(path)).mtimeMs < cutoff) {
      await rm(path, { force: true });
      staleTemporaryCount++;
    }
  }

  for (const directory of [options.originals, options.previews]) {
    for (const path of await listFiles(directory)) {
      const key = relative(options.root, path);
      if (!referenced.has(key) && (await stat(path)).mtimeMs < cutoff) {
        await rm(path, { force: true });
        orphanCount++;
      }
    }
  }

  for (const key of referenced) {
    try {
      await access(resolveStorageKey(options, key), constants.R_OK);
    } catch {
      missingCount++;
    }
  }

  log(missingCount ? "error" : "info", "storage.reconciled", {
    staleTemporaryCount,
    orphanCount,
    missingCount,
  });
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function readPositiveInteger(name: string, configured: string | undefined, fallback: number) {
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

async function secureDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isDirectory()) throw new Error("Image storage path must be a directory.");
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function probeImageStorage(options: ImageStorageOptions) {
  const path = join(options.temporary, `.write-probe-${randomBytes(8).toString("hex")}`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
  }
}
