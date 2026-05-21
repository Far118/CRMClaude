/**
 * routes/companies.js
 *
 * GET    /api/companies
 * GET    /api/companies/:id
 * GET    /api/companies/:id/history
 * POST   /api/companies
 * PUT    /api/companies/:id
 * POST   /api/companies/:id/reassign  (head/admin)
 * DELETE /api/companies/:id           (admin only)
 *
 * RBAC: см. design §4. Чужие компании → 404 (anti-IDOR).
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import {
  authenticate, requireRole, applyOwnerScope, getVisibleUserIds, canModify,
} from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../services/auditLog.js';
import { COMPANY_PRIORITIES } from '../constants/index.js';

const router = Router();
router.use(authenticate);

const StringArr = z.array(z.string()).default([]);

const CompanySchema = z.object({
  name:             z.string().min(1).max(255),
  inn:              z.string().max(15).optional().default(''),
  kpp:              z.string().max(15).optional().default(''),
  ogrn:             z.string().max(20).optional().default(''),
  legal_address:    z.string().max(500).optional().default(''),
  actual_address:   z.string().max(500).optional().default(''),
  website:          z.string().max(255).optional().default(''),
  industry:         z.string().max(255).optional().default(''),
  priority:         z.enum(COMPANY_PRIORITIES).optional().default('medium'),
  regions:          StringArr,
  cargo_types:      StringArr,
  transport_modes:  StringArr,
  tags:             StringArr,
  phone_main:       z.string().max(50).optional().default(''),
  email_main:       z.string().max(255).optional().default(''),
  next_action_at:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  next_action_type: z.string().max(100).optional().default(''),
  annual_revenue:   z.number().min(0).nullable().optional(),
  notes:            z.string().max(5000).optional().default(''),
  source:           z.string().max(100).optional().default(''),
  owner_id:         z.string().uuid().nullable().optional(),
});

const UpdateCompanySchema = CompanySchema.partial();

// ── GET / ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { status, owner_id, priority, q, limit = 500, offset = 0 } = req.query;

    const qb = knex('companies as c')
      .leftJoin('users as u', 'u.id', 'c.owner_id')
      .select('c.*', knex.raw("(u.first_name || ' ' || u.last_name) as owner_name"))
      .orderBy('c.updated_at', 'desc')
      .limit(Math.min(Number(limit), 1000))
      .offset(Number(offset));

    await applyOwnerScope(qb, req.user, 'c.owner_id');

    if (status)   qb.where('c.calculated_status', status);
    if (priority) qb.where('c.priority', priority);
    if (owner_id) {
      const visible = await getVisibleUserIds(req.user);
      if (visible === null || visible.includes(owner_id)) qb.where('c.owner_id', owner_id);
    }
    if (q) {
      const search = `%${q}%`;
      qb.where(b => b
        .whereILike('c.name', search)
        .orWhereILike('c.inn', search)
        .orWhereILike('c.email_main', search)
        .orWhereILike('c.phone_main', search)
      );
    }

    res.json(await qb);
  } catch (err) {
    console.error('[companies/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const company = await knex('companies as c')
      .leftJoin('users as u', 'u.id', 'c.owner_id')
      .select('c.*', knex.raw("(u.first_name || ' ' || u.last_name) as owner_name"))
      .where('c.id', req.params.id)
      .first();

    if (!company) return res.status(404).json({ error: 'Не найдено' });

    const visible = await getVisibleUserIds(req.user);
    if (visible !== null && company.owner_id && !visible.includes(company.owner_id)) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    res.json(company);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/history', async (req, res) => {
  try {
    const company = await knex('companies').where({ id: req.params.id }).first();
    if (!company) return res.status(404).json({ error: 'Не найдено' });

    const visible = await getVisibleUserIds(req.user);
    if (visible !== null && company.owner_id && !visible.includes(company.owner_id)) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    const rows = await knex('company_status_history as h')
      .leftJoin('users as u', 'u.id', 'h.changed_by')
      .select('h.*', knex.raw("(u.first_name || ' ' || u.last_name) as changed_by_name"))
      .where('h.company_id', req.params.id)
      .orderBy('h.changed_at', 'desc');

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────

router.post('/', validate(CompanySchema), async (req, res) => {
  try {
    const data = { ...req.body };
    // По умолчанию owner = current user; manager не может назначать других
    if (req.user.role === 'manager' || !data.owner_id) {
      data.owner_id = req.user.id;
    } else if (req.user.role === 'head') {
      const visible = await getVisibleUserIds(req.user);
      if (!visible.includes(data.owner_id)) data.owner_id = req.user.id;
    }

    // JSONB → строка для PG
    for (const k of ['regions','cargo_types','transport_modes','tags']) {
      if (data[k]) data[k] = JSON.stringify(data[k]);
    }

    const [company] = await knex('companies').insert(data).returning('*');
    await audit(req, 'company.create', 'company', company.id, null, company);
    res.status(201).json(company);
  } catch (err) {
    console.error('[companies/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────

router.put('/:id', validate(UpdateCompanySchema), async (req, res) => {
  try {
    const existing = await knex('companies').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });

    if (!await canModify(req.user, existing.owner_id)) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    const data = { ...req.body };
    // manager не может переназначать ownera
    if (req.user.role === 'manager' && data.owner_id && data.owner_id !== existing.owner_id) {
      delete data.owner_id;
    }
    for (const k of ['regions','cargo_types','transport_modes','tags']) {
      if (data[k]) data[k] = JSON.stringify(data[k]);
    }

    const [company] = await knex('companies').where({ id: req.params.id }).update(data).returning('*');
    await audit(req, 'company.update', 'company', company.id, existing, company);
    res.json(company);
  } catch (err) {
    console.error('[companies/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /:id/reassign ────────────────────────────────────────────────────────

const ReassignSchema = z.object({ owner_id: z.string().uuid() });

router.post('/:id/reassign', requireRole('admin','head'), validate(ReassignSchema), async (req, res) => {
  try {
    const existing = await knex('companies').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });

    // head: оба ownerа должны быть в его команде
    if (req.user.role === 'head') {
      const visible = await getVisibleUserIds(req.user);
      if (!visible.includes(existing.owner_id) || !visible.includes(req.body.owner_id)) {
        return res.status(403).json({ error: 'Можно переназначать только внутри команды' });
      }
    }

    await knex('companies').where({ id: req.params.id }).update({ owner_id: req.body.owner_id });
    await audit(req, 'company.reassign', 'company', req.params.id, { owner_id: existing.owner_id }, { owner_id: req.body.owner_id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const requests = await knex('requests').where({ company_id: req.params.id }).count('* as cnt').first();
    if (Number(requests.cnt) > 0) {
      return res.status(409).json({ error: 'Нельзя удалить компанию с запросами' });
    }

    const existing = await knex('companies').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Не найдено' });

    await knex('companies').where({ id: req.params.id }).del();
    await audit(req, 'company.delete', 'company', req.params.id, existing, null);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
