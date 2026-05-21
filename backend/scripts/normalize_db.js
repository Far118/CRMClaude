#!/usr/bin/env node
/**
 * scripts/normalize_db.js — Нормализация данных под текущие enum'ы.
 *
 *   node scripts/normalize_db.js --dry-run   # показать без изменений
 *   node scripts/normalize_db.js             # применить
 *
 * Чинит:
 *   - невалидные статусы запросов → 'new'
 *   - невалидные статусы компаний → пересчёт через statusEngine
 *   - trim строковых полей
 */

import knex from '../db/knex.js';
import { recalculateCompanyStatus } from '../services/statusEngine.js';
import { REQUEST_STATUSES, TRANSPORT_TYPES, CARGO_TYPES, CURRENCIES } from '../constants/index.js';

const DRY = process.argv.includes('--dry-run');
const stats = { requests: 0, companies: 0, trimmed: 0 };

async function fixRequests() {
  const bad = await knex('requests').whereNotIn('status', REQUEST_STATUSES).select('id','status');
  for (const r of bad) {
    console.log(`  requests ${r.id}: status "${r.status}" → "new"`);
    if (!DRY) await knex('requests').where({ id: r.id }).update({ status: 'new' });
    stats.requests++;
  }

  // fix transport_type / cargo_type / currency
  for (const [field, valid, def] of [
    ['transport_type', TRANSPORT_TYPES, 'auto'],
    ['cargo_type', CARGO_TYPES, 'general'],
    ['currency', CURRENCIES, 'RUB'],
  ]) {
    const rows = await knex('requests').whereNotIn(field, valid).select('id', field);
    for (const r of rows) {
      console.log(`  requests ${r.id}: ${field} "${r[field]}" → "${def}"`);
      if (!DRY) await knex('requests').where({ id: r.id }).update({ [field]: def });
      stats.requests++;
    }
  }
}

async function recalcCompanies() {
  const companies = await knex('companies').select('id');
  for (const c of companies) {
    if (!DRY) {
      const result = await recalculateCompanyStatus(c.id, { triggerEvent: 'normalize_script' });
      if (result.changed) {
        console.log(`  company ${c.id}: ${result.from} → ${result.to}`);
        stats.companies++;
      }
    }
  }
}

async function main() {
  console.log(`[normalize] режим: ${DRY ? 'DRY-RUN' : 'LIVE'}`);
  await fixRequests();
  if (!DRY) await recalcCompanies();
  console.log(`[normalize] Итого: requests=${stats.requests}, companies пересчитано=${stats.companies}`);
  await knex.destroy();
}

main().catch(e => { console.error(e.message); process.exit(1); });
