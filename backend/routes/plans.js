/**
 * routes/plans.js
 *
 * GET  /api/plans/my?year=&month=
 * GET  /api/plans?year=&month=          (head/admin)
 * GET  /api/plans/progress?year=&month= (head/admin)
 * POST /api/plans                        (head/admin) — create/upsert + защита от понижения
 * POST /api/plans/copy-month            (head/admin)
 * DELETE /api/plans/:id                  (admin)
 *
 * Защита от понижения плана задним числом (design §11.7):
 *   - увеличение разрешено всем head/admin
 *   - уменьшение в текущем/прошлом месяце — только admin
 *   - история всех изменений в plan_history
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, requireRole, getVisibleUserIds } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/auditLog.js';
import { PLAN_FIELDS } from '../constants/index.js';

const router = Router();
router.use(authenticate);

const TARGET_KEYS = PLAN_FIELDS.map(f => f.key);

// ── Расчёт факта за период ──────────────────────────────────────────────────

async function getFact(userId, year, month) {
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = new Date(year, month, 0).toISOString().split('T')[0];
  const range = [from, to];

  const [req, kp, act, cmp] = await Promise.all([
    knex('requests')
      .select(
        knex.raw('COUNT(*) AS total'),
        knex.raw("COUNT(*) FILTER (WHERE status = 'handover') AS won"),
        knex.raw("COALESCE(SUM(our_rate) FILTER (WHERE status = 'handover'), 0) AS revenue"),
      )
      .where('owner_id', userId)
      .whereRaw("DATE(created_at) BETWEEN ? AND ?", range)
      .first(),

    knex('request_status_history as h')
      .join('requests as r', 'r.id', 'h.request_id')
      .where('r.owner_id', userId)
      .where('h.to_status', 'kp_sent')
      .whereRaw("DATE(h.changed_at) BETWEEN ? AND ?", range)
      .count('* as cnt')
      .first(),

    knex('activities')
      .select(
        knex.raw('COUNT(*) AS total'),
        knex.raw("COUNT(*) FILTER (WHERE type IN ('call_out','call_in')) AS calls"),
        knex.raw("COUNT(*) FILTER (WHERE type = 'meeting') AS meetings"),
      )
      .where('owner_id', userId)
      .whereRaw("DATE(occurred_at) BETWEEN ? AND ?", range)
      .first(),

    knex('companies').count('* as cnt')
      .where('owner_id', userId)
      .whereRaw("DATE(created_at) BETWEEN ? AND ?", range)
      .first(),
  ]);

  return {
    revenue:       Number(req.revenue),
    won:           Number(req.won),
    new_requests:  Number(req.total),
    kp_sent:       Number(kp.cnt),
    activities:    Number(act.total),
    calls:         Number(act.calls),
    meetings:      Number(act.meetings),
    new_companies: Number(cmp.cnt),
  };
}

function pct(fact, target) {
  if (!target) return null;
  return Math.min(Math.round(fact / target * 100), 100);
}

function buildProgress(plan, fact) {
  if (!plan) return null;
  return {
    revenue:       pct(fact.revenue,       plan.target_revenue),
    won:           pct(fact.won,           plan.target_won),
    new_requests:  pct(fact.new_requests,  plan.target_new_requests),
    kp_sent:       pct(fact.kp_sent,       plan.target_kp_sent),
    activities:    pct(fact.activities,    plan.target_activities),
    calls:         pct(fact.calls,         plan.target_calls),
    meetings:      pct(fact.meetings,      plan.target_meetings),
    new_companies: pct(fact.new_companies, plan.target_new_companies),
  };
}

// ── GET /my ───────────────────────────────────────────────────────────────────

router.get('/my', async (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const plan = await knex('plans').where({ user_id: req.user.id, year, month }).first();
    const fact = await getFact(req.user.id, year, month);

    res.json({ year, month, plan: plan || null, fact, progress: buildProgress(plan, fact) });
  } catch (err) {
    console.error('[plans/my]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET / ───────────────────────────────────────────────────────────────────

router.get('/', requireRole('admin','head'), async (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const visible = await getVisibleUserIds(req.user);
    const rows = await knex('plans as p')
      .join('users as u', 'u.id', 'p.user_id')
      .where({ 'p.year': year, 'p.month': month })
      .modify(qb => { if (visible !== null) qb.whereIn('p.user_id', visible); })
      .select('p.*', 'u.first_name', 'u.last_name', 'u.email')
      .orderBy('u.first_name');

    const result = await Promise.all(rows.map(async p => ({
      ...p,
      name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
      fact: await getFact(p.user_id, year, month),
    })));

    res.json(result);
  } catch (err) {
    console.error('[plans/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /progress ─────────────────────────────────────────────────────────────

router.get('/progress', requireRole('admin','head'), async (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    const visible = await getVisibleUserIds(req.user);
    const rows = await knex('plans as p')
      .join('users as u', 'u.id', 'p.user_id')
      .where({ 'p.year': year, 'p.month': month })
      .where('u.is_active', true)
      .modify(qb => { if (visible !== null) qb.whereIn('p.user_id', visible); })
      .select('p.*', 'u.first_name', 'u.last_name', 'u.email');

    const managers = await Promise.all(rows.map(async p => {
      const fact = await getFact(p.user_id, year, month);
      const progress = buildProgress(p, fact);
      return {
        user_id: p.user_id,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
        plan: { target_revenue: p.target_revenue, target_won: p.target_won, target_new_requests: p.target_new_requests },
        fact: { revenue: fact.revenue, won: fact.won, new_requests: fact.new_requests },
        progress,
        percent_plan: pct(fact.revenue, p.target_revenue),
      };
    }));

    managers.sort((a, b) => (b.percent_plan ?? -1) - (a.percent_plan ?? -1));
    res.json({ year, month, managers });
  } catch (err) {
    console.error('[plans/progress]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────

const PlanSchema = z.object({
  user_id:              z.string().uuid(),
  year:                 z.number().int().min(2020).max(2100),
  month:                z.number().int().min(1).max(12),
  target_revenue:       z.number().min(0).optional().default(0),
  target_won:           z.number().int().min(0).optional().default(0),
  target_new_requests:  z.number().int().min(0).optional().default(0),
  target_kp_sent:       z.number().int().min(0).optional().default(0),
  target_activities:    z.number().int().min(0).optional().default(0),
  target_calls:         z.number().int().min(0).optional().default(0),
  target_meetings:      z.number().int().min(0).optional().default(0),
  target_new_companies: z.number().int().min(0).optional().default(0),
  notes:                z.string().max(2000).optional().default(''),
});

router.post('/', requireRole('admin','head'), validate(PlanSchema), async (req, res) => {
  try {
    const { user_id, year, month } = req.body;

    // head: только своя команда
    if (req.user.role === 'head') {
      const visible = await getVisibleUserIds(req.user);
      if (!visible.includes(user_id)) return res.status(403).json({ error: 'Только своя команда' });
    }

    const existing = await knex('plans').where({ user_id, year, month }).first();

    // Защита от понижения задним числом (design §11.7)
    const now = new Date();
    const isCurrentOrPast = (year < now.getFullYear()) ||
      (year === now.getFullYear() && month <= now.getMonth() + 1);

    if (existing && isCurrentOrPast && req.user.role !== 'admin') {
      for (const key of TARGET_KEYS) {
        if (req.body[key] < Number(existing[key])) {
          return res.status(403).json({
            error: `Уменьшение плана (${key}) в текущем/прошлом месяце доступно только администратору`,
          });
        }
      }
    }

    const data = {};
    for (const key of TARGET_KEYS) data[key] = req.body[key];
    data.notes = req.body.notes;

    const plan = await knex.transaction(async (trx) => {
      const [p] = await trx('plans')
        .insert({ user_id, year, month, ...data, created_by: req.user.id })
        .onConflict(['user_id','year','month'])
        .merge({ ...data, updated_at: trx.fn.now() })
        .returning('*');

      if (existing) {
        await trx('plan_history').insert({
          plan_id: p.id,
          old_values: JSON.stringify(existing),
          new_values: JSON.stringify(p),
          changed_by: req.user.id,
        });
      }
      return p;
    });

    await audit(req, 'plan.upsert', 'plan', plan.id, existing, plan);
    res.status(201).json(plan);
  } catch (err) {
    console.error('[plans/upsert]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /copy-month ──────────────────────────────────────────────────────────

const CopySchema = z.object({
  from_year: z.number().int(), from_month: z.number().int().min(1).max(12),
  to_year:   z.number().int(), to_month:   z.number().int().min(1).max(12),
});

router.post('/copy-month', requireRole('admin','head'), validate(CopySchema), async (req, res) => {
  try {
    const { from_year, from_month, to_year, to_month } = req.body;
    const visible = await getVisibleUserIds(req.user);

    const sources = await knex('plans')
      .where({ year: from_year, month: from_month })
      .modify(qb => { if (visible !== null) qb.whereIn('user_id', visible); });

    if (!sources.length) return res.status(404).json({ error: `В ${from_month}/${from_year} планов нет` });

    const copied = await knex.transaction(async (trx) => {
      let n = 0;
      for (const src of sources) {
        const data = {};
        for (const key of TARGET_KEYS) data[key] = src[key];
        data.notes = src.notes;
        await trx('plans')
          .insert({ user_id: src.user_id, year: to_year, month: to_month, ...data, created_by: req.user.id })
          .onConflict(['user_id','year','month'])
          .merge({ ...data, updated_at: trx.fn.now() });
        n++;
      }
      return n;
    });

    res.json({ ok: true, copied, message: `Скопировано ${copied} планов` });
  } catch (err) {
    console.error('[plans/copy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const n = await knex('plans').where({ id: req.params.id }).del();
    if (!n) return res.status(404).json({ error: 'Не найдено' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
