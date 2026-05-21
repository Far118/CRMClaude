/**
 * routes/aiReports.js — AI-анализ Excel/CSV
 *
 * GET    /api/ai-reports?mine=true
 * GET    /api/ai-reports/:id
 * POST   /api/ai-reports               (upload xlsx/csv)
 * POST   /api/ai-reports/:id/analyze   (async анализ)
 * GET    /api/ai-reports/:id/status
 * DELETE /api/ai-reports/:id
 */

import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import * as XLSX from 'xlsx';
import knex from '../db/knex.js';
import { config } from '../config.js';
import { authenticate, requireRole, getVisibleUserIds } from '../middleware/auth.js';
import { analyzeReport } from '../services/aiService.js';

const router = Router();
const UPLOAD = join(process.cwd(), config.upload.dir, 'ai-reports');
const MAX_SIZE = config.upload.maxSizeMB * 1024 * 1024;
mkdirSync(UPLOAD, { recursive: true });

// Multer: диск, лимит размера, whitelist расширений
const ALLOWED_EXTS = ['.xlsx', '.xls', '.csv'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD),
    filename:    (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXTS.includes(ext));
  },
}).single('file');

router.use(authenticate);

// ── список ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const qb = knex('ai_reports as a')
      .leftJoin('users as u', 'u.id', 'a.uploaded_by')
      .select('a.id','a.filename','a.file_size','a.status','a.uploaded_at','a.uploaded_by',
        knex.raw("(u.first_name || ' ' || u.last_name) as uploader_name"))
      .orderBy('a.uploaded_at', 'desc');

    if (req.query.mine === 'true' || req.user.role === 'manager') {
      qb.where('a.uploaded_by', req.user.id);
    } else if (req.user.role === 'head') {
      const visible = await getVisibleUserIds(req.user);
      qb.whereIn('a.uploaded_by', visible);
    }

    res.json(await qb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const report = await knex('ai_reports').where({ id: req.params.id }).first();
    if (!report) return res.status(404).json({ error: 'Не найдено' });
    if (report.uploaded_by !== req.user.id && req.user.role !== 'admin') {
      if (req.user.role === 'head') {
        const visible = await getVisibleUserIds(req.user);
        if (!visible.includes(report.uploaded_by)) return res.status(404).json({ error: 'Не найдено' });
      } else {
        return res.status(404).json({ error: 'Не найдено' });
      }
    }
    const analysis = await knex('ai_report_analysis')
      .where({ report_id: report.id }).orderBy('version', 'desc').first();
    res.json({ ...report, analysis: analysis ? JSON.parse(analysis.result_json || 'null') : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── upload ──────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Файл больше ${config.upload.maxSizeMB} МБ` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Только .xlsx, .xls, .csv (поле file)' });
    }
    try {
      const [report] = await knex('ai_reports').insert({
        filename:    req.file.originalname,
        file_path:   req.file.path,
        file_size:   req.file.size,
        uploaded_by: req.user.id,
        status:      'pending',
      }).returning(['id', 'filename', 'status']);

      res.status(201).json({ id: report.id, upload_id: report.id, filename: report.filename, status: report.status });
    } catch (e) {
      console.error('[ai-reports/upload]', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// ── analyze ───────────────────────────────────────────────────────────────────

router.post('/:id/analyze', async (req, res) => {
  try {
    const report = await knex('ai_reports').where({ id: req.params.id }).first();
    if (!report) return res.status(404).json({ error: 'Не найдено' });
    if (report.uploaded_by !== req.user.id && !['admin','head'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Нет прав' });
    }

    await knex('ai_reports').where({ id: report.id }).update({ status: 'processing' });

    let dataRows;
    try {
      const wb = XLSX.readFile(report.file_path);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      dataRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } catch (e) {
      await knex('ai_reports').where({ id: report.id }).update({ status: 'error' });
      return res.status(422).json({ error: 'Не удалось прочитать файл: ' + e.message });
    }

    let analysis;
    try {
      analysis = await analyzeReport(dataRows, report.filename);
    } catch (e) {
      await knex('ai_reports').where({ id: report.id }).update({ status: 'error' });
      await knex('ai_report_analysis').insert({
        report_id: report.id, version: 1, error_msg: e.message,
      });
      return res.status(502).json({ error: 'Ошибка AI: ' + e.message });
    }

    const last = await knex('ai_report_analysis').where({ report_id: report.id }).orderBy('version','desc').first();
    const version = last ? last.version + 1 : 1;

    const [savedAnalysis] = await knex('ai_report_analysis').insert({
      report_id: report.id, version,
      ai_provider: analysis._provider || '',
      result_json: JSON.stringify(analysis),
    }).returning('id');

    // Сохраняем графики в отдельную таблицу (design §19.18)
    if (Array.isArray(analysis.charts) && analysis.charts.length) {
      const chartRows = analysis.charts.map((ch, i) => ({
        analysis_id: savedAnalysis.id,
        type:        ch.type || 'bar',
        title:       ch.title || '',
        config_json: JSON.stringify(ch.config || ch.data || ch),
        sort_order:  i,
      }));
      await knex('ai_report_charts').insert(chartRows).catch(() => {});
    }

    await knex('ai_reports').where({ id: report.id }).update({ status: 'done' });

    res.json({ ok: true, analysis });
  } catch (err) {
    console.error('[ai-reports/analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const report = await knex('ai_reports').where({ id: req.params.id }).first();
    if (!report) return res.status(404).json({ error: 'Не найдено' });
    res.json({ status: report.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const report = await knex('ai_reports').where({ id: req.params.id }).first();
    if (!report) return res.status(404).json({ error: 'Не найдено' });
    if (report.uploaded_by !== req.user.id && !['admin','head'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Нет прав' });
    }
    await unlink(report.file_path).catch(() => {});
    await knex('ai_reports').where({ id: report.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


export default router;
