import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError, type PublicUser } from '../auth/middleware.js';
import type { AnalysisResult } from '../analysis/types.js';
import { withTransaction } from '../database/transaction.js';
import { uuid, type ExpertReview, type ReviewInput } from './model.js';

type ReviewRow = {
  id: string; analysis_id: string; submission_id: string; revision: number;
  disposition: ExpertReview['disposition']; stage: ExpertReview['stage']; notes: string;
  reviewer_id: string; reviewer_email: string; reviewer_role: PublicUser['role']; created_at: Date; payload_sha256: string;
};
function view(row: ReviewRow): ExpertReview {
  return { id: row.id, analysisId: row.analysis_id, submissionId: row.submission_id, revision: row.revision, disposition: row.disposition, stage: row.stage, notes: row.notes, createdAt: row.created_at.toISOString(), reviewer: { id: row.reviewer_id, email: row.reviewer_email, role: row.reviewer_role } };
}
async function owned(client: Pool | PoolClient, submissionId: string, ownerId: string) {
  if (!uuid.test(submissionId)) throw new HttpError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
  const row = await client.query('SELECT s.id FROM mingocell_data.submissions s JOIN mingocell_data.images i ON i.id=s.image_id WHERE s.id=$1 AND i.owner_id=$2', [submissionId, ownerId]);
  if (!row.rowCount) throw new HttpError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
}
export async function getReviews(pool: Pool, submissionId: string, ownerId: string, { limit, before }: { limit: number; before: number | null }) {
  await owned(pool, submissionId, ownerId);
  const result = await pool.query<ReviewRow>('SELECT * FROM mingocell_data.expert_reviews WHERE submission_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT $3', [submissionId, before, limit + 1]);
  const rows = result.rows.slice(0, limit), hasMore = result.rows.length > limit;
  return { submissionId, reviews: rows.map(view), pageInfo: { hasMore, nextBefore: hasMore ? rows.at(-1)!.revision : null } };
}

export async function submitReview(pool: Pool, submissionId: string, reviewer: PublicUser, input: ReviewInput, key: string) {
  if (!uuid.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Provide a UUID Idempotency-Key for this decision.');
  const requestKey = key.toLowerCase();
  return withTransaction(pool, async client => {
    await owned(client, submissionId, reviewer.id);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mingocell:review:${reviewer.id}:${requestKey}`]);
    const digest = createHash('sha256').update(JSON.stringify({ submissionId, ...input })).digest('hex');
    const saved = await client.query<ReviewRow>('SELECT * FROM mingocell_data.expert_reviews WHERE reviewer_id=$1 AND request_key=$2', [reviewer.id, requestKey]);
    if (saved.rows[0]) {
      if (saved.rows[0].payload_sha256 !== digest) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This review key belongs to a different decision.');
      return { review: view(saved.rows[0]), replayed: true };
    }
    // Serialize review revisions for this analysis without ever editing its original output.
    const job = (await client.query<{ id: string; state: string; result: AnalysisResult | null }>('SELECT id,state,result FROM mingocell_data.classification_jobs WHERE submission_id=$1 FOR UPDATE', [submissionId])).rows[0];
    if (!job || job.state !== 'succeeded' || !job.result?.prediction.abstained) throw new HttpError(409, 'REVIEW_NOT_AVAILABLE', 'Expert decisions require a completed, referred analysis.');
    if (input.disposition === 'Reclassified' && input.stage === job.result.prediction.predicted_class) throw new HttpError(400, 'INVALID_INPUT', 'Choose Confirmed to retain the original maturation stage.');
    const latest = (await client.query<ReviewRow>('SELECT * FROM mingocell_data.expert_reviews WHERE submission_id=$1 ORDER BY revision DESC LIMIT 1', [submissionId])).rows[0];
    if ((latest?.id ?? null) !== input.previousReviewId) throw new HttpError(409, 'REVIEW_CONFLICT', 'A newer expert decision exists. Refresh reviews before submitting again.');
    const stage = input.disposition === 'Confirmed' ? job.result.prediction.predicted_class : input.stage;
    const result = await client.query<ReviewRow>(`INSERT INTO mingocell_data.expert_reviews
      (id,analysis_id,submission_id,revision,disposition,stage,notes,reviewer_id,reviewer_email,reviewer_role,request_key,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [randomUUID(), job.id, submissionId, (latest?.revision ?? 0) + 1, input.disposition, stage, input.notes, reviewer.id, reviewer.email, reviewer.role, requestKey, digest]);
    return { review: view(result.rows[0]), replayed: false };
  });
}
