/**
 * routes/audit.js
 *
 * GET /api/audit?entity_type=&entity_id=&user_id=&from=&to=
 *
 * RBAC: manager — только своё, head — команда, admin — всё.
 */

import { Router } from 'express';
import knex from '../db/knex.js';
import { authenticate, getVisibleUserIds } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { entity_type, entity_id, user_id, from, to, limit = 100 } = req.query;

    const qb = knex('audit_logs as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .select('a.*', knex.raw("(u.first_name || ' ' || u.last_name) as user_name"))
      .orderBy('a.created_at', 'desc')
      .limit(Math.min(Number(limit), 500));

    const visible = await getVisibleUserIds(req.user);
    if (visible !== null) qb.whereIn('a.user_id', visible);

    if (entity_type) qb.where('a.entity_type', entity_type);
    if (entity_id)   qb.where('a.entity_id', entity_id);
    if (user_id && (visible === null || visible.includes(user_id))) qb.where('a.user_id', user_id);
    if (from) qb.where('a.created_at', '>=', from);
    if (to)   qb.where('a.created_at', '<=', to);

    res.json(await qb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
