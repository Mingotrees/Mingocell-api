import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Express, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import multer, { MulterError } from "multer";
import type { PoolClient } from "pg";
import sharp from "sharp";
import { HttpError, requireAuth, type PublicUser } from "../auth/middleware.js";
import { withTransaction } from "../database/transaction.js";
import {
  MAX_IMAGE_BYTES,
  MAX_PAGE_PIXELS,
  MAX_TIFF_PAGES,
  MAX_TOTAL_PIXELS,
  UPLOAD_STORAGE_RESERVATION_BYTES,
  checkImageStorageCapacity,
  publishTemporaryFile,
  resolveStorageKey,
  type ImageStorageOptions,
} from "./storage.js";

const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const UPLOADS_PER_WINDOW = 20;
const MAX_CONCURRENT_UPLOADS = 2;
const PREVIEW_EDGE = 512;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ImageFormat = "jpeg" | "png" | "tiff";
type Page = { index: number; width: number; height: number; temporaryPreview: string; previewStorageKey: string };
type UploadResponse = {
  image: { id: string; format: ImageFormat; byteSize: number; pageCount: number; sha256: string; uploadedAt: string };
  submissions: Array<{
    id: string;
    pageIndex: number;
    width: number;
    height: number;
    status: "uploaded";
    imageUrl: string;
    previewUrl: string;
  }>;
};

export function mountImageRoutes(app: Express, options: ImageStorageOptions) {
  const upload = multer({
    dest: options.temporary,
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 },
  });
  const admission = uploadAdmission(options);

  app.post(
    "/api/v1/submissions",
    requireAuth,
    rateLimit({
      windowMs: UPLOAD_WINDOW_MS,
      limit: UPLOADS_PER_WINDOW,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: { code: "RATE_LIMITED", message: "Too many uploads. Try again later." } },
    }),
    admission,
    parseImage(upload),
    async (req, res) => {
      try {
        const file = req.file;
        if (!file) throw new HttpError(400, "IMAGE_REQUIRED", "Provide one image in the image field.");

        const user = res.locals.user as PublicUser;
        const idempotencyKey = req.get("Idempotency-Key") ?? "";
        if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
          await rm(file.path, { force: true });
          throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "Provide an Idempotency-Key containing 8 to 128 safe characters.");
        }

        try {
          if (file.size === 0) throw new HttpError(400, "INVALID_IMAGE", "The image is empty or corrupt.");
          const payloadSha256 = await hashFile(file.path);
          const existing = await findIdempotentResponse(options, user.id, idempotencyKey, payloadSha256);
          if (existing) return sendUploadResponse(res, existing, true);

          const token = randomBytes(16).toString("hex");
          const inspected = await inspectImage(file.path, token, options);
          const extension = inspected.format === "jpeg" ? "jpg" : inspected.format === "tiff" ? "tif" : "png";
          const originalStorageKey = storageKey("originals", token, `${token}.${extension}`);
          const publishedPaths: string[] = [];
          const candidate = createUploadResponse(
            inspected.format,
            file.size,
            payloadSha256,
            inspected.pages,
          );

          try {
            publishedPaths.push(await publishTemporaryFile(file.path, originalStorageKey, options));
            for (const page of inspected.pages) {
              publishedPaths.push(await publishTemporaryFile(page.temporaryPreview, page.previewStorageKey, options));
            }

            const result = await persistUpload(
              options,
              user.id,
              idempotencyKey,
              payloadSha256,
              originalStorageKey,
              candidate,
              inspected.pages,
            );
            if (result.replayed) await removeFiles(publishedPaths);
            return sendUploadResponse(res, result.response, result.replayed);
          } catch (error) {
            const committed = await findCommittedAfterFailure(
              options,
              user.id,
              idempotencyKey,
              payloadSha256,
              error,
            );
            if (committed) {
              if (committed.image.id !== candidate.image.id) await removeFiles(publishedPaths);
              return sendUploadResponse(res, committed, true);
            }
            if (error instanceof HttpError || await databaseAvailable(options)) await removeFiles(publishedPaths);
            throw error;
          } finally {
            await removeFiles(inspected.pages.map((page) => page.temporaryPreview));
          }
        } finally {
          await rm(file.path, { force: true });
        }
      } finally {
        releaseUpload(res);
      }
    },
  );

  app.get("/api/v1/submissions/:id", requireAuth, async (req, res) => {
    const submission = await getOwnedSubmission(options, routeId(req.params.id), (res.locals.user as PublicUser).id);
    res.json(submissionPayload(submission));
  });

  app.get("/api/v1/submissions/:id/image", requireAuth, async (req, res, next) => {
    const submission = await getOwnedSubmission(options, routeId(req.params.id), (res.locals.user as PublicUser).id);
    const extension = submission.format === "jpeg" ? "jpg" : submission.format === "tiff" ? "tif" : "png";
    await streamStoredFile(
      res,
      next,
      options,
      submission.original_storage_key,
      mediaType(submission.format),
      `attachment; filename="submission-${submission.id}.${extension}"`,
    );
  });

  app.get("/api/v1/submissions/:id/preview", requireAuth, async (req, res, next) => {
    const submission = await getOwnedSubmission(options, routeId(req.params.id), (res.locals.user as PublicUser).id);
    await streamStoredFile(res, next, options, submission.preview_storage_key, "image/jpeg", "inline");
  });
}

