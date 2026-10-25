import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createAccount } from '../dist/auth/accounts.js';
import { model, prediction } from './analysis-fixtures.mjs';

export async function reviewTests(t, { pool, browser, owner, ownerId }) {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'purple' } }).png().toBuffer();
  async function savedImage(client, referred = true) {
    const upload = await client.upload(png, randomUUID(), 'expert-cell.png', 'image/png');
    assert.equal(upload.status, 201);
    const submissionId = upload.data.submissions[0].id, analysisId = randomUUID();
    const output = { prediction: referred ? { ...prediction, probabilities: Array(6).fill(1 / 6), calibrated_confidence: 1 / 6, normalized_entropy: 1, abstained: true } : prediction,
      provenance: { originalSha256: upload.data.image.sha256, inputSha256: upload.data.image.sha256, pageIndex: 0, extractionVersion: 'original-bytes-v1', pillowVersion: null, model, analyzedAt: new Date().toISOString() } };
    await pool.query("INSERT INTO mingocell_data.classification_jobs(id,submission_id,state,attempts,result) VALUES($1,$2,'succeeded',1,$3)", [analysisId, submissionId, output]);
    await pool.query("UPDATE mingocell_data.submissions SET status='analyzed' WHERE id=$1", [submissionId]);
    return { submissionId, analysisId, output, path: `/api/v1/submissions/${submissionId}/reviews` };
  }
  await t.test('pathologist and admin save append-only decisions without changing classifier output', async () => {
    const email = `${randomUUID()}@example.org`, password = 'Admin review test password 123!';
    await createAccount(pool, email, password, 'admin');
    const admin = browser();
    await admin.request('/api/v1/auth/session');
    const login = await admin.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(login.status, 200);
    for (const [client, role, reviewerId] of [[owner, 'pathologist', ownerId], [admin, 'admin', login.data.user.id]]) {
      const saved = await savedImage(client);
      const write = (body, key = randomUUID(), extra = {}) => client.request(saved.path, { method: 'POST', body, extraHeaders: { 'Idempotency-Key': key }, ...extra });
      const empty = await client.request(saved.path);
      assert.deepEqual(empty.data.reviews, []);
      const confirm = { disposition: 'Confirmed', stage: null, notes: 'Original stage confirmed.', previousReviewId: null };
      assert.equal((await write(confirm, randomUUID(), { csrf: false })).status, 403);
      assert.equal((await write({ ...confirm, reviewerId: 'spoofed' })).status, 400);
      const key = randomUUID(), first = await write(confirm, key);
      assert.equal(first.status, 201);
      assert.equal(first.data.review.reviewer.id, reviewerId);
      assert.equal(first.data.review.reviewer.role, role);
      assert.equal(first.data.review.stage, 'MYO');
      assert.equal(first.data.review.analysisId, saved.analysisId);
      assert.equal(first.data.review.revision, 1);
      assert.ok(Number.isFinite(Date.parse(first.data.review.createdAt)));
      const changed = await write({ disposition: 'Reclassified', stage: 'PMO', notes: 'Morphology supports promyelocyte.', previousReviewId: first.data.review.id });
      assert.equal(changed.status, 201);
      assert.equal(changed.data.review.stage, 'PMO');
      assert.equal(changed.data.review.revision, 2);
      const unresolved = await write({ disposition: 'Unresolved', stage: null, notes: 'Needs another image.', previousReviewId: changed.data.review.id });
      assert.equal(unresolved.status, 201);
      assert.equal(unresolved.data.review.stage, null);
      const replay = await write(confirm, key.toUpperCase());
      assert.equal(replay.data.review.id, first.data.review.id);
      assert.equal(replay.headers.get('idempotency-replayed'), 'true');
      assert.equal((await write({ ...confirm, notes: 'Different bytes' }, key)).status, 409);
      const stale = await write(confirm);
      assert.equal(stale.status, 409);
      assert.equal(stale.data.error.code, 'REVIEW_CONFLICT');
      const concurrent = { disposition: 'Confirmed', stage: null, notes: 'Follow-up review.', previousReviewId: unresolved.data.review.id };
      const race = await Promise.all([write(concurrent), write(concurrent)]);
      assert.deepEqual(race.map(response => response.status).sort(), [201, 409]);
      const latest = await client.request(`${saved.path}?limit=1`);
      assert.equal(latest.data.reviews[0].revision, 4);
      assert.equal(latest.data.pageInfo.hasMore, true);
      const older = await client.request(`${saved.path}?limit=1&before=${latest.data.pageInfo.nextBefore}`);
      assert.equal(older.data.reviews[0].revision, 3);
      const original = (await pool.query('SELECT result FROM mingocell_data.classification_jobs WHERE id=$1', [saved.analysisId])).rows[0].result;
      assert.deepEqual(original, saved.output);
      await assert.rejects(pool.query('UPDATE mingocell_data.expert_reviews SET notes=$1 WHERE id=$2', ['edited', first.data.review.id]), /append-only/);
      await assert.rejects(pool.query('DELETE FROM mingocell_data.expert_reviews WHERE id=$1', [first.data.review.id]), /append-only/);
      assert.equal((await (client === owner ? admin : owner).request(saved.path)).status, 404);
      assert.equal((await (client === owner ? admin : owner).request(saved.path, { method: 'POST', body: confirm, extraHeaders: { 'Idempotency-Key': randomUUID() } })).status, 404);
    }
    await assert.rejects(pool.query('TRUNCATE mingocell_data.expert_reviews'), /append-only/);
    const accepted = await savedImage(owner, false);
    const denied = await owner.request(accepted.path, { method: 'POST', body: { disposition: 'Confirmed', previousReviewId: null }, extraHeaders: { 'Idempotency-Key': randomUUID() } });
    assert.equal(denied.status, 409);
    assert.equal(denied.data.error.code, 'REVIEW_NOT_AVAILABLE');
    assert.equal((await browser().request(accepted.path)).status, 401);
  });
}
