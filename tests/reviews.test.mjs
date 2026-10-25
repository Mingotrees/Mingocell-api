import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewInput, reviewQuery } from '../dist/reviews/model.js';

test('expert decisions validate disposition, stage, note limits, concurrency and server-owned identity', () => {
  assert.deepEqual(parseReviewInput({ disposition: 'Confirmed', notes: ' checked ', previousReviewId: null }), { disposition: 'Confirmed', stage: null, notes: 'checked', previousReviewId: null });
  assert.equal(parseReviewInput({ disposition: 'Unresolved', previousReviewId: null }).stage, null);
  assert.equal(parseReviewInput({ disposition: 'Reclassified', stage: 'PMO', previousReviewId: null }).stage, 'PMO');
  for (const body of [null, [], {}, { disposition: 'Invalid', previousReviewId: null }, { disposition: 'Confirmed' },
    { disposition: 'Confirmed', stage: 'MYO', previousReviewId: null }, { disposition: 'Reclassified', stage: 'invalid', previousReviewId: null },
    { disposition: 'Unresolved', previousReviewId: null, reviewerId: 'spoofed' },
    { disposition: 'Confirmed', previousReviewId: null, notes: 'x'.repeat(2001) },
    { disposition: 'Confirmed', previousReviewId: null, notes: '\0' },
  ]) assert.throws(() => parseReviewInput(body), { status: 400 });
  assert.deepEqual(reviewQuery({}), { limit: 20, before: null });
  assert.deepEqual(reviewQuery({ limit: '10', before: '25' }), { limit: 10, before: 25 });
  for (const query of [{ limit: '101' }, { before: '0' }, { before: ['1'] }, { reviewerId: 'any' }]) assert.throws(() => reviewQuery(query), { status: 400 });
});
