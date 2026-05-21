/**
 * routes/requests.js — Запросы (presales)
 *
 * GET    /api/requests
 * GET    /api/requests/:id
 * GET    /api/requests/:id/history
 * POST   /api/requests
 * PUT    /api/requests/:id
 * PATCH  /api/requests/:id/status
 * POST   /api/requests/:id/reopen      (head/admin)
 * DELETE /api/requests/:id             (admin)
 *
 * Каждое изменение статуса:
 *   - пишет в request_status_history,
 *   - кладёт событие в outbox (для пересчёта статуса компании),
 *   - пишет в audit_logs.
 * Всё это — в одной транзакции (transactional outbox, design §7.2).
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, requireRole, applyOwnerScope, getVisibleUserIds, canModify } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/auditLog.js';
import { enqueueEvent, recalculateCompanyStatus } from '../services/statusEngine.js';
import {
  REQUEST_STATUSES, TRANSPORT_TYPES, CARGO_TYPES, CURRENCIES, INCOTERMS, ALLOWED_TRANSITIONS,
} from '../constants/index.js';

// ── Хелпер создания in-app уведомлений ───────────────────────────────────────

async function notify(trx, { userId, type, title, body, entityId }) {
  if (!userId) return;
  try {
    await (trx || knex)('notifications').insert({
      user_id: userId, type, title,
      body: body || '',
      entity_type: 'request', entity_id: entityId,
    });
  } catch (e) { /* не блокируем основной поток */ }
}

const router = Router();
router.use(authenticate);

// ── Zod ─────────────────────────────────────────────────────────────────────

const RequestSchema = z.object({
  company_id:         z.string().uuid(),
  contact_id:         z.string().uuid().nullable().optional(),
  owner_id:           z.string().uuid().optional(),
  route_from:         z.string().max(500).optional().default(''),
  route_to:           z.string().max(500).optional().default(''),
  route_via:          z.string().max(500).optional().default(''),
  distance_km:        z.number().positive().nullable().optional(),
  cargo_type:         z.enum(CARGO_TYPES).optional().default('general'),
  cargo_description:  z.string().max(2000).optional().default(''),
  weight_kg:          z.number().positive().nullable().optional(),
  volume_m3:          z.number().positive().nullable().optional(),
  places_count:       z.number().int().positive().nullable().optional(),
  cargo_value:        z.number().min(0).nullable().optional(),
  is_adr:             z.boolean().optional().default(false),
  is_oversized:       z.boolean().optional().default(false),
  temperature_regime: z.string().max(100).optional().default(''),
  transport_type:     z.enum(TRANSPORT_TYPES).optional().default('auto'),
  loading_type:       z.string().max(100).optional().default(''),
  incoterms:          z.enum(INCOTERMS).optional().default(''),
  loading_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  delivery_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  budget:             z.number().min(0).nullable().optional(),
  our_rate:           z.number().min(0).nullable().optional(),
  carrier_rate:       z.number().min(0).nullable().optional(),
  margin:             z.number().nullable().optional(),
  margin_percent:     z.number().nullable().optional(),
  currency:           z.enum(CURRENCIES).optional().default('RUB'),
  is_regular:         z.boolean().optional().default(false),
  frequency:          z.string().max(200).optional().default(''),
  notes:              z.string().max(5000).optional().default(''),
});

const UpdateRequestSchema = RequestSchema.omit({ company_id: true, owner_id: true }).partial();

