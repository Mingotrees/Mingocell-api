import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../auth/middleware.js';
import { withTransaction } from '../database/transaction.js';
import type { AnalysisResponse, AnalysisState, AnalysisView, AnalysisResult } from './types.js';

type JobRow = {
  id: string; submission_id: string; state: AnalysisState; attempts: number; retryable: boolean;
  error_code: string | null; result: AnalysisResult | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function view(row: JobRow): AnalysisView {
  return {id: row.id, submissionId: row.submission_id, state: row.state, attempts: row.attempts,
    createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null, statusUrl: `/api/v1/submissions/${row.submission_id}/analysis`,
    retryable: row.state === 'failed' && row.retryable && row.attempts < 3,
    error: row.error_code ? {code: row.error_code, message: 'Analysis could not be completed.'} : null, result: row.result};
}
async function owned(client: Pool | PoolClient, id: string, owner: string) {
  if (!UUID.test(id)) throw new HttpError(404,'SUBMISSION_NOT_FOUND','Submission not found.');
  const result = await client.query(`SELECT s.id FROM mingocell_data.submissions s
    JOIN mingocell_data.images i ON i.id=s.image_id WHERE s.id=$1 AND i.owner_id=$2`, [id,owner]);
  if (!result.rowCount) throw new HttpError(404,'SUBMISSION_NOT_FOUND','Submission not found.');
}
export async function getAnalysis(pool: Pool, submissionId: string, ownerId: string): Promise<AnalysisResponse> {
  await owned(pool,submissionId,ownerId);
  const result = await pool.query<JobRow>('SELECT * FROM mingocell_data.classification_jobs WHERE submission_id=$1',[submissionId]);
  return {analysis: result.rows[0] ? view(result.rows[0]) : {state:'not_requested',submissionId}};
}
export async function enqueueAnalysis(pool: Pool, submissionId: string, ownerId: string): Promise<{analysis: AnalysisView; created: boolean}> {
  return withTransaction(pool, async client => {
    await owned(client,submissionId,ownerId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mingocell:analysis-admission',0))");
    const previous = await client.query<JobRow>('SELECT * FROM mingocell_data.classification_jobs WHERE submission_id=$1 FOR UPDATE',[submissionId]);
    const old = previous.rows[0];
    if (old && !(old.state === 'failed' && old.retryable && old.attempts < 3)) return {analysis:view(old),created:false};
    const counts = await client.query<{total: number; own: number}>(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE i.owner_id=$1)::int AS own FROM mingocell_data.classification_jobs j
      JOIN mingocell_data.submissions s ON s.id=j.submission_id JOIN mingocell_data.images i ON i.id=s.image_id
      WHERE j.state IN ('queued','running')`,[ownerId]);
    if (counts.rows[0].total >= 100 || counts.rows[0].own >= 20) throw new HttpError(429,'ANALYSIS_QUEUE_FULL','Analysis queue is full. Try again later.');
    const result = old
      ? await client.query<JobRow>(`UPDATE mingocell_data.classification_jobs SET state='queued', available_at=now(),
          finished_at=NULL,error_code=NULL,retryable=false WHERE id=$1 RETURNING *`,[old.id])
      : await client.query<JobRow>('INSERT INTO mingocell_data.classification_jobs(id,submission_id) VALUES($1,$2) RETURNING *',[randomUUID(),submissionId]);
    if (old) await client.query("UPDATE mingocell_data.submissions SET status='uploaded' WHERE id=$1",[submissionId]);
    return {analysis:view(result.rows[0]),created:!old};
  });
}
