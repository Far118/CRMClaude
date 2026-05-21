#!/usr/bin/env node
/**
 * services/worker.js — Фоновый обработчик.
 *
 * 1. Читает outbox и пересчитывает статусы компаний (подстраховка к
 *    синхронному пересчёту в роутах — гарантия консистентности).
 * 2. Раз в сутки пересчитывает истёкшие client window.
 * 3. Health-check: алерт если есть необработанные события > 1 минуты.
 *
 * Запуск отдельным процессом: npm run worker
 */

import knex from '../db/knex.js';
import { recalculateCompanyStatus, recalcExpiredClients } from './statusEngine.js';

const POLL_MS = 5_000;
const CRON_HOUR_UTC = 3;
let lastCronDay = null;

async function processOutbox() {
  const events = await knex('outbox')
    .whereNull('processed_at')
    .where('retry_count', '<', 5)
    .orderBy('created_at')
    .limit(50);

  for (const ev of events) {
    try {
      const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;

      if (['request.created','request.status_changed','request.deleted'].includes(ev.event_type)) {
        if (payload.company_id) {
          await recalculateCompanyStatus(payload.company_id, {
            triggerEvent: ev.event_type,
            triggerData: payload,
          });
        }
      }

      await knex('outbox').where({ id: ev.id }).update({ processed_at: knex.fn.now() });
    } catch (err) {
      console.error(`[worker] event ${ev.id} failed:`, err.message);
      await knex('outbox').where({ id: ev.id }).update({
        retry_count: ev.retry_count + 1,
        error_msg: err.message,
      });
    }
  }
}

async function healthCheck() {
  const stale = await knex('outbox')
    .whereNull('processed_at')
    .where('created_at', '<', knex.raw("NOW() - INTERVAL '1 minute'"))
    .count('* as cnt')
    .first();
  if (Number(stale.cnt) > 0) {
    console.warn(`[worker] ⚠️  ${stale.cnt} необработанных событий старше 1 минуты`);
  }
}

async function maybeRunCron() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  if (now.getUTCHours() === CRON_HOUR_UTC && lastCronDay !== today) {
    lastCronDay = today;
    console.log('[worker] Запуск ночного пересчёта client window…');
    const result = await recalcExpiredClients();
    console.log(`[worker] client window: проверено ${result.checked}, изменено ${result.changed}`);
  }
}

async function loop() {
  try {
    await processOutbox();
    await healthCheck();
    await maybeRunCron();
  } catch (err) {
    console.error('[worker] loop error:', err.message);
  }
  setTimeout(loop, POLL_MS);
}

console.log('[worker] Запущен. Опрос outbox каждые', POLL_MS / 1000, 'сек');
loop();
