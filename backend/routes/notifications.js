/**
 * routes/notifications.js
 *
 * GET    /api/notifications?unread=true
 * PATCH  /api/notifications/:id/read
 * POST   /api/notifications/read-all
 * GET    /api/notifications/vapid-key
 * POST   /api/notifications/subscribe
 * DELETE /api/notifications/subscribe
 * GET    /api/notifications/status?endpoint=
 */

import { Router } from 'express';
import knex from '../db/knex.js';
import { config } from '../config.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const qb = knex('notifications')
      .where({ user_id: req.user.id })
      .orderBy('created_at', 'desc')
      .limit(50);
    if (req.query.unread === 'true') qb.where({ is_read: false });
    res.json(await qb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    await knex('notifications').where({ id: req.params.id, user_id: req.user.id }).update({ is_read: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    await knex('notifications').where({ user_id: req.user.id, is_read: false }).update({ is_read: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/vapid-key', (_req, res) => {
  res.json({ publicKey: config.vapid.publicKey });
});

router.post('/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys) return res.status(400).json({ error: 'Некорректная подписка' });
    await knex('push_subscriptions')
      .insert({ user_id: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth })
      .onConflict('endpoint')
      .merge({ user_id: req.user.id, p256dh: keys.p256dh, auth: keys.auth });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/subscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    await knex('push_subscriptions').where({ endpoint }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const sub = await knex('push_subscriptions')
      .where({ endpoint: req.query.endpoint, user_id: req.user.id }).first();
    res.json({ subscribed: !!sub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
