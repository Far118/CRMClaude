/**
 * routes/lookup.js — Справочники для фронтенда.
 *
 * GET /api/lookup — все enum-значения + labels + цвета.
 *
 * Фронтенд вызывает один раз при инициализации (ui.js / const.js).
 */

import { Router } from 'express';
import knex from '../db/knex.js';
import { authenticate } from '../middleware/auth.js';
import * as C from '../constants/index.js';

const router = Router();
router.use(authenticate);

router.get('/', async (_req, res) => {
  try {
    const closeReasons = await knex('close_reasons')
      .where({ is_active: true })
      .orderBy('sort_order')
      .select('id', 'code', 'label', 'category', 'is_loss', 'requires_comment');

    res.json({
      company_statuses:        C.COMPANY_STATUSES,
      company_status_labels:   C.COMPANY_STATUS_LABELS,
      company_status_colors:   C.COMPANY_STATUS_COLORS,
      company_priorities:      C.COMPANY_PRIORITIES,
      company_priority_labels: C.COMPANY_PRIORITY_LABELS,

      request_statuses:        C.REQUEST_STATUSES,
      request_status_labels:   C.REQUEST_STATUS_LABELS,
      request_status_colors:   C.REQUEST_STATUS_COLORS,
      allowed_transitions:     C.ALLOWED_TRANSITIONS,
      active_statuses:         C.ACTIVE_STATUSES,

      transport_types:         C.TRANSPORT_TYPES,
      transport_type_labels:   C.TRANSPORT_TYPE_LABELS,
      cargo_types:             C.CARGO_TYPES,
      cargo_type_labels:       C.CARGO_TYPE_LABELS,
      currencies:              C.CURRENCIES,
      incoterms:               C.INCOTERMS,

      activity_types:          C.ACTIVITY_TYPES,
      activity_type_labels:    C.ACTIVITY_TYPE_LABELS,

      user_roles:              C.USER_ROLES,
      user_role_labels:        C.USER_ROLE_LABELS,

      plan_fields:             C.PLAN_FIELDS,
      plan_fact_keys:          C.PLAN_FACT_KEYS,

      close_reasons:           closeReasons,
    });
  } catch (err) {
    console.error('[lookup]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