// ── GET / ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { company_id, status, owner_id, q, limit = 300, offset = 0 } = req.query;

    const qb = knex('requests as r')
      .leftJoin('companies as c', 'c.id', 'r.company_id')
      .leftJoin('users as u', 'u.id', 'r.owner_id')
      .leftJoin('close_reasons as cr', 'cr.id', 'r.close_reason_id')
      .select('r.*', 'c.name as company_name',
        knex.raw("(u.first_name || ' ' || u.last_name) as owner_name"),
        'cr.label as close_reason_label')
      .orderBy('r.created_at', 'desc')
      .limit(Math.min(Number(limit), 1000))
      .offset(Number(offset));

    await applyOwnerScope(qb, req.user, 'r.owner_id');

    if (company_id) qb.where('r.company_id', company_id);
    if (status)     qb.where('r.status', status);
    if (owner_id) {
      const visible = await getVisibleUserIds(req.user);
      if (visible === null || visible.includes(owner_id)) qb.where('r.owner_id', owner_id);
    }
    if (q) {
      const s = `%${q}%`;
      qb.where(b => b
        .whereILike('r.route_from', s)
        .orWhereILike('r.route_to', s)
        .orWhereILike('r.notes', s)
        .orWhereILike('c.name', s)
      );
    }

    res.json(await qb);
  } catch (err) {
    console.error('[requests/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

async function loadVisibleRequest(req, id) {
  const row = await knex('requests as r')
    .leftJoin('companies as c', 'c.id', 'r.company_id')
    .leftJoin('users as u', 'u.id', 'r.owner_id')
    .leftJoin('close_reasons as cr', 'cr.id', 'r.close_reason_id')
    .select('r.*', 'c.name as company_name',
      knex.raw("(u.first_name || ' ' || u.last_name) as owner_name"),
      'cr.label as close_reason_label')
    .where('r.id', id)
    .first();

  if (!row) return null;
  const visible = await getVisibleUserIds(req.user);
  if (visible !== null && row.owner_id && !visible.includes(row.owner_id)) return null;
  return row;
}

router.get('/:id', async (req, res) => {
  try {
    const row = await loadVisibleRequest(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Не найдено' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/history', async (req, res) => {
  try {
    const row = await loadVisibleRequest(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Не найдено' });

    const hist = await knex('request_status_history as h')
      .leftJoin('users as u', 'u.id', 'h.changed_by')
      .select('h.*', knex.raw("(u.first_name || ' ' || u.last_name) as changed_by_name"))
      .where('h.request_id', req.params.id)
      .orderBy('h.changed_at', 'desc');

    res.json(hist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────

router.post('/', validate(RequestSchema), async (req, res) => {
  try {
    const company = await knex('companies').where({ id: req.body.company_id }).first();
    if (!company) return res.status(404).json({ error: 'Компания не найдена' });

    // RBAC: manager создаёт запрос только для своей компании
    if (!await canModify(req.user, company.owner_id)) {
      return res.status(403).json({ error: 'Нельзя создавать запрос для чужой компании' });
    }

    const data = { ...req.body, status: 'new' };
    if (!data.owner_id) data.owner_id = company.owner_id || req.user.id;
    if (req.user.role === 'manager') data.owner_id = req.user.id;

    const request = await knex.transaction(async (trx) => {
      const [r] = await trx('requests').insert(data).returning('*');
      await trx('request_status_history').insert({
        request_id: r.id, from_status: null, to_status: 'new', changed_by: req.user.id,
      });
      await enqueueEvent(trx, 'request.created', { request_id: r.id, company_id: r.company_id });
      return r;
    });

    // Синхронный пересчёт компании (быстрый), worker подстрахует
    await recalculateCompanyStatus(request.company_id, {
      triggerEvent: 'request_created', userId: req.user.id,
      triggerData: { request_id: request.id },
    });

    await audit(req, 'request.create', 'request', request.id, null, request);
    res.status(201).json(request);
  } catch (err) {
    console.error('[requests/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────

router.put('/:id', validate(UpdateRequestSchema), async (req, res) => {
  try {
    const existing = await knex('requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, existing.owner_id)) return res.status(404).json({ error: 'Не найдено' });

    // Read-only после handover (design §6.3)
    if (existing.status === 'handover') {
      const allowed = ['handover_notes'];
      const keys = Object.keys(req.body);
      if (keys.some(k => !allowed.includes(k))) {
        return res.status(409).json({ error: 'Запрос передан в договоры — редактирование заблокировано (кроме примечаний)' });
      }
    }
    if (existing.status === 'closed') {
      return res.status(409).json({ error: 'Закрытый запрос нельзя редактировать. Сначала переоткройте его.' });
    }

    const [updated] = await knex('requests').where({ id: req.params.id }).update(req.body).returning('*');
    await audit(req, 'request.update', 'request', updated.id, existing, updated);
    res.json(updated);
  } catch (err) {
    console.error('[requests/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /:id/status ─────────────────────────────────────────────────────────

const StatusSchema = z.object({
  status:          z.enum(REQUEST_STATUSES),
  close_reason_id: z.string().uuid().nullable().optional(),
  comment:         z.string().max(2000).optional().default(''),
  updated_at:      z.string().optional(),  // для optimistic locking (§20 #12)
});

router.patch('/:id/status', validate(StatusSchema), async (req, res) => {
  try {
    const { status, close_reason_id, comment, updated_at: clientUpdatedAt } = req.body;
    const existing = await knex('requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, existing.owner_id)) return res.status(404).json({ error: 'Не найдено' });

    // Optimistic locking (§20 #12)
    if (clientUpdatedAt) {
      const diff = Math.abs(new Date(clientUpdatedAt) - new Date(existing.updated_at));
      if (diff > 1000) {
        return res.status(409).json({
          error: 'Запрос был изменён другим пользователем. Обновите страницу.',
          code: 'CONFLICT',
        });
      }
    }

    const from = existing.status;

    // Проверка допустимости перехода
    const allowed = ALLOWED_TRANSITIONS[from] || [];
    if (from !== status && !allowed.includes(status)) {
      // admin может переходить куда угодно
      if (req.user.role !== 'admin') {
        return res.status(409).json({ error: `Недопустимый переход: ${from} → ${status}` });
      }
    }

    // handover из любого статуса откатывается только admin'ом
    if (from === 'handover' && status !== 'handover' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Откат из «Передан в договоры» доступен только администратору' });
    }

    // ── Валидация по целевому статусу ──────────────────────────────────────
    const updates = { status };

    if (status === 'kp_sent' && !existing.kp_sent_at) {
      updates.kp_sent_at = knex.fn.now();
    }

    if (status === 'handover') {
      // чек-лист (design §6.5)
      const missing = [];
      if (!existing.route_from) missing.push('маршрут «Откуда»');
      if (!existing.route_to)   missing.push('маршрут «Куда»');
      if (!existing.our_rate || Number(existing.our_rate) <= 0) missing.push('ставка > 0');

      // Проверка прикреплённого КП
      const attCount = await knex('attachments').where({ request_id: req.params.id }).count('* as cnt').first();
      if (Number(attCount.cnt) === 0) missing.push('прикреплённое КП (хотя бы один файл)');

      if (missing.length) {
        return res.status(409).json({
          error: `Перед передачей в договоры заполните: ${missing.join(', ')}`,
          missing,
        });
      }
      updates.handover_at = knex.fn.now();
    }

    if (status === 'closed') {
      if (!close_reason_id) {
        return res.status(400).json({ error: 'При закрытии обязательно укажите причину' });
      }
      const reason = await knex('close_reasons').where({ id: close_reason_id, is_active: true }).first();
      if (!reason) return res.status(400).json({ error: 'Неизвестная причина закрытия' });
      if (reason.requires_comment && !comment.trim()) {
        return res.status(400).json({ error: 'Для этой причины обязателен комментарий' });
      }
      updates.close_reason_id = close_reason_id;
      updates.close_comment   = comment;
      updates.closed_at       = knex.fn.now();
    } else {
      // если уходим из closed — сбрасываем причину
      if (from === 'closed') {
        updates.close_reason_id = null;
        updates.close_comment   = '';
        updates.closed_at       = null;
      }
    }

    const updated = await knex.transaction(async (trx) => {
      const [r] = await trx('requests').where({ id: req.params.id }).update(updates).returning('*');
      await trx('request_status_history').insert({
        request_id: r.id, from_status: from, to_status: status,
        changed_by: req.user.id, comment, close_reason_id: close_reason_id || null,
      });
      await enqueueEvent(trx, 'request.status_changed', {
        request_id: r.id, company_id: r.company_id, from, to: status,
      });

      // In-app уведомления (§14)
      const statusLabels = { new:'Новый', in_progress:'В работе', kp_sent:'КП отправлено',
        negotiation:'Согласование', handover:'Передан в договоры', closed:'Закрыт' };
      const label = statusLabels[status] || status;

      // Уведомить owner (если он не сам сменил)
      if (r.owner_id && r.owner_id !== req.user.id) {
        await notify(trx, { userId: r.owner_id, type: 'request_status', entityId: r.id,
          title: `Статус запроса изменён → ${label}`,
          body: `Маршрут: ${r.route_from||'?'} → ${r.route_to||'?'}` });
      }
      // При handover — дополнительное уведомление
      if (status === 'handover') {
        await notify(trx, { userId: r.owner_id, type: 'request_handover', entityId: r.id,
          title: '🏆 Запрос передан в договоры',
          body: `Маршрут: ${r.route_from||'?'} → ${r.route_to||'?'}. Ставка: ${r.our_rate||0} ${r.currency||'RUB'}` });
      }
      return r;
    });

    await recalculateCompanyStatus(updated.company_id, {
      triggerEvent: 'request_status_changed', userId: req.user.id,
      triggerData: { request_id: updated.id, from, to: status },
    });

    await audit(req, 'request.status_change', 'request', updated.id, { status: from }, { status });
    res.json(updated);
  } catch (err) {
    console.error('[requests/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /:id/reopen ──────────────────────────────────────────────────────────

const ReopenSchema = z.object({ comment: z.string().min(1).max(2000) });

router.post('/:id/reopen', requireRole('admin','head'), validate(ReopenSchema), async (req, res) => {
  try {
    const existing = await knex('requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (existing.status !== 'closed') return res.status(409).json({ error: 'Можно переоткрыть только закрытый запрос' });
    if (req.user.role === 'head' && !await canModify(req.user, existing.owner_id)) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    const updated = await knex.transaction(async (trx) => {
      const [r] = await trx('requests').where({ id: req.params.id })
        .update({ status: 'in_progress', close_reason_id: null, close_comment: '', closed_at: null })
        .returning('*');
      await trx('request_status_history').insert({
        request_id: r.id, from_status: 'closed', to_status: 'in_progress',
        changed_by: req.user.id, comment: `Переоткрыт: ${req.body.comment}`,
      });
      await enqueueEvent(trx, 'request.status_changed', {
        request_id: r.id, company_id: r.company_id, from: 'closed', to: 'in_progress',
      });
      return r;
    });

    await recalculateCompanyStatus(updated.company_id, {
      triggerEvent: 'request_status_changed', userId: req.user.id,
      triggerData: { reopened: true },
    });

    await audit(req, 'request.reopen', 'request', updated.id, { status: 'closed' }, { status: 'in_progress', comment: req.body.comment });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const existing = await knex('requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });

    await knex('requests').where({ id: req.params.id }).del();
    await recalculateCompanyStatus(existing.company_id, {
      triggerEvent: 'request_deleted', userId: req.user.id,
    });
    await audit(req, 'request.delete', 'request', req.params.id, existing, null);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
