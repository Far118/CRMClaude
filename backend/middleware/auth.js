/**
 * middleware/auth.js — JWT auth, ролевая защита, owner scope.
 *
 * Принцип RBAC из design doc §4 и §16.2:
 *   • manager — видит только свои записи (owner_id = self)
 *   • head    — видит свои + всю свою команду
 *   • admin   — видит всё
 *
 * При попытке доступа к чужой записи возвращаем 404, а не 403
 * (anti-IDOR: не утечь даже факт существования записи).
 */

import jwt from 'jsonwebtoken';
import knex from '../db/knex.js';
import { config } from '../config.js';

export async function authenticate(req, res, next) {
  const token = req.cookies?.[config.jwt.cookieName] ||
                req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ error: 'Не авторизовано' });
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await knex('users').where({ id: payload.sub }).first();

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Сессия недействительна' });
    }

    req.user = {
      id:         user.id,
      email:      user.email,
      role:       user.role,
      team_id:    user.team_id,
      first_name: user.first_name,
      last_name:  user.last_name,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Сессия недействительна' });
  }
}

/**
 * Проверка ролей.
 * Использование: requireRole('admin', 'head')
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Не авторизовано' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

/**
 * Чистая логика scope (для unit-тестов) — без обращения к БД.
 *
 * @param {object} user - { id, role, team_id }
 * @param {string[]} teamMemberIds - id активных членов команды (для head)
 * @returns {string[]|null} null = без ограничения (admin)
 */
export function computeVisibleUserIds(user, teamMemberIds = []) {
  if (user.role === 'admin') return null;
  if (user.role === 'head' && user.team_id) {
    return teamMemberIds.includes(user.id) ? teamMemberIds : [...teamMemberIds, user.id];
  }
  return [user.id];
}

/**
 * Возвращает список user_id, доступных для просмотра текущему пользователю.
 *
 * - admin: null (без ограничения)
 * - head: [self, ...members_of_my_team]
 * - manager/ops: [self]
 */
export async function getVisibleUserIds(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'head' && user.team_id) {
    const members = await knex('users')
      .where({ team_id: user.team_id, is_active: true })
      .pluck('id');
    return computeVisibleUserIds(user, members);
  }
  return [user.id];
}

/**
 * Чистая логика canModify (для unit-тестов).
 */
export function computeCanModify(user, ownerId, visibleIds) {
  if (user.role === 'admin') return true;
  if (ownerId === user.id) return true;
  if (user.role === 'head') return Array.isArray(visibleIds) && visibleIds.includes(ownerId);
  return false;
}

/**
 * Применяет owner_id-фильтр к Knex query builder.
 * Использование:
 *   const qb = knex('requests');
 *   await applyOwnerScope(qb, req.user, 'owner_id');
 */
export async function applyOwnerScope(qb, user, column = 'owner_id') {
  const visible = await getVisibleUserIds(user);
  if (visible !== null) {
    qb.whereIn(column, visible);
  }
}

/**
 * Может ли user изменять запись с указанным ownerId?
 */
export async function canModify(user, ownerId) {
  if (user.role === 'admin') return true;
  if (ownerId === user.id) return true;
  if (user.role === 'head') {
    const visible = await getVisibleUserIds(user);
    return computeCanModify(user, ownerId, visible);
  }
  return false;
}
