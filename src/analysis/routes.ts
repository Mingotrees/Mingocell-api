import type { Express } from 'express';
import type { Pool } from 'pg';
import { requireAuth, requireRole, type PublicUser } from '../auth/middleware.js';
import { enqueueAnalysis, getAnalysis } from './repository.js';

export function mountAnalysisRoutes(app: Express, pool: Pool) {
  app.get('/api/v1/submissions/:id/analysis',requireAuth,async (req,res) => {
    res.json(await getAnalysis(pool,String(req.params.id),(res.locals.user as PublicUser).id));
  });
  app.post('/api/v1/submissions/:id/analysis',requireRole('pathologist'),async (req,res,next) => {
    try {
      const {analysis} = await enqueueAnalysis(pool,String(req.params.id),(res.locals.user as PublicUser).id);
      res.setHeader('Location',analysis.statusUrl);
      res.status(['queued','running'].includes(analysis.state) ? 202 : 200).json({analysis});
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ANALYSIS_QUEUE_FULL') res.setHeader('Retry-After','30');
      next(error);
    }
  });
}
