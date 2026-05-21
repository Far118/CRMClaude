/**
 * config.js — единая точка конфигурации.
 *
 * Каждая обязательная переменная окружения проверяется через require_env().
 * В production отсутствие критичных переменных приводит к падению при старте.
 */

import 'dotenv/config';

function require_env(name, defaultValue = undefined) {
  const val = process.env[name];
  if (val === undefined || val === '') {
    if (defaultValue !== undefined) return defaultValue;
    console.error(`[config] Обязательная переменная окружения ${name} не задана`);
    process.exit(1);
  }
  return val;
}

const isProd = process.env.NODE_ENV === 'production';

function getCorsOrigin() {
  const v = process.env.CORS_ORIGIN;
  if (!v && isProd) {
    console.error('[config] CORS_ORIGIN обязателен в production');
    process.exit(1);
  }
  return v ?? '*';
}

export const config = {
  port:    parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd,

  db: {
    host:     process.env.DB_HOST ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'crmnadya',
    user:     process.env.DB_USER ?? 'crmnadya',
    password: require_env('DB_PASSWORD'),
    ssl:      false,
    max:      parseInt(process.env.DB_POOL_MAX ?? '10', 10),
    idleTimeoutMs:    30_000,
    connectTimeoutMs: 5_000,
  },

  jwt: {
    secret:     require_env('JWT_SECRET'),
    expiresIn:  process.env.JWT_EXPIRES_IN ?? '8h',
    cookieName: 'crmnadya_token',
  },

  corsOrigin: getCorsOrigin(),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10),

  adminEmail:    process.env.ADMIN_EMAIL ?? 'admin@crmnadya.local',
  adminPassword: require_env('ADMIN_PASSWORD'),

  ai: {
    provider: process.env.AI_PROVIDER ?? 'openai',
    apiKey:   process.env.AI_API_KEY  ?? '',
    model:    process.env.AI_MODEL    ?? 'gpt-4o-mini',
  },

  vapid: {
    publicKey:  process.env.VAPID_PUBLIC_KEY  ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject:    process.env.VAPID_SUBJECT     ?? 'mailto:admin@crmnadya.local',
  },

  upload: {
    dir:        process.env.UPLOAD_DIR ?? './uploads',
    maxSizeMB:  parseInt(process.env.UPLOAD_MAX_SIZE_MB ?? '20', 10),
  },

  /** Window клиента в месяцах (см. дизайн §5.4) */
  clientWindowMonths: parseInt(process.env.CLIENT_WINDOW_MONTHS ?? '6', 10),
};
