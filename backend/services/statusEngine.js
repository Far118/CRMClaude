/**
 * services/statusEngine.js
 *
 * Пересчёт calculated_status компании на основе её запросов.
 * Реализует алгоритм из design doc §5.2:
 *
 *   1. CLIENT       ← есть handover за последние N месяцев
 *   2. HOT_LEAD     ← есть активный запрос в kp_sent / negotiation
 *   3. WARM_LEAD    ← есть активный запрос в new / in_progress
 *   4. LOST         ← все запросы закрыты, последний — close_reason.is_loss=true
 *   5. COLD_LEAD    ← всё остальное
 *
 * Вызывается:
 *   - из routes/requests.js при создании/изменении статуса/удалении запроса
 *   - из services/worker.js при обработке outbox-событий
 *   - из cron-скрипта для проверки истёкших client window
 */

import knex from '../db/knex.js';
import { config } from '../config.js';

/**
 * Пересчитывает статус компании.
 *
 * @param {string} companyId
 * @param {object} options - { triggerEvent, triggerData, userId, trx }
 * @returns {Promise<{ from: string|null, to: string, changed: boolean }>}
 */
export async function recalculateCompanyStatus(companyId, options = {}) {
  const { triggerEvent = 'unknown', triggerData = null, userId = null, trx = null } = options;
  const qb = trx || knex;

  const company = await qb('companies').where({ id: companyId }).first();
  if (!company) {
    return { from: null, to: null, changed: false };
  }

  const requests = await qb('requests')
    .where({ company_id: companyId })
    .select('id', 'status', 'handover_at', 'closed_at', 'close_reason_id', 'created_at');

  const newStatus = await calculateStatus(requests, qb);
  const oldStatus = company.calculated_status;

  if (oldStatus === newStatus) {
    return { from: oldStatus, to: newStatus, changed: false };
  }

  // Транзакция: обновляем компанию + пишем в history
  const updateInTrx = async (tx) => {
    await tx('companies')
      .where({ id: companyId })
      .update({ calculated_status: newStatus, updated_at: tx.fn.now() });

    await tx('company_status_history').insert({
      company_id:    companyId,
      from_status:   oldStatus,
      to_status:     newStatus,
      trigger_event: triggerEvent,
      trigger_data:  triggerData ? JSON.stringify(triggerData) : null,
      changed_by:    userId,
    });
  };

  if (trx) {
    await updateInTrx(trx);
  } else {
    await knex.transaction(updateInTrx);
  }

  return { from: oldStatus, to: newStatus, changed: true };
}

/**
 * Чистая функция расчёта статуса (БЕЗ обращения к БД) — для unit-тестов.
 *
 * @param {Array} requests - каждый объект: { status, handover_at, created_at, is_loss }
 *   где is_loss — уже разрезолвленный флаг причины закрытия (boolean).
 * @param {object} opts - { now?: Date, clientWindowMonths?: number }
 * @returns {string} статус компании
 */
export function computeStatus(requests, opts = {}) {
  if (!requests || requests.length === 0) return 'cold_lead';

  const now = opts.now instanceof Date ? opts.now : new Date();
  const months = opts.clientWindowMonths ?? config.clientWindowMonths;
  const windowStart = new Date(now.getTime() - months * 30 * 24 * 60 * 60 * 1000);

  // 1. CLIENT — handover за последние N месяцев
  const hasRecentHandover = requests.some(r =>
    r.status === 'handover' && r.handover_at && new Date(r.handover_at) >= windowStart
  );
  if (hasRecentHandover) return 'client';

  // 2. HOT_LEAD
  if (requests.some(r => r.status === 'kp_sent' || r.status === 'negotiation')) return 'hot_lead';

  // 3. WARM_LEAD
  if (requests.some(r => r.status === 'new' || r.status === 'in_progress')) return 'warm_lead';

  // 4. LOST — все закрыты/переданы, последний по дате — закрыт с is_loss=true
  const allClosed = requests.every(r => r.status === 'closed' || r.status === 'handover');
  if (allClosed) {
    const sorted = [...requests].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const last = sorted[0];
    if (last.status === 'closed' && last.is_loss === true) return 'lost';
  }

  // 5. COLD_LEAD
  return 'cold_lead';
}

/**
 * DB-aware обёртка: подгружает is_loss из close_reasons и вызывает computeStatus.
 * Экспортируется для использования в recalculateCompanyStatus.
 */
export async function calculateStatus(requests, qb = knex) {
  if (!requests || requests.length === 0) return 'cold_lead';

  // Разрезолвить is_loss для закрытых запросов
  const reasonIds = [...new Set(
    requests.filter(r => r.status === 'closed' && r.close_reason_id).map(r => r.close_reason_id)
  )];
  let lossMap = {};
  if (reasonIds.length) {
    const reasons = await qb('close_reasons').whereIn('id', reasonIds).select('id', 'is_loss');
    lossMap = Object.fromEntries(reasons.map(r => [r.id, r.is_loss]));
  }

  const enriched = requests.map(r => ({
    status:      r.status,
    handover_at: r.handover_at,
    created_at:  r.created_at,
    is_loss:     r.close_reason_id ? !!lossMap[r.close_reason_id] : false,
  }));

  return computeStatus(enriched);
}

/**
 * Помещает событие в outbox.
 * Использовать ВСЕГДА внутри той же транзакции, что изменяет request.
 *
 * @param {object} trx - Knex transaction
 * @param {string} eventType - 'request.created' | 'request.status_changed' | 'request.deleted'
 * @param {object} payload
 */
export async function enqueueEvent(trx, eventType, payload) {
  await trx('outbox').insert({
    event_type: eventType,
    payload:    JSON.stringify(payload),
  });
}

/**
 * Cron-задача: пересчёт компаний, чьё client window истекло.
 * Запускается раз в сутки (см. services/worker.js).
 */
export async function recalcExpiredClients() {
  const windowMs = config.clientWindowMonths * 30 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - windowMs);

  // Берём компании со статусом client, у которых последний handover старше window
  const candidates = await knex('companies as c')
    .select('c.id')
    .where('c.calculated_status', 'client')
    .whereNotExists(function() {
      this.select('*')
        .from('requests as r')
        .whereRaw('r.company_id = c.id')
        .where('r.status', 'handover')
        .where('r.handover_at', '>=', cutoff);
    });

  let changed = 0;
  for (const c of candidates) {
    const result = await recalculateCompanyStatus(c.id, {
      triggerEvent: 'cron_window_expired',
    });
    if (result.changed) changed++;
  }

  return { checked: candidates.length, changed };
}
