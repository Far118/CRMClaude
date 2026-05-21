/**
 * tests/rbac.test.js
 *
 * Unit-тесты RBAC-логики (§4, §16.2 design doc):
 *   computeVisibleUserIds — кто кого видит
 *   computeCanModify       — кто что может менять
 *
 * Запуск: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleUserIds, computeCanModify } from '../middleware/auth.js';

const admin   = { id: 'a1', role: 'admin' };
const head    = { id: 'h1', role: 'head', team_id: 't1' };
const manager = { id: 'm1', role: 'manager', team_id: 't1' };
const ops     = { id: 'o1', role: 'ops', team_id: 't1' };

// члены команды t1 (head + 2 менеджера)
const teamMembers = ['h1', 'm1', 'm2'];

// ── computeVisibleUserIds ─────────────────────────────────────────────────────

test('admin видит всех (null = без ограничения)', () => {
  assert.equal(computeVisibleUserIds(admin, []), null);
});

test('manager видит только себя', () => {
  assert.deepEqual(computeVisibleUserIds(manager, teamMembers), ['m1']);
});

test('ops видит только себя', () => {
  assert.deepEqual(computeVisibleUserIds(ops, teamMembers), ['o1']);
});

test('head видит свою команду', () => {
  const visible = computeVisibleUserIds(head, teamMembers);
  assert.deepEqual(visible.sort(), ['h1', 'm1', 'm2'].sort());
});

test('head без team_id видит только себя', () => {
  assert.deepEqual(computeVisibleUserIds({ id: 'h9', role: 'head', team_id: null }, []), ['h9']);
});

test('head не входящий в members команды всё равно включён в scope', () => {
  const visible = computeVisibleUserIds(head, ['m1', 'm2']); // h1 отсутствует в списке
  assert.ok(visible.includes('h1'));
});

// ── computeCanModify ──────────────────────────────────────────────────────────

test('admin может менять любые записи', () => {
  assert.equal(computeCanModify(admin, 'whoever', null), true);
});

test('manager может менять только свои', () => {
  assert.equal(computeCanModify(manager, 'm1', ['m1']), true);
  assert.equal(computeCanModify(manager, 'm2', ['m1']), false);
});

test('head может менять записи своей команды', () => {
  const visible = ['h1', 'm1', 'm2'];
  assert.equal(computeCanModify(head, 'm1', visible), true);
  assert.equal(computeCanModify(head, 'm2', visible), true);
  assert.equal(computeCanModify(head, 'h1', visible), true);
});

test('head НЕ может менять записи чужой команды', () => {
  const visible = ['h1', 'm1', 'm2'];
  assert.equal(computeCanModify(head, 'foreign_manager', visible), false);
});

test('manager не может менять запись другой команды (anti-IDOR)', () => {
  assert.equal(computeCanModify(manager, 'other_team_user', ['m1']), false);
});

test('ops не может менять чужие записи', () => {
  assert.equal(computeCanModify(ops, 'm1', ['o1']), false);
  assert.equal(computeCanModify(ops, 'o1', ['o1']), true); // только свои
});
