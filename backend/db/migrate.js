#!/usr/bin/env node
/**
 * db/migrate.js — Накатывает schema.sql и сидирует базовые данные.
 *
 * Запуск: npm run migrate
 *
 * Идемпотентен: можно запускать многократно.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import knex from './knex.js';
import { config } from '../config.js';
import { DEFAULT_CLOSE_REASONS } from '../constants/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function applySchema() {
  console.log('[migrate] Накатываем schema.sql…');
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf-8');
  await knex.raw(sql);
  console.log('[migrate] schema.sql OK');
}

async function seedAdmin() {
  const existing = await knex('users').where({ email: config.adminEmail }).first();
  if (existing) {
    console.log(`[migrate] admin '${config.adminEmail}' уже существует — пропускаем`);
    return;
  }
  const hash = await bcrypt.hash(config.adminPassword, config.bcryptRounds);
  await knex('users').insert({
    email: config.adminEmail,
    password_hash: hash,
    first_name: 'Администратор',
    last_name: '',
    role: 'admin',
    is_active: true,
  });
  console.log(`[migrate] Создан admin: ${config.adminEmail}`);
}

async function seedCloseReasons() {
  console.log('[migrate] Сидируем close_reasons…');
  let added = 0;
  for (const r of DEFAULT_CLOSE_REASONS) {
    const exists = await knex('close_reasons').where({ code: r.code }).first();
    if (!exists) {
      await knex('close_reasons').insert(r);
      added++;
    }
  }
  console.log(`[migrate] close_reasons: добавлено ${added} новых, остальные были`);
}

async function main() {
  try {
    await applySchema();
    await seedAdmin();
    await seedCloseReasons();
    console.log('[migrate] ✅ Готово');
  } catch (err) {
    console.error('[migrate] ❌ Ошибка:', err.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main();
