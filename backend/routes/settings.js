/**
 * routes/settings.js — Настройки AI-провайдера
 *
 * GET  /api/settings/ai
 * POST /api/settings/ai      { provider, api_key, model }
 * POST /api/settings/ai/test
 */

import { Router } from 'express';
import { z } from 'zod';
import knex from '../db/knex.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AI_PROVIDERS } from '../constants/index.js';

const router = Router();
router.use(authenticate);

router.get('/ai', requireRole('admin'), async (_req, res) => {
  try {
    const rows = await knex('ai_provider_settings').orderBy('created_at', 'desc');
    // Скрываем ключ (показываем маску)
    res.json(rows.map(r => ({ ...r, api_key: r.api_key ? '••••' + r.api_key.slice(-4) : '' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const AISchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  api_key:  z.string().min(1),
  model:    z.string().optional().default(''),
});

router.post('/ai', requireRole('admin'), validate(AISchema), async (req, res) => {
  try {
    // Деактивируем остальные, активируем новый
    await knex('ai_provider_settings').update({ is_active: false });
    const [s] = await knex('ai_provider_settings')
      .insert({ ...req.body, is_active: true })
      .returning(['id', 'provider', 'model', 'is_active', 'created_at']);
    res.status(201).json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ai/test', requireRole('admin'), async (_req, res) => {
  try {
    const s = await knex('ai_provider_settings').where({ is_active: true }).first();
    if (!s) return res.status(400).json({ error: 'AI-провайдер не настроен' });

    // Минимальный тест-запрос
    let ok = false;
    if (s.provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${s.api_key}` } });
      ok = r.ok;
    } else if (s.provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': s.api_key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: s.model||'claude-3-5-haiku-20241022', max_tokens: 5, messages: [{ role:'user', content:'hi' }] }),
      });
      ok = r.ok;
    } else if (s.provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.api_key}` },
        body: JSON.stringify({ model: s.model||'deepseek-chat', max_tokens: 5, messages: [{ role:'user', content:'hi' }] }),
      });
      ok = r.ok;
    }

    if (ok) res.json({ ok: true });
    else res.status(502).json({ error: 'Провайдер недоступен или неверный ключ' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
