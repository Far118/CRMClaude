/**
 * routes/auth.js
 *
 * POST /api/auth/login         { email, password }
 * POST /api/auth/logout
 * GET  /api/auth/me
 * POST /api/auth/change-password { old_password, new_password }
 */

import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import knex from '../db/knex.js';
import { config } from '../config.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', validate(LoginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await knex('users').where({ email: email.toLowerCase() }).first();

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Неверные учётные данные' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Неверные учётные данные' });
    }

    const token = jwt.sign({ sub: user.id }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    res.cookie(config.jwt.cookieName, token, {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000, // 8h
    });

    await knex('users').where({ id: user.id }).update({ last_login_at: knex.fn.now() });

    res.json({
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      team_id: user.team_id,
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.jwt.cookieName);
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  res.json(req.user);
});

const ChangePasswordSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8),
});

router.post('/change-password', authenticate, validate(ChangePasswordSchema), async (req, res) => {
  try {
    const user = await knex('users').where({ id: req.user.id }).first();
    const ok = await bcrypt.compare(req.body.old_password, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Неверный текущий пароль' });

    const hash = await bcrypt.hash(req.body.new_password, config.bcryptRounds);
    await knex('users').where({ id: user.id }).update({ password_hash: hash });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
