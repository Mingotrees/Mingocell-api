import type { Express } from 'express';
import type { Pool } from 'pg';
import { requireRole, type PublicUser } from '../auth/middleware.js';
import { parseReviewInput, reviewQuery } from './model.js';
import { getReviews, submitReview } from './repository.js';

export function mountReviewRoutes(app: Express, pool: Pool) {
  app.get('/api/v1/submissions/:id/reviews', requireRole('pathologist', 'admin'), async (req, res) => {
    res.json(await getReviews(pool, String(req.params.id), (res.locals.user as PublicUser).id, reviewQuery(req.query)));
  });
  app.post('/api/v1/submissions/:id/reviews', requireRole('pathologist', 'admin'), async (req, res) => {
    const input = parseReviewInput(req.body);
    const saved = await submitReview(pool, String(req.params.id), res.locals.user as PublicUser, input, req.get('Idempotency-Key') ?? '');
    if (saved.replayed) res.setHeader('Idempotency-Replayed', 'true');
    res.status(201).json({ review: saved.review });
  });
}
