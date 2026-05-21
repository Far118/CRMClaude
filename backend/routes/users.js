/**
 * routes/users.js
 *
 * GET    /api/users
 * GET    /api/users/:id
 * POST   /api/users                    (admin)
 * PUT    /api/users/:id                (admin)
 * POST   /api/users/:id/deactivate     (admin) — с обязательным transfer_to
 *
 * GET    /api/teams
 * POST   /api/teams                    (admin)
 * PUT    /api/teams/:id                (admin)
 */

import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import knex from '../db/knex.js';
import { config } from '../config.js';
import { authenticate, requireRole, getVisibleUserIds } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/auditLog.js';
import { USER_ROLES } from '../constants/index.js';

const router = Router();
router.use(authenticate);

// ── Users ─────────────────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  try {
    const visible = await getVisibleUserIds(req.user);
    const qb = knex('users as u')
      .leftJoin('teams as t', 't.id', 'u.team_id')
      .select('u.id','u.email','u.first_name','u.last_name','u.role','u.team_id','u.phone','u.is_active','u.last_login_at','u.created_at', 't.name as team_name')
      .orderBy('u.first_name');

    if (visible !== null) qb.whereIn('u.id', visible);

    res.json(await qb);
  } catch (err) {
    console.error('[users/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const visible = await getVisibleUserIds(req.user);
    const qb = knex('users').where({ id: req.params.id }).first();
    if (visible !== null && !visible.includes(req.params.id)) {
      return res.status(404).json({ error: 'Не найдено' });
    }
    const user = await qb;
    if (!user) return res.status(404).json({ error: 'Не найдено' });

    const { password_hash, ...safe } = user;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const CreateUserSchema = z.object({
  email:      z.string().email(),
  password:   z.string().min(8),
  first_name: z.string().max(100).default(''),
  last_name:  z.string().max(100).default(''),
  role:       z.enum(USER_ROLES),
  team_id:    z.string().uuid().nullable().optional(),
  phone:      z.string().max(50).optional().default(''),
});

router.post('/users', requireRole('admin'), validate(CreateUserSchema), async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.body.password, config.bcryptRounds);
    const { password, ...rest } = req.body;
    const [user] = await knex('users')
      .insert({ ...rest, email: rest.email.toLowerCase(), password_hash: hash })
      .returning(['id','email','first_name','last_name','role','team_id','is_active']);
    await audit(req, 'user.create', 'user', user.id, null, user);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email уже занят' });
    console.error('[users/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const UpdateUserSchema = z.object({
  first_name: z.string().max(100).optional(),
  last_name:  z.string().max(100).optional(),
  role:       z.enum(USER_ROLES).optional(),
  team_id:    z.string().uuid().nullable().optional(),
  phone:      z.string().max(50).optional(),
  is_active:  z.boolean().optional(),
  password:   z.string().min(8).optional(),
}).partial();

router.put('/users/:id', requireRole('admin'), validate(UpdateUserSchema), async (req, res) => {
  try {
    const existing = await knex('users').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });

    const updates = { ...req.body };
    if (updates.password) {
      updates.password_hash = await bcrypt.hash(updates.password, config.bcryptRounds);
      delete updates.password;
    }

    const [user] = await knex('users').where({ id: req.params.id }).update(updates).returning(['id','email','first_name','last_name','role','team_id','is_active']);
    await audit(req, 'user.update', 'user', user.id, existing, user);
    res.json(user);
  } catch (err) {
    console.error('[users/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Деактивация с обязательным transfer.
 * Все компании, запросы и активности переходят к transfer_to_user_id.
 */
const DeactivateSchema = z.object({
  transfer_to_user_id: z.string().uuid(),
});

router.post('/users/:id/deactivate', requireRole('admin'), validate(DeactivateSchema), async (req, res) => {
  try {
    const { transfer_to_user_id } = req.body;
    const userId = req.params.id;

    if (userId === transfer_to_user_id) {
      return res.status(400).json({ error: 'Нельзя передавать самому себе' });
    }

    const [user, target] = await Promise.all([
      knex('users').where({ id: userId }).first(),
      knex('users').where({ id: transfer_to_user_id, is_active: true }).first(),
    ]);

    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!target) return res.status(400).json({ error: 'Получатель не найден или неактивен' });

    await knex.transaction(async (trx) => {
      const moved = {};
      for (const table of ['companies', 'requests', 'activities']) {
        const r = await trx(table).where({ owner_id: userId }).update({ owner_id: transfer_to_user_id });
        moved[table] = r;
      }
      await trx('users').where({ id: userId }).update({ is_active: false });
      await audit(req, 'user.deactivate', 'user', userId, null, { transfer_to: transfer_to_user_id, moved });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[users/deactivate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Teams ─────────────────────────────────────────────────────────────────────

router.get('/teams', async (_req, res) => {
  try {
    const rows = await knex('teams as t')
      .leftJoin('users as u', 'u.id', 't.head_id')
      .select('t.id','t.name','t.head_id','t.is_active','t.created_at',
        knex.raw("(u.first_name || ' ' || u.last_name) as head_name"))
      .where('t.is_active', true)
      .orderBy('t.name');

    // Добавим список менеджеров команды
    for (const t of rows) {
      t.members = await knex('users').where({ team_id: t.id, is_active: true })
        .select('id','first_name','last_name','email','role');
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const TeamSchema = z.object({
  name:          z.string().min(1).max(100),
  head_id:       z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
});

router.post('/teams', requireRole('admin'), validate(TeamSchema), async (req, res) => {
  try {
    const [team] = await knex('teams').insert(req.body).returning('*');
    await audit(req, 'team.create', 'team', team.id, null, team);
    res.status(201).json(team);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/teams/:id', requireRole('admin'), validate(TeamSchema.partial()), async (req, res) => {
  try {
    const [team] = await knex('teams').where({ id: req.params.id }).update(req.body).returning('*');
    if (!team) return res.status(404).json({ error: 'Не найдено' });
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Departments ─────────────────────────────────────────────────────────────

router.get('/departments', async (_req, res) => {
  try {
    const rows = await knex('departments as d')
      .where('d.is_active', true)
      .orderBy('d.name')
      .select('d.*');
    for (const d of rows) {
      d.teams = await knex('teams').where({ department_id: d.id, is_active: true })
        .select('id', 'name', 'head_id');
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const DepartmentSchema = z.object({ name: z.string().min(1).max(100) });

router.post('/departments', requireRole('admin'), validate(DepartmentSchema), async (req, res) => {
  try {
    const [dep] = await knex('departments').insert(req.body).returning('*');
    await audit(req, 'department.create', 'department', dep.id, null, dep);
    res.status(201).json(dep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/departments/:id', requireRole('admin'), validate(DepartmentSchema.partial()), async (req, res) => {
  try {
    const [dep] = await knex('departments').where({ id: req.params.id }).update(req.body).returning('*');
    if (!dep) return res.status(404).json({ error: 'Не найдено' });
    res.json(dep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/departments/:id', requireRole('admin'), async (req, res) => {
  try {
    // soft-delete, чтобы не потерять связи команд
    await knex('departments').where({ id: req.params.id }).update({ is_active: false });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
