/**
 * routes/attachments.js
 *
 * GET    /api/requests/:requestId/attachments
 * POST   /api/requests/:requestId/attachments  (multipart/form-data)
 * DELETE /api/requests/:requestId/attachments/:id
 *
 * Вложения привязаны к запросу (КП, переписка, скан договора).
 * Доступ наследуется от запроса (RBAC).
 */

import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import knex from '../db/knex.js';
import { config } from '../config.js';
import { authenticate, getVisibleUserIds, canModify } from '../middleware/auth.js';

const router = Router({ mergeParams: true });
router.use(authenticate);

const UPLOAD = join(process.cwd(), config.upload.dir, 'attachments');
const MAX_SIZE = config.upload.maxSizeMB * 1024 * 1024;
// Разрешённые типы для КП и переписки
const ALLOWED_EXTS = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.zip'];
mkdirSync(UPLOAD, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD),
    filename:    (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_EXTS.includes(extname(file.originalname).toLowerCase())),
}).single('file');

async function getRequest(req) {
  const r = await knex('requests').where({ id: req.params.requestId }).first();
  if (!r) return null;
  const visible = await getVisibleUserIds(req.user);
  if (visible !== null && r.owner_id && !visible.includes(r.owner_id)) return null;
  return r;
}

// ── GET ───────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const r = await getRequest(req);
    if (!r) return res.status(404).json({ error: 'Запрос не найден' });

    const rows = await knex('attachments as a')
      .leftJoin('users as u', 'u.id', 'a.uploaded_by')
      .select('a.*', knex.raw("(u.first_name || ' ' || u.last_name) as uploader_name"))
      .where('a.request_id', r.id)
      .orderBy('a.created_at', 'desc');

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST (upload) ─────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Файл больше ${config.upload.maxSizeMB} МБ` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: `Разрешены: ${ALLOWED_EXTS.join(', ')}` });
    }

    try {
      const r = await getRequest(req);
      if (!r) { await unlink(req.file.path).catch(() => {}); return res.status(404).json({ error: 'Запрос не найден' }); }
      if (!await canModify(req.user, r.owner_id)) {
        await unlink(req.file.path).catch(() => {});
        return res.status(403).json({ error: 'Нет прав' });
      }
      if (r.status === 'closed') {
        await unlink(req.file.path).catch(() => {});
        return res.status(409).json({ error: 'Нельзя прикреплять файлы к закрытому запросу' });
      }

      const [att] = await knex('attachments').insert({
        request_id:  r.id,
        filename:    req.file.originalname,
        file_path:   req.file.path,
        file_size:   req.file.size,
        mime_type:   extname(req.file.originalname).toLowerCase(),
        uploaded_by: req.user.id,
      }).returning('*');

      res.status(201).json(att);
    } catch (e) {
      console.error('[attachments/upload]', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

router.delete('/:attId', async (req, res) => {
  try {
    const r = await getRequest(req);
    if (!r) return res.status(404).json({ error: 'Запрос не найден' });
    if (!await canModify(req.user, r.owner_id)) return res.status(403).json({ error: 'Нет прав' });

    const att = await knex('attachments').where({ id: req.params.attId, request_id: r.id }).first();
    if (!att) return res.status(404).json({ error: 'Вложение не найдено' });

    await unlink(att.file_path).catch(() => {});
    await knex('attachments').where({ id: att.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
