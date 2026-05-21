/**
 * tests/transitions.test.js
 *
 * Проверка таблицы допустимых переходов статусов запроса (§6.1).
 *
 * Запуск: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TRANSITIONS, REQUEST_STATUSES } from '../constants/index.js';

test('все 6 статусов присутствуют', () => {
  assert.deepEqual(
    REQUEST_STATUSES.sort(),
    ['closed', 'handover', 'in_progress', 'kp_sent', 'negotiation', 'new'].sort()
  );
});

test('new → in_progress | closed', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.new.sort(), ['closed', 'in_progress'].sort());
});

test('in_progress → kp_sent | closed | new', () => {
  assert.ok(ALLOWED_TRANSITIONS.in_progress.includes('kp_sent'));
  assert.ok(ALLOWED_TRANSITIONS.in_progress.includes('closed'));
});

test('kp_sent → negotiation | handover | closed', () => {
  assert.ok(ALLOWED_TRANSITIONS.kp_sent.includes('negotiation'));
  assert.ok(ALLOWED_TRANSITIONS.kp_sent.includes('handover'));
  assert.ok(ALLOWED_TRANSITIONS.kp_sent.includes('closed'));
});

test('negotiation → handover | closed | kp_sent', () => {
  assert.ok(ALLOWED_TRANSITIONS.negotiation.includes('handover'));
  assert.ok(ALLOWED_TRANSITIONS.negotiation.includes('kp_sent'));
});

test('handover → closed (терминальный, откат только admin)', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.handover, ['closed']);
});

test('closed → in_progress (reopen)', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.closed, ['in_progress']);
});

test('каждый переход ведёт в валидный статус', () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    assert.ok(REQUEST_STATUSES.includes(from), `${from} — валидный исходный статус`);
    for (const t of targets) {
      assert.ok(REQUEST_STATUSES.includes(t), `${from}→${t}: ${t} валиден`);
    }
  }
});

test('нельзя перепрыгнуть new → handover напрямую', () => {
  assert.ok(!ALLOWED_TRANSITIONS.new.includes('handover'));
});

test('нельзя перепрыгнуть new → kp_sent напрямую', () => {
  assert.ok(!ALLOWED_TRANSITIONS.new.includes('kp_sent'));
});
