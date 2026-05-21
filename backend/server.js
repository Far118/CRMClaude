/**
 * server.js — Express entrypoint.
 *
 * Cluster mode: один master + N воркеров (по числу CPU или WEB_CONCURRENCY).
 * Stateless: вся сессия в JWT-cookie.
 */

import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { config } from './config.js';
import knex from './db/knex.js';

import authRoutes          from './routes/auth.js';
import lookupRoutes        from './routes/lookup.js';
import usersRoutes         from './routes/users.js';
import companiesRoutes     from './routes/companies.js';
import contactsRoutes      from './routes/contacts.js';
import requestsRoutes      from './routes/requests.js';
import activitiesRoutes    from './routes/activities.js';
import plansRoutes         from './routes/plans.js';
import dashboardRoutes     from './routes/dashboard.js';
import reportsRoutes       from './routes/reports.js';
import commentsRoutes      from './routes/comments.js';
import closeReasonsRoutes  from './routes/closeReasons.js';
import notificationsRoutes from './routes/notifications.js';
import aiReportsRoutes     from './routes/aiReports.js';
import auditRoutes         from './routes/audit.js';
import settingsRoutes      from './routes/settings.js';
import attachmentsRoutes   from './routes/attachments.js';
import tasksRoutes         from './routes/tasks.js';

const WORKERS = parseInt(process.env.WEB_CONCURRENCY ?? '0', 10) || availableParallelism();

if (cluster.isPrimary && config.isProd && WORKERS > 1) {
  console.log(`[master] Запуск ${WORKERS} воркеров`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker) => {
    console.warn(`[master] Воркер ${worker.process.pid} умер, перезапуск`);
    cluster.fork();
  });
} else {
  startServer();
}

function startServer() {
  const app = express();

  app.set('trust proxy', 1);

  // Security
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({ origin: config.corsOrigin, credentials: true }));

  // Body / cookies
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Rate limiting
  const globalLimiter = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true });
  const authLimiter   = rateLimit({ windowMs: 15 * 60_000, max: 10, message: { error: 'Слишком много попыток входа' } });

  app.use('/api', globalLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/change-password', authLimiter);

  // Health
  app.get('/api/health', async (_req, res) => {
    try {
      await knex.raw('SELECT 1');
      res.json({ ok: true, ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Routes
  app.use('/api/auth',          authRoutes);
  app.use('/api/lookup',        lookupRoutes);
  app.use('/api',               usersRoutes);          // /api/users, /api/teams
  app.use('/api/companies',     companiesRoutes);
  app.use('/api/contacts',      contactsRoutes);
  app.use('/api/requests',      requestsRoutes);
  app.use('/api/activities',    activitiesRoutes);
  app.use('/api/plans',         plansRoutes);
  app.use('/api/dashboard',     dashboardRoutes);
  app.use('/api/reports',       reportsRoutes);
  app.use('/api/comments',      commentsRoutes);
  app.use('/api/close-reasons', closeReasonsRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/ai-reports',    aiReportsRoutes);
  app.use('/api/audit',         auditRoutes);
  app.use('/api/settings',      settingsRoutes);
  app.use('/api/requests/:requestId/attachments', attachmentsRoutes);
  app.use('/api/tasks',         tasksRoutes);

  // 404
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

  // Error handler
  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(500).json({ error: config.isProd ? 'Ошибка сервера' : err.message });
  });

  const server = app.listen(config.port, () => {
    console.log(`[server] CRMNadya backend на :${config.port} (${config.nodeEnv}) pid=${process.pid}`);
  });

  process.on('SIGTERM', () => server.close(() => knex.destroy().then(() => process.exit(0))));
}
