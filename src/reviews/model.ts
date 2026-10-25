import { HttpError, type Role } from '../auth/middleware.js';

export const reviewStages = ['MYO', 'PMO', 'MYB', 'MMZ', 'NGB', 'NGS'] as const;
export type ReviewStage = typeof reviewStages[number];
export type ReviewDisposition = 'Confirmed' | 'Reclassified' | 'Unresolved';
export type ReviewInput = { disposition: ReviewDisposition; stage: ReviewStage | null; notes: string; previousReviewId: string | null };
export type ExpertReview = {
  id: string; submissionId: string; analysisId: string; revision: number;
  disposition: ReviewDisposition; stage: ReviewStage | null; notes: string; createdAt: string;
  reviewer: { id: string; email: string; role: Role };
};
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseReviewInput(value: unknown): ReviewInput {
  const invalid = (message: string): never => { throw new HttpError(400, 'INVALID_INPUT', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Provide an expert decision.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['disposition', 'stage', 'notes', 'previousReviewId'].includes(key))) return invalid('Reviewer identity and timestamps are assigned by the server. Provide only decision fields.');
  if (!['Confirmed', 'Reclassified', 'Unresolved'].includes(body.disposition as string)) return invalid('Select a valid disposition.');
  const stage = body.stage ?? null;
  if (body.disposition === 'Reclassified' ? !reviewStages.includes(stage as ReviewStage) : stage !== null) return invalid('Select a maturation stage only when reclassifying.');
  if (body.previousReviewId !== null && (typeof body.previousReviewId !== 'string' || !uuid.test(body.previousReviewId))) return invalid('Refresh the current review before submitting.');
  const notes = body.notes ?? '';
  if (typeof notes !== 'string' || notes.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) return invalid('Notes must be text of at most 2000 characters without control characters.');
  return { disposition: body.disposition as ReviewDisposition, stage: stage as ReviewStage | null, notes: notes.trim(), previousReviewId: body.previousReviewId as string | null };
}

export function reviewQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some(key => !['limit', 'before'].includes(key))) throw new HttpError(400, 'INVALID_INPUT', 'Unsupported review filter.');
  const integer = (value: unknown, fallback: number | null) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 2_147_483_647) throw new HttpError(400, 'INVALID_INPUT', 'Invalid review pagination.');
    return Number(value);
  };
  const limit = integer(query.limit, 20)!;
  if (limit > 100) throw new HttpError(400, 'INVALID_INPUT', 'Review limit must be between 1 and 100.');
  return { limit, before: integer(query.before, null) };
}
