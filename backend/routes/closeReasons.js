/**
 * routes/closeReasons.js — Справочник причин закрытия
 *
 * GET    /api/close-reasons
 * POST   /api/close-reasons       (admin)
 * PUT    /api/close-reasons/:id    (admin)
 * DELETE /api/close-reasons/:id    (admin)
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

router.get('/', async (_req, res) => {
  try {
    const rows = await knex('close_reasons').where({ is_active: true }).orderBy('sort_order');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ReasonSchema = z.object({
  code:             z.string().min(1).max(100),
  label:            z.string().min(1).max(255),
  category:         z.enum(['pre_kp','post_kp','technical','other']),
  is_loss:          z.boolean().default(true),
  requires_comment: z.boolean().default(false),
  sort_order:       z.number().int().default(0),
});

router.post('/', requireRole('admin'), validate(ReasonSchema), async (req, res) => {
  try {
    const [r] = await knex('close_reasons').insert(req.body).returning('*');
    res.status(201).json(r);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Код уже существует' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireRole('admin'), validate(ReasonSchema.partial()), async (req, res) => {
  try {
    const [r] = await knex('close_reasons').where({ id: req.params.id }).update(req.body).returning('*');
    if (!r) return res.status(404).json({ error: 'Не найдено' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    // soft-delete: не удаляем, чтобы сохранить ссылки в requests
    await knex('close_reasons').where({ id: req.params.id }).update({ is_active: false });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
