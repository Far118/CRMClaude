/**
 * tests/statusEngine.test.js
 *
 * Unit-тесты чистой функции computeStatus().
 * Покрывают алгоритм §5.2 и edge cases §20 из design doc.
 *
 * Запуск: npm test  (node --test)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus } from '../services/statusEngine.js';

const NOW = new Date('2024-06-15T12:00:00Z');
const opts = { now: NOW, clientWindowMonths: 6 };

// даты-помощники
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
const monthsAgo = (m) => new Date(NOW.getTime() - m * 30 * 24 * 60 * 60 * 1000).toISOString();

// ── Базовый алгоритм §5.2 ─────────────────────────────────────────────────────

test('нет запросов → cold_lead', () => {
  assert.equal(computeStatus([], opts), 'cold_lead');
  assert.equal(computeStatus(null, opts), 'cold_lead');
});

test('один запрос new → warm_lead', () => {
  assert.equal(computeStatus([{ status: 'new', created_at: daysAgo(1) }], opts), 'warm_lead');
});

test('один запрос in_progress → warm_lead', () => {
  assert.equal(computeStatus([{ status: 'in_progress', created_at: daysAgo(1) }], opts), 'warm_lead');
});

test('один запрос kp_sent → hot_lead', () => {
  assert.equal(computeStatus([{ status: 'kp_sent', created_at: daysAgo(1) }], opts), 'hot_lead');
});

test('один запрос negotiation → hot_lead', () => {
  assert.equal(computeStatus([{ status: 'negotiation', created_at: daysAgo(1) }], opts), 'hot_lead');
});

test('handover за последние 6 мес → client', () => {
  assert.equal(computeStatus([
    { status: 'handover', handover_at: daysAgo(10), created_at: daysAgo(30) },
  ], opts), 'client');
});

// ── §20 #1: несколько запросов разных статусов → приоритет ───────────────────

test('#1 client > hot > warm: handover + kp_sent + new → client', () => {
  assert.equal(computeStatus([
    { status: 'new', created_at: daysAgo(1) },
    { status: 'kp_sent', created_at: daysAgo(5) },
    { status: 'handover', handover_at: daysAgo(3), created_at: daysAgo(20) },
  ], opts), 'client');
});

test('#1 hot > warm: kp_sent + new → hot_lead', () => {
  assert.equal(computeStatus([
    { status: 'new', created_at: daysAgo(1) },
    { status: 'kp_sent', created_at: daysAgo(5) },
  ], opts), 'hot_lead');
});

// ── §20 #2: один closed, другой negotiation → hot_lead ───────────────────────

test('#2 closed(loss) + negotiation → hot_lead (потеря игнорируется)', () => {
  assert.equal(computeStatus([
    { status: 'closed', is_loss: true, created_at: daysAgo(10) },
    { status: 'negotiation', created_at: daysAgo(2) },
  ], opts), 'hot_lead');
});

// ── §20 #3: была client, пришёл новый запрос → остаётся client (window) ──────

test('#3 client + новый new-запрос → client (window не истёк)', () => {
  assert.equal(computeStatus([
    { status: 'handover', handover_at: daysAgo(20), created_at: daysAgo(60) },
    { status: 'new', created_at: daysAgo(1) },
  ], opts), 'client');
});

// ── §20 #4: все закрыты, последний tech_duplicate (is_loss=false) → cold ─────

test('#4 последний закрыт tech_duplicate (is_loss=false) → cold_lead', () => {
  assert.equal(computeStatus([
    { status: 'closed', is_loss: true,  created_at: daysAgo(30) },
    { status: 'closed', is_loss: false, created_at: daysAgo(5) },  // последний — дубль
  ], opts), 'cold_lead');
});

test('#4b последний закрыт с is_loss=true → lost', () => {
  assert.equal(computeStatus([
    { status: 'closed', is_loss: false, created_at: daysAgo(30) },
    { status: 'closed', is_loss: true,  created_at: daysAgo(5) },  // последний — потеря
  ], opts), 'lost');
});

// ── Client window: истёкший handover ─────────────────────────────────────────

test('handover старше 6 мес, нет активных → НЕ client', () => {
  const res = computeStatus([
    { status: 'handover', handover_at: monthsAgo(8), created_at: monthsAgo(9) },
  ], opts);
  // все «закрыты/переданы», последний handover (не closed) → cold_lead
  assert.equal(res, 'cold_lead');
});

test('handover старше 6 мес + новый kp_sent → hot_lead', () => {
  assert.equal(computeStatus([
    { status: 'handover', handover_at: monthsAgo(8), created_at: monthsAgo(9) },
    { status: 'kp_sent', created_at: daysAgo(2) },
  ], opts), 'hot_lead');
});

// ── LOST только когда нет активных ───────────────────────────────────────────

test('lost не выставляется при наличии активного запроса', () => {
  assert.equal(computeStatus([
    { status: 'closed', is_loss: true, created_at: daysAgo(10) },
    { status: 'new', created_at: daysAgo(1) },
  ], opts), 'warm_lead');
});

// ── Граница window ────────────────────────────────────────────────────────────

test('handover ровно на границе window (5 мес 29 дней) → client', () => {
  assert.equal(computeStatus([
    { status: 'handover', handover_at: daysAgo(170), created_at: daysAgo(180) },
  ], opts), 'client');
});
