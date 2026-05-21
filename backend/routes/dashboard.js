/**
 * routes/dashboard.js
 *
 * GET /api/dashboard/funnel?year=&month=
 * GET /api/dashboard/staff?year=&month=   (head/admin)
 */

import { Router } from 'express';
import knex from '../db/knex.js';
import { authenticate, getVisibleUserIds } from '../middleware/auth.js';
import { REQUEST_STATUSES, REQUEST_STATUS_LABELS } from '../constants/index.js';

const router = Router();
router.use(authenticate);

function ym(query) {
  const now = new Date();
  return {
    year:  parseInt(query.year)  || now.getFullYear(),
    month: parseInt(query.month) || now.getMonth() + 1,
  };
}

router.get('/funnel', async (req, res) => {
  try {
    const { year, month } = ym(req.query);
    const visible = await getVisibleUserIds(req.user);

    const rows = await knex('requests')
      .select('status', knex.raw('COUNT(*) AS cnt'))
      .whereRaw('EXTRACT(YEAR  FROM created_at) = ?', [year])
      .whereRaw('EXTRACT(MONTH FROM created_at) = ?', [month])
      .modify(qb => { if (visible !== null) qb.whereIn('owner_id', visible); })
      .groupBy('status');

    const byStatus = Object.fromEntries(rows.map(r => [r.status, Number(r.cnt)]));
    const funnel = REQUEST_STATUSES.map(s => ({
      status: s, label: REQUEST_STATUS_LABELS[s], count: byStatus[s] || 0,
    }));

    const newCount = byStatus.new || 0;
    const wonCount = byStatus.handover || 0;
    const conversion = newCount > 0 ? Math.round(wonCount / newCount * 1000) / 10 : 0;

    res.json({ period: { year, month }, funnel, conversion });
  } catch (err) {
    console.error('[dashboard/funnel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/staff', async (req, res) => {
  try {
    if (!['admin','head'].includes(req.user.role)) return res.json([]);
    const { year, month } = ym(req.query);
    const visible = await getVisibleUserIds(req.user);

    const plans = await knex('plans as p')
      .join('users as u', 'u.id', 'p.user_id')
      .where({ 'p.year': year, 'p.month': month })
      .where('u.is_active', true)
      .modify(qb => { if (visible !== null) qb.whereIn('p.user_id', visible); })
      .select('p.user_id', 'p.target_revenue', 'p.target_won',
        knex.raw("(u.first_name || ' ' || u.last_name) AS full_name"));

    if (!plans.length) return res.json([]);

    const [totals, wons] = await Promise.all([
      knex('requests').select('owner_id').count('id as total')
        .whereRaw('EXTRACT(YEAR FROM created_at) = ?', [year])
        .whereRaw('EXTRACT(MONTH FROM created_at) = ?', [month])
        .whereNotNull('owner_id').groupBy('owner_id'),
      knex('requests').select('owner_id').count('id as won').sum('our_rate as revenue')
        .whereRaw('EXTRACT(YEAR FROM created_at) = ?', [year])
        .whereRaw('EXTRACT(MONTH FROM created_at) = ?', [month])
        .where('status', 'handover').whereNotNull('owner_id').groupBy('owner_id'),
    ]);

    const map = {};
    for (const r of totals) map[r.owner_id] = { total: Number(r.total) };
    for (const r of wons) {
      map[r.owner_id] = map[r.owner_id] || { total: 0 };
      map[r.owner_id].won = Number(r.won);
      map[r.owner_id].revenue = Number(r.revenue) || 0;
    }

    const result = plans.map(p => {
      const f = map[p.user_id] || {};
      const planAmount = Number(p.target_revenue) || 0;
      const factAmount = f.revenue || 0;
      return {
        user_id: p.user_id,
        full_name: p.full_name,
        plan_amount: planAmount,
        fact_amount: factAmount,
        plan_won: Number(p.target_won) || 0,
        fact_won: f.won || 0,
        total_requests: f.total || 0,
        conversion: f.total > 0 ? Math.round((f.won||0) / f.total * 1000) / 10 : 0,
        percent_plan: planAmount > 0 ? Math.round(factAmount / planAmount * 1000) / 10 : null,
      };
    }).sort((a,b) => (b.percent_plan ?? -1) - (a.percent_plan ?? -1));

    res.json(result);
  } catch (err) {
    console.error('[dashboard/staff]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
