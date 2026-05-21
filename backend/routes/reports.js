/**
 * routes/reports.js — Аналитика
 *
 * GET /api/reports/summary?from=&to=&owner_id=
 * GET /api/reports/funnel?from=&to=&owner_id=
 * GET /api/reports/outcomes?from=&to=&owner_id=
 * GET /api/reports/team?from=&to=
 * GET /api/reports/activity?from=&to=&owner_id=
 * GET /api/reports/timeline?from=&to=&group=day|week&owner_id=
 * GET /api/reports/aging?owner_id=
 */

import { Router } from 'express';
import knex from '../db/knex.js';
import { authenticate, getVisibleUserIds } from '../middleware/auth.js';
import { REQUEST_STATUSES, REQUEST_STATUS_LABELS } from '../constants/index.js';

const router = Router();
router.use(authenticate);

function getPeriod(req) {
  const { from, to } = req.query;
  const now = new Date();
  const toDate   = to   ? new Date(to   + 'T23:59:59Z') : now;
  const fromDate = from ? new Date(from + 'T00:00:00Z') : new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

/** owner-scope с учётом query.owner_id для head/admin */
async function scope(req, col = 'owner_id') {
  const visible = await getVisibleUserIds(req.user);
  const requestedOwner = req.query.owner_id;
  return qb => {
    if (visible !== null) {
      qb.whereIn(col, visible);
      if (requestedOwner && visible.includes(requestedOwner)) qb.where(col, requestedOwner);
    } else if (requestedOwner) {
      qb.where(col, requestedOwner);
    }
  };
}

// ── summary ───────────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
  try {
    const { from, to } = getPeriod(req);
    const s = await scope(req);

    const [companies, activities, requests] = await Promise.all([
      knex('companies').count('* as cnt').whereBetween('created_at', [from, to]).modify(s).first(),
      knex('activities').select(
          knex.raw('COUNT(*) AS total'),
          knex.raw("COUNT(*) FILTER (WHERE type IN ('call_out','call_in')) AS calls"),
          knex.raw("COUNT(*) FILTER (WHERE type = 'meeting') AS meetings"),
          knex.raw("COUNT(*) FILTER (WHERE type = 'proposal') AS proposals"),
        ).whereBetween('occurred_at', [from, to]).modify(s).first(),
      knex('requests').select(
          knex.raw('COUNT(*) AS total'),
          knex.raw("COUNT(*) FILTER (WHERE status = 'handover') AS won"),
          knex.raw("COUNT(*) FILTER (WHERE status = 'closed') AS lost"),
          knex.raw("COALESCE(SUM(our_rate) FILTER (WHERE status = 'handover'), 0) AS revenue"),
          knex.raw("COALESCE(AVG(margin_percent) FILTER (WHERE status = 'handover'), 0) AS avg_margin"),
        ).whereBetween('created_at', [from, to]).modify(s).first(),
    ]);

    const won = Number(requests.won), lost = Number(requests.lost);
    const resolved = won + lost;

    res.json({
      period: { from, to },
      companies: Number(companies.cnt),
      activities: {
        total: Number(activities.total), calls: Number(activities.calls),
        meetings: Number(activities.meetings), proposals: Number(activities.proposals),
      },
      requests: {
        total: Number(requests.total), won, lost,
        revenue: Number(requests.revenue),
        avg_margin: Math.round(Number(requests.avg_margin) * 10) / 10,
        conversion: resolved > 0 ? Math.round(won / resolved * 100) : 0,
      },
    });
  } catch (err) {
    console.error('[reports/summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── funnel ───────────────────────────────────────────────────────────────────

router.get('/funnel', async (req, res) => {
  try {
    const { from, to } = getPeriod(req);
    const s = await scope(req);

    const rows = await knex('requests')
      .select('status', knex.raw('COUNT(*) AS cnt'))
      .whereBetween('created_at', [from, to]).modify(s).groupBy('status');

    const byStatus = Object.fromEntries(rows.map(r => [r.status, Number(r.cnt)]));
    const newCount = byStatus.new || 0;
    const wonCount = byStatus.handover || 0;
    const lostCount = byStatus.closed || 0;
    const resolved = wonCount + lostCount;

    const stages = REQUEST_STATUSES.map((st, i) => {
      const count = byStatus[st] || 0;
      const next = REQUEST_STATUSES[i+1] ? (byStatus[REQUEST_STATUSES[i+1]] || 0) : null;
      return {
        status: st, label: REQUEST_STATUS_LABELS[st], count,
        conversion_to_next: (next !== null && count > 0) ? Math.round(next / count * 1000)/10 : null,
      };
    });

    res.json({
      total_entries: newCount,
      win_rate:   newCount  > 0 ? Math.round(wonCount / newCount * 1000)/10 : 0,
      close_rate: resolved  > 0 ? Math.round(wonCount / resolved * 1000)/10 : 0,
      stages,
    });
  } catch (err) {
    console.error('[reports/funnel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── outcomes ──────────────────────────────────────────────────────────────────

router.get('/outcomes', async (req, res) => {
  try {
    const { from, to } = getPeriod(req);
    const s = await scope(req, 'r.owner_id');

    const rows = await knex('requests as r')
      .leftJoin('close_reasons as cr', 'cr.id', 'r.close_reason_id')
      .select(
        knex.raw("COALESCE(cr.label, 'Передан в договоры') AS label"),
        knex.raw("COALESCE(cr.code, 'handover') AS code"),
        knex.raw('COUNT(*) AS cnt'),
      )
      .whereBetween('r.created_at', [from, to])
      .whereIn('r.status', ['handover', 'closed'])
      .modify(s)
      .groupByRaw('cr.label, cr.code')
      .orderByRaw('cnt DESC');

    res.json(rows.map(r => ({ label: r.label, code: r.code, count: Number(r.cnt) })));
  } catch (err) {
    console.error('[reports/outcomes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── team ──────────────────────────────────────────────────────────────────────

router.get('/team', async (req, res) => {
  try {
    if (!['admin','head'].includes(req.user.role)) return res.status(403).json({ error: 'Недостаточно прав' });
    const { from, to } = getPeriod(req);
    const visible = await getVisibleUserIds(req.user);

    const rows = await knex('users as u')
      .select('u.id','u.first_name','u.last_name','u.email',
        knex.raw('COUNT(DISTINCT r.id) AS requests_total'),
        knex.raw("COUNT(DISTINCT r.id) FILTER (WHERE r.status='handover') AS won"),
        knex.raw("COALESCE(SUM(r.our_rate) FILTER (WHERE r.status='handover'),0) AS revenue"),
        knex.raw('COUNT(DISTINCT a.id) AS activities'),
        knex.raw("COUNT(DISTINCT a.id) FILTER (WHERE a.type IN ('call_out','call_in')) AS calls"),
        knex.raw('COUNT(DISTINCT c.id) AS companies'),
      )
      .leftJoin(knex.raw('requests r ON r.owner_id = u.id AND r.created_at BETWEEN ? AND ?', [from, to]))
      .leftJoin(knex.raw('activities a ON a.owner_id = u.id AND a.occurred_at BETWEEN ? AND ?', [from, to]))
      .leftJoin(knex.raw('companies c ON c.owner_id = u.id AND c.created_at BETWEEN ? AND ?', [from, to]))
      .where('u.is_active', true)
      .modify(qb => { if (visible !== null) qb.whereIn('u.id', visible); })
      .groupBy('u.id','u.first_name','u.last_name','u.email')
      .orderByRaw('revenue DESC, won DESC');

    res.json(rows.map(r => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email,
      requests_total: Number(r.requests_total),
      won: Number(r.won),
      revenue: Number(r.revenue),
      activities: Number(r.activities),
      calls: Number(r.calls),
      companies: Number(r.companies),
      conversion: r.requests_total > 0 ? Math.round(r.won / r.requests_total * 100) : 0,
    })));
  } catch (err) {
    console.error('[reports/team]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── activity ──────────────────────────────────────────────────────────────────

router.get('/activity', async (req, res) => {
  try {
    const { from, to } = getPeriod(req);
    const s = await scope(req);
    const rows = await knex('activities')
      .select('type', knex.raw('COUNT(*) AS cnt'))
      .whereBetween('occurred_at', [from, to]).modify(s)
      .groupBy('type').orderByRaw('cnt DESC');
    res.json(rows.map(r => ({ type: r.type, count: Number(r.cnt) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── timeline ──────────────────────────────────────────────────────────────────

router.get('/timeline', async (req, res) => {
  try {
    const { from, to } = getPeriod(req);
    const group = ['day','week'].includes(req.query.group) ? req.query.group : 'day';
    const s = await scope(req);

    const rows = await knex('activities')
      .select(
        knex.raw(`DATE_TRUNC('${group}', occurred_at)::date AS period`),
        knex.raw('COUNT(*) AS total'),
        knex.raw("COUNT(*) FILTER (WHERE type IN ('call_out','call_in')) AS calls"),
        knex.raw("COUNT(*) FILTER (WHERE type = 'meeting') AS meetings"),
      )
      .whereBetween('occurred_at', [from, to]).modify(s)
      .groupByRaw(`DATE_TRUNC('${group}', occurred_at)::date`)
      .orderByRaw('period');

    res.json(rows.map(r => ({
      period: r.period, total: Number(r.total),
      calls: Number(r.calls), meetings: Number(r.meetings),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── aging (запросы без движения) ────────────────────────────────────────────

router.get('/aging', async (req, res) => {
  try {
    const s = await scope(req);
    const rows = await knex('requests as r')
      .leftJoin('companies as c', 'c.id', 'r.company_id')
      .leftJoin('users as u', 'u.id', 'r.owner_id')
      .select('r.id','r.status','r.route_from','r.route_to','r.updated_at',
        'c.name as company_name',
        knex.raw("(u.first_name || ' ' || u.last_name) as owner_name"),
        knex.raw("EXTRACT(DAY FROM NOW() - r.updated_at)::int AS days_idle"))
      .whereIn('r.status', ['new','in_progress','kp_sent','negotiation'])
      .whereRaw('r.updated_at < NOW() - INTERVAL \'3 days\'')
      .modify(s)
      .orderByRaw('days_idle DESC')
      .limit(100);

    res.json(rows.map(r => ({ ...r, days_idle: Number(r.days_idle) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
