/**
 * routes/comments.js
 *
 * GET    /api/comments?entity_type=&entity_id=
 * POST   /api/comments
 * DELETE /api/comments/:id
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

const CommentSchema = z.object({
  entity_type: z.enum(['company','request']),
  entity_id:   z.string().uuid(),
  body:        z.string().min(1).max(5000),
});

router.get('/', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type и entity_id обязательны' });

    const rows = await knex('comments as c')
      .leftJoin('users as u', 'u.id', 'c.author_id')
      .select('c.*', knex.raw("(u.first_name || ' ' || u.last_name) as author_name"))
      .where({ 'c.entity_type': entity_type, 'c.entity_id': entity_id })
      .orderBy('c.created_at', 'desc');

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', validate(CommentSchema), async (req, res) => {
  try {
    const [comment] = await knex('comments')
      .insert({ ...req.body, author_id: req.user.id })
      .returning('*');
    res.status(201).json(comment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const c = await knex('comments').where({ id: req.params.id }).first();
    if (!c) return res.status(404).json({ error: 'Не найдено' });
    if (c.author_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Можно удалять только свои комментарии' });
    }
    await knex('comments').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
