/**
 * routes/activities.js
 *
 * GET    /api/activities?company_id=&request_id=&mine=true&type=
 * GET    /api/activities/:id
 * POST   /api/activities
 * PUT    /api/activities/:id
 * PATCH  /api/activities/:id/done
 * DELETE /api/activities/:id
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, applyOwnerScope, getVisibleUserIds, canModify } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ACTIVITY_TYPES } from '../constants/index.js';

const router = Router();
router.use(authenticate);

const ActivitySchema = z.object({
  company_id:    z.string().uuid().nullable().optional(),
  contact_id:    z.string().uuid().nullable().optional(),
  request_id:    z.string().uuid().nullable().optional(),
  type:          z.enum(ACTIVITY_TYPES),
  occurred_at:   z.string().optional(),
  description:   z.string().max(5000).optional().default(''),
  outcome:       z.string().max(2000).optional().default(''),
  next_step:     z.string().max(1000).optional().default(''),
  next_step_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  is_done:       z.boolean().optional().default(false),
});

router.get('/', async (req, res) => {
  try {
    const { company_id, request_id, type, mine } = req.query;
    const qb = knex('activities as a')
      .leftJoin('companies as c', 'c.id', 'a.company_id')
      .leftJoin('users as u', 'u.id', 'a.owner_id')
      .select('a.*', 'c.name as company_name', knex.raw("(u.first_name || ' ' || u.last_name) as owner_name"))
      .orderBy('a.occurred_at', 'desc')
      .limit(500);

    if (mine === 'true') {
      qb.where('a.owner_id', req.user.id);
    } else {
      await applyOwnerScope(qb, req.user, 'a.owner_id');
    }
    if (company_id) qb.where('a.company_id', company_id);
    if (request_id) qb.where('a.request_id', request_id);
    if (type)       qb.where('a.type', type);

    res.json(await qb);
  } catch (err) {
    console.error('[activities/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const a = await knex('activities').where({ id: req.params.id }).first();
    if (!a) return res.status(404).json({ error: 'Не найдено' });
    const visible = await getVisibleUserIds(req.user);
    if (visible !== null && a.owner_id && !visible.includes(a.owner_id)) return res.status(404).json({ error: 'Не найдено' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', validate(ActivitySchema), async (req, res) => {
  try {
    const data = { ...req.body, owner_id: req.user.id };
    if (!data.occurred_at) data.occurred_at = knex.fn.now();
    const [a] = await knex('activities').insert(data).returning('*');
    res.status(201).json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', validate(ActivitySchema.partial()), async (req, res) => {
  try {
    const existing = await knex('activities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, existing.owner_id)) return res.status(404).json({ error: 'Не найдено' });
    const [a] = await knex('activities').where({ id: req.params.id }).update(req.body).returning('*');
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/done', async (req, res) => {
  try {
    const existing = await knex('activities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, existing.owner_id)) return res.status(404).json({ error: 'Не найдено' });
    const [a] = await knex('activities').where({ id: req.params.id })
      .update({ is_done: req.body.is_done ?? true }).returning('*');
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await knex('activities').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, existing.owner_id)) return res.status(404).json({ error: 'Не найдено' });
    await knex('activities').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