function parseImage(upload: ReturnType<typeof multer>): RequestHandler {
  return (req, res, next) => {
    const contentType = req.get("Content-Type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(contentType)
      || !/boundary=(?:"[^"]+"|[^;"\s]+)/i.test(contentType)) {
      releaseUpload(res);
      return next(new HttpError(400, "INVALID_MULTIPART", "Provide multipart form data with one image field."));
    }
    upload.single("image")(req, res, (error) => {
      if (!error) return next();
      releaseUpload(res);
      if (error instanceof MulterError && error.code === "LIMIT_FILE_SIZE") {
        return next(new HttpError(413, "IMAGE_TOO_LARGE", `Images cannot exceed ${MAX_IMAGE_BYTES} bytes.`));
      }
      if (error instanceof MulterError) {
        return next(new HttpError(400, "INVALID_MULTIPART", "Provide exactly one image field and no additional fields."));
      }
      if (error instanceof Error
        && (/^Multipart:/i.test(error.message)
          || /Unexpected end of form/i.test(error.message)
          || /Malformed part header/i.test(error.message))) {
        return next(new HttpError(400, "INVALID_MULTIPART", "Provide valid multipart form data."));
      }
      next(error);
    });
  };
}

async function inspectImage(path: string, token: string, options: ImageStorageOptions) {
  let first;
  try {
    first = await sharp(path, { failOn: "warning" }).metadata();
  } catch {
    throw new HttpError(400, "INVALID_IMAGE", "The image is empty, corrupt, or cannot be decoded.");
  }

  if (!isImageFormat(first.format)) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE_FORMAT", "Use PNG, JPEG, or TIFF.");
  }
  const pageCount = first.pages ?? 1;
  if (first.format !== "tiff" && pageCount !== 1) {
    throw new HttpError(415, "UNSUPPORTED_IMAGE_FORMAT", "Multi-page input must use TIFF.");
  }
  if (pageCount > MAX_TIFF_PAGES) {
    throw new HttpError(413, "TOO_MANY_PAGES", `TIFF images cannot exceed ${MAX_TIFF_PAGES} pages.`);
  }

  const dimensions: Array<{ index: number; width: number; height: number }> = [];
  let totalPixels = 0;
  for (let index = 0; index < pageCount; index++) {
    let metadata;
    try {
      metadata = await sharp(path, {
        page: index,
        pages: 1,
        failOn: "warning",
      }).metadata();
    } catch (error) {
      if (error instanceof Error && /pixel limit/i.test(error.message)) {
        throw new HttpError(413, "IMAGE_TOO_MANY_PIXELS", `Each page cannot exceed ${MAX_PAGE_PIXELS} pixels.`);
      }
      throw new HttpError(400, "INVALID_IMAGE", "The image contains corrupt page metadata.");
    }
    const oriented = metadata.autoOrient;
    const width = oriented?.width ?? metadata.width;
    const height = oriented?.height ?? metadata.height;
    if (!width || !height) throw new HttpError(400, "INVALID_IMAGE", "The image dimensions are invalid.");
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > MAX_PAGE_PIXELS) {
      throw new HttpError(413, "IMAGE_TOO_MANY_PIXELS", `Each page cannot exceed ${MAX_PAGE_PIXELS} pixels.`);
    }
    totalPixels += pixels;
    if (totalPixels > MAX_TOTAL_PIXELS) {
      throw new HttpError(413, "IMAGE_TOO_MANY_PIXELS", `All pages combined cannot exceed ${MAX_TOTAL_PIXELS} pixels.`);
    }
    dimensions.push({ index, width, height });
  }

  const pages: Page[] = [];
  try {
    for (const dimensionsForPage of dimensions) {
      let preview;
      try {
        preview = await sharp(path, {
          page: dimensionsForPage.index,
          pages: 1,
          failOn: "warning",
          limitInputPixels: MAX_PAGE_PIXELS,
        })
          .autoOrient()
          .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch {
        throw new HttpError(400, "INVALID_IMAGE", "The image contains corrupt pixel data.");
      }
      const temporaryPreview = join(options.temporary, randomBytes(16).toString("hex"));
      await writeFile(temporaryPreview, preview, { flag: "wx", mode: 0o600 });
      const pageNumber = String(dimensionsForPage.index).padStart(2, "0");
      pages.push({
        ...dimensionsForPage,
        temporaryPreview,
        previewStorageKey: storageKey("previews", token, `${token}-p${pageNumber}.jpg`),
      });
    }
  } catch (error) {
    await removeFiles(pages.map((page) => page.temporaryPreview));
    throw error;
  }

  return { format: first.format, pages };
}

