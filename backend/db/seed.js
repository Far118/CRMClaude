#!/usr/bin/env node
/**
 * db/seed.js — Демо-данные для разработки.
 * Запуск: npm run seed
 */

import bcrypt from 'bcryptjs';
import knex from './knex.js';
import { config } from '../config.js';

async function main() {
  console.log('[seed] Создаём демо-данные…');

  // Команда
  // Отдел + команда
  let dep = await knex('departments').where({ name: 'Коммерческий отдел' }).first();
  if (!dep) [dep] = await knex('departments').insert({ name: 'Коммерческий отдел' }).returning('*');

  let team = await knex('teams').where({ name: 'Север' }).first();
  if (!team) [team] = await knex('teams').insert({ name: 'Север', department_id: dep.id }).returning('*');

  // Head
  const hash = await bcrypt.hash('password123', config.bcryptRounds);
  let head = await knex('users').where({ email: 'head@crmnadya.local' }).first();
  if (!head) {
    [head] = await knex('users').insert({
      email: 'head@crmnadya.local', password_hash: hash,
      first_name: 'Пётр', last_name: 'Руководитель', role: 'head', team_id: team.id,
    }).returning('*');
    await knex('teams').where({ id: team.id }).update({ head_id: head.id });
  }

  // Менеджеры
  const managers = [];
  for (const [email, fn, ln] of [
    ['ivan@crmnadya.local', 'Иван', 'Менеджеров'],
    ['anna@crmnadya.local', 'Анна', 'Продажина'],
  ]) {
    let m = await knex('users').where({ email }).first();
    if (!m) [m] = await knex('users').insert({
      email, password_hash: hash, first_name: fn, last_name: ln,
      role: 'manager', team_id: team.id,
    }).returning('*');
    managers.push(m);
  }

  // Компании + запросы
  const reasonLost = await knex('close_reasons').where({ code: 'lost_post_kp_price' }).first();
  for (let i = 1; i <= 6; i++) {
    const owner = managers[i % managers.length];
    const exists = await knex('companies').where({ name: `Демо-Компания ${i}` }).first();
    if (exists) continue;

    const [company] = await knex('companies').insert({
      name: `Демо-Компания ${i}`,
      inn: `770${i}00000${i}`,
      owner_id: owner.id,
      phone_main: `+7900000000${i}`,
      source: 'сайт',
    }).returning('*');

    // запрос
    const statuses = ['new','in_progress','kp_sent','negotiation','handover','closed'];
    const st = statuses[i % statuses.length];
    const reqData = {
      company_id: company.id, owner_id: owner.id, status: st,
      route_from: 'Москва', route_to: ['СПб','Сочи','Казань'][i%3],
      cargo_type: 'general', our_rate: 50000 + i * 10000, currency: 'RUB',
      transport_type: 'auto',
    };
    if (st === 'kp_sent' || st === 'negotiation' || st === 'handover') reqData.kp_sent_at = knex.fn.now();
    if (st === 'handover') reqData.handover_at = knex.fn.now();
    if (st === 'closed') { reqData.close_reason_id = reasonLost?.id; reqData.closed_at = knex.fn.now(); }

    const [request] = await knex('requests').insert(reqData).returning('*');
    await knex('request_status_history').insert({ request_id: request.id, to_status: 'new', changed_by: owner.id });
  }

  // Планы на текущий месяц
  const now = new Date();
  for (const m of managers) {
    await knex('plans').insert({
      user_id: m.id, year: now.getFullYear(), month: now.getMonth() + 1,
      target_revenue: 800000, target_won: 10, target_new_requests: 40,
      target_kp_sent: 25, target_activities: 150, target_calls: 100,
      target_meetings: 20, target_new_companies: 15, created_by: head.id,
    }).onConflict(['user_id','year','month']).ignore();
  }

  console.log('[seed] ✅ Готово. Логины: head@crmnadya.local / ivan@... / anna@... — пароль password123');
  await knex.destroy();
}

main().catch(e => { console.error(e.message); process.exit(1); });
