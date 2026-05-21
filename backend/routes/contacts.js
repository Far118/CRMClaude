/**
 * routes/contacts.js
 *
 * GET    /api/contacts?company_id=
 * GET    /api/contacts/:id
 * POST   /api/contacts
 * PUT    /api/contacts/:id
 * DELETE /api/contacts/:id
 *
 * Доступ наследуется от компании (owner_id компании).
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, getVisibleUserIds, canModify } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();
router.use(authenticate);

const ContactSchema = z.object({
  company_id:        z.string().uuid(),
  first_name:        z.string().max(100).optional().default(''),
  last_name:         z.string().max(100).optional().default(''),
  position:          z.string().max(150).optional().default(''),
  role:              z.string().max(100).optional().default(''),
  phone_main:        z.string().max(50).optional().default(''),
  email:             z.string().max(255).optional().default(''),
  telegram:          z.string().max(100).optional().default(''),
  whatsapp:          z.string().max(50).optional().default(''),
  preferred_channel: z.enum(['phone','email','telegram','whatsapp']).optional().default('phone'),
  notes:             z.string().max(2000).optional().default(''),
  is_primary:        z.boolean().optional().default(false),
});

async function companyVisible(req, companyId) {
  const company = await knex('companies').where({ id: companyId }).first();
  if (!company) return null;
  const visible = await getVisibleUserIds(req.user);
  if (visible !== null && company.owner_id && !visible.includes(company.owner_id)) return false;
  return company;
}

router.get('/', async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: 'company_id обязателен' });

    const company = await companyVisible(req, company_id);
    if (company === null) return res.status(404).json({ error: 'Компания не найдена' });
    if (company === false) return res.status(404).json({ error: 'Не найдено' });

    const rows = await knex('contacts').where({ company_id }).orderBy('is_primary', 'desc').orderBy('created_at');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const contact = await knex('contacts').where({ id: req.params.id }).first();
    if (!contact) return res.status(404).json({ error: 'Не найдено' });
    const company = await companyVisible(req, contact.company_id);
    if (company === false) return res.status(404).json({ error: 'Не найдено' });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', validate(ContactSchema), async (req, res) => {
  try {
    const company = await companyVisible(req, req.body.company_id);
    if (company === null) return res.status(404).json({ error: 'Компания не найдена' });
    if (company === false) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, company.owner_id)) return res.status(403).json({ error: 'Нет прав' });

    // primary uniqueness: если новый primary — снять флаг с остальных
    if (req.body.is_primary) {
      await knex('contacts').where({ company_id: req.body.company_id }).update({ is_primary: false });
    }

    const [contact] = await knex('contacts').insert(req.body).returning('*');
    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', validate(ContactSchema.partial()), async (req, res) => {
  try {
    const contact = await knex('contacts').where({ id: req.params.id }).first();
    if (!contact) return res.status(404).json({ error: 'Не найдено' });
    const company = await companyVisible(req, contact.company_id);
    if (company === false) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, company.owner_id)) return res.status(403).json({ error: 'Нет прав' });

    if (req.body.is_primary) {
      await knex('contacts').where({ company_id: contact.company_id }).update({ is_primary: false });
    }

    const [updated] = await knex('contacts').where({ id: req.params.id }).update(req.body).returning('*');
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const contact = await knex('contacts').where({ id: req.params.id }).first();
    if (!contact) return res.status(404).json({ error: 'Не найдено' });
    const company = await companyVisible(req, contact.company_id);
    if (company === false) return res.status(404).json({ error: 'Не найдено' });
    if (!await canModify(req.user, company.owner_id)) return res.status(403).json({ error: 'Нет прав' });

    await knex('contacts').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