function createUploadResponse(
  format: ImageFormat,
  byteSize: number,
  sha256: string,
  pages: Page[],
): UploadResponse {
  const imageId = randomUUID();
  const uploadedAt = new Date().toISOString();
  return {
    image: { id: imageId, format, byteSize, pageCount: pages.length, sha256, uploadedAt },
    submissions: pages.map((page) => {
      const id = randomUUID();
      return {
        id,
        pageIndex: page.index,
        width: page.width,
        height: page.height,
        status: "uploaded",
        imageUrl: `/api/v1/submissions/${id}/image`,
        previewUrl: `/api/v1/submissions/${id}/preview`,
      };
    }),
  };
}

async function persistUpload(
  options: ImageStorageOptions,
  ownerId: string,
  key: string,
  payloadSha256: string,
  originalStorageKey: string,
  response: UploadResponse,
  pages: Page[],
) {
  return withTransaction(options.pool, async (client) => {
    const reserved = await client.query(
      `INSERT INTO mingocell_data.upload_idempotency (owner_id, key, payload_sha256)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key`,
      [ownerId, key, payloadSha256],
    );
    if (!reserved.rowCount) {
      const existing = await readIdempotency(client, ownerId, key);
      if (!existing || existing.payload_sha256 !== payloadSha256) {
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "That Idempotency-Key was already used for another image.");
      }
      if (!existing.response) throw new Error("Incomplete idempotency record.");
      return { response: existing.response, replayed: true };
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mingocell:image-owner:${ownerId}`]);
    const usage = await client.query<{ bytes: string }>(
      "SELECT COALESCE(sum(byte_size), 0)::text AS bytes FROM mingocell_data.images WHERE owner_id = $1",
      [ownerId],
    );
    if (BigInt(usage.rows[0].bytes) + BigInt(response.image.byteSize) > BigInt(options.ownerQuotaBytes)) {
      throw new HttpError(507, "STORAGE_QUOTA_EXCEEDED", "Your image storage quota is full.");
    }

    await client.query(
      `INSERT INTO mingocell_data.images
       (id, owner_id, original_storage_key, sha256, byte_size, format, page_count, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        response.image.id,
        ownerId,
        originalStorageKey,
        response.image.sha256,
        response.image.byteSize,
        response.image.format,
        response.image.pageCount,
        response.image.uploadedAt,
      ],
    );
    for (const submission of response.submissions) {
      const page = pages[submission.pageIndex];
      await client.query(
        `INSERT INTO mingocell_data.submissions
         (id, image_id, page_index, width, height, preview_storage_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          submission.id,
          response.image.id,
          submission.pageIndex,
          submission.width,
          submission.height,
          page.previewStorageKey,
          response.image.uploadedAt,
        ],
      );
    }
    await client.query(
      `UPDATE mingocell_data.upload_idempotency SET response = $3::jsonb
       WHERE owner_id = $1 AND key = $2`,
      [ownerId, key, JSON.stringify(response)],
    );
    return { response, replayed: false };
  });
}

type IdempotencyRow = { payload_sha256: string; response: UploadResponse | null };

async function readIdempotency(client: PoolClient, ownerId: string, key: string) {
  const result = await client.query<IdempotencyRow>(
    "SELECT payload_sha256, response FROM mingocell_data.upload_idempotency WHERE owner_id = $1 AND key = $2",
    [ownerId, key],
  );
  return result.rows[0];
}

async function findIdempotentResponse(
  options: ImageStorageOptions,
  ownerId: string,
  key: string,
  payloadSha256: string,
) {
  const result = await options.pool.query<IdempotencyRow>(
    "SELECT payload_sha256, response FROM mingocell_data.upload_idempotency WHERE owner_id = $1 AND key = $2",
    [ownerId, key],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.payload_sha256 !== payloadSha256) {
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "That Idempotency-Key was already used for another image.");
  }
  if (!existing.response) throw new Error("Incomplete idempotency record.");
  return existing.response;
}

async function findCommittedAfterFailure(
  options: ImageStorageOptions,
  ownerId: string,
  key: string,
  payloadSha256: string,
  originalError: unknown,
) {
  if (originalError instanceof HttpError) return null;
  try {
    const result = await options.pool.query<IdempotencyRow>(
      "SELECT payload_sha256, response FROM mingocell_data.upload_idempotency WHERE owner_id = $1 AND key = $2",
      [ownerId, key],
    );
    const row = result.rows[0];
    return row?.payload_sha256 === payloadSha256 ? row.response : null;
  } catch {
    return null;
  }
}

async function databaseAvailable(options: ImageStorageOptions) {
  try {
    await options.pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

type OwnedSubmission = {
  id: string;
  page_index: number;
  width: number;
  height: number;
  status: "uploaded" | "analyzed" | "failed";
  created_at: Date;
  original_storage_key: string;
  preview_storage_key: string;
  format: ImageFormat;
  byte_size: string;
  sha256: string;
  page_count: number;
};

async function getOwnedSubmission(options: ImageStorageOptions, id: string, ownerId: string) {
  if (!UUID.test(id)) throw new HttpError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
  const result = await options.pool.query<OwnedSubmission>(`
    SELECT s.id, s.page_index, s.width, s.height, s.status, s.created_at,
      i.original_storage_key, s.preview_storage_key, i.format, i.byte_size, i.sha256, i.page_count
    FROM mingocell_data.submissions s
    JOIN mingocell_data.images i ON i.id = s.image_id
    WHERE s.id = $1 AND i.owner_id = $2
  `, [id, ownerId]);
  const submission = result.rows[0];
  if (!submission) throw new HttpError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
  return submission;
}

function submissionPayload(submission: OwnedSubmission) {
  return {
    id: submission.id,
    pageIndex: submission.page_index,
    width: submission.width,
    height: submission.height,
    status: submission.status,
    createdAt: submission.created_at.toISOString(),
    source: {
      format: submission.format,
      byteSize: Number(submission.byte_size),
      sha256: submission.sha256,
      pageCount: submission.page_count,
    },
    imageUrl: `/api/v1/submissions/${submission.id}/image`,
    previewUrl: `/api/v1/submissions/${submission.id}/preview`,
  };
}

async function streamStoredFile(
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
  options: ImageStorageOptions,
  key: string,
  contentType: string,
  disposition: string,
) {
  const path = resolveStorageKey(options, key);
  let handle;
  let details;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    details = await handle.stat();
    if (!details.isFile()) throw new Error("Stored path is not a file.");
  } catch {
    await handle?.close().catch(() => undefined);
    throw new HttpError(503, "STORAGE_UNAVAILABLE", "The stored image is temporarily unavailable.");
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", details.size);
  res.setHeader("Content-Disposition", disposition);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  const stream = handle.createReadStream();
  stream.on("error", next);
  stream.pipe(res);
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function storageKey(kind: "originals" | "previews", token: string, filename: string) {
  return `${kind}/${token.slice(0, 2)}/${token.slice(2, 4)}/${filename}`;
}

function isImageFormat(value: string | undefined): value is ImageFormat {
  return value === "jpeg" || value === "png" || value === "tiff";
}

function mediaType(format: ImageFormat) {
  return format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/tiff";
}

function routeId(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function uploadAdmission(options: ImageStorageOptions): RequestHandler {
  let active = 0;
  const owners = new Set<string>();
  return async (_req, res, next) => {
    const ownerId = (res.locals.user as PublicUser).id;
    if (active >= MAX_CONCURRENT_UPLOADS || owners.has(ownerId)) {
      return next(new HttpError(429, "UPLOAD_BUSY", "Another image upload is already being processed."));
    }
    active++;
    owners.add(ownerId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      owners.delete(ownerId);
    };
    res.locals.releaseImageUpload = release;
    res.once("finish", release);
    try {
      await checkImageStorageCapacity(options, active * UPLOAD_STORAGE_RESERVATION_BYTES);
      next();
    } catch {
      release();
      next(new HttpError(507, "STORAGE_CAPACITY_LOW", "Image storage has insufficient free space."));
    }
  };
}

function releaseUpload(res: Parameters<RequestHandler>[1]) {
  const release = res.locals.releaseImageUpload;
  if (typeof release === "function") release();
}

function sendUploadResponse(res: Parameters<RequestHandler>[1], response: UploadResponse, replayed: boolean) {
  if (replayed) res.setHeader("Idempotency-Replayed", "true");
  return res.status(201).json(response);
}

async function removeFiles(paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
}
