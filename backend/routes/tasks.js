/**
 * routes/tasks.js — Задачи и напоминания
 *
 * GET    /api/tasks?assignee_id=&company_id=&request_id=&status=&mine=true
 * GET    /api/tasks/:id
 * POST   /api/tasks
 * PUT    /api/tasks/:id
 * PATCH  /api/tasks/:id/done
 * DELETE /api/tasks/:id
 *
 * RBAC: задачу видят assignee, создатель, head команды assignee, admin.
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, getVisibleUserIds, canModify } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/auditLog.js';

const router = Router();
router.use(authenticate);

const TaskSchema = z.object({
  title:       z.string().min(1).max(500),
  description: z.string().max(5000).optional().default(''),
  company_id:  z.string().uuid().nullable().optional(),
  request_id:  z.string().uuid().nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  due_at:      z.string().nullable().optional(),
  priority:    z.enum(['high','medium','low']).optional().default('medium'),
});

// ── GET / ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { assignee_id, company_id, request_id, status, mine } = req.query;
    const qb = knex('tasks as t')
      .leftJoin('users as u', 'u.id', 't.assignee_id')
      .leftJoin('companies as c', 'c.id', 't.company_id')
      .select('t.*',
        knex.raw("(u.first_name || ' ' || u.last_name) as assignee_name"),
        'c.name as company_name')
      .orderByRaw("CASE WHEN t.status='open' THEN 0 ELSE 1 END, t.due_at NULLS LAST")
      .limit(500);

    // RBAC scope по assignee
    const visible = await getVisibleUserIds(req.user);
    if (mine === 'true') {
      qb.where('t.assignee_id', req.user.id);
    } else if (visible !== null) {
      qb.where(b => b.whereIn('t.assignee_id', visible).orWhere('t.created_by', req.user.id));
    }

    if (assignee_id) qb.where('t.assignee_id', assignee_id);
    if (company_id)  qb.where('t.company_id', company_id);
    if (request_id)  qb.where('t.request_id', request_id);
    if (status)      qb.where('t.status', status);

    res.json(await qb);
  } catch (err) {
    console.error('[tasks/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const t = await knex('tasks').where({ id: req.params.id }).first();
    if (!t) return res.status(404).json({ error: 'Не найдено' });
    const visible = await getVisibleUserIds(req.user);
    const allowed = visible === null ||
      (t.assignee_id && visible.includes(t.assignee_id)) || t.created_by === req.user.id;
    if (!allowed) return res.status(404).json({ error: 'Не найдено' });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────

router.post('/', validate(TaskSchema), async (req, res) => {
  try {
    const data = { ...req.body, created_by: req.user.id };
    if (!data.assignee_id) data.assignee_id = req.user.id;

    // manager может назначать задачу только себе
    if (req.user.role === 'manager' && data.assignee_id !== req.user.id) {
      data.assignee_id = req.user.id;
    }

    const [task] = await knex('tasks').insert(data).returning('*');

    // Уведомление, если задача назначена другому
    if (task.assignee_id && task.assignee_id !== req.user.id) {
      await knex('notifications').insert({
        user_id: task.assignee_id, type: 'task_assigned',
        title: 'Вам назначена задача', body: task.title,
        entity_type: 'task', entity_id: task.id,
      }).catch(() => {});
    }

    await audit(req, 'task.create', 'task', task.id, null, task);
    res.status(201).json(task);
  } catch (err) {
    console.error('[tasks/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', validate(TaskSchema.partial()), async (req, res) => {
  try {
    const existing = await knex('tasks').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    const canEdit = existing.created_by === req.user.id ||
      await canModify(req.user, existing.assignee_id);
    if (!canEdit) return res.status(404).json({ error: 'Не найдено' });

    const [task] = await knex('tasks').where({ id: req.params.id }).update(req.body).returning('*');
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/done', async (req, res) => {
  try {
    const existing = await knex('tasks').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    const canEdit = existing.created_by === req.user.id ||
      await canModify(req.user, existing.assignee_id);
    if (!canEdit) return res.status(404).json({ error: 'Не найдено' });

    const done = req.body.done ?? true;
    const [task] = await knex('tasks').where({ id: req.params.id })
      .update({
        status: done ? 'done' : 'open',
        completed_at: done ? knex.fn.now() : null,
      }).returning('*');
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await knex('tasks').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });
    if (existing.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Удалять может только создатель или admin' });
    }
    await knex('tasks').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
