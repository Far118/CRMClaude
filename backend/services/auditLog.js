/**
 * services/auditLog.js — Запись действий пользователей в audit_logs.
 */

import knex from '../db/knex.js';

/**
 * Логирует действие.
 *
 * @param {object} req - express request (для IP и user-agent)
 * @param {string} action - 'request.status_change' | 'plan.update' | etc.
 * @param {string} entityType
 * @param {string} entityId
 * @param {object} oldValues
 * @param {object} newValues
 */
export async function audit(req, action, entityType, entityId, oldValues = null, newValues = null) {
  try {
    await knex('audit_logs').insert({
      user_id:     req.user?.id || null,
      action,
      entity_type: entityType,
      entity_id:   entityId,
      old_values:  oldValues ? JSON.stringify(oldValues) : null,
      new_values:  newValues ? JSON.stringify(newValues) : null,
      ip_address:  req.ip || req.connection?.remoteAddress || null,
      user_agent:  req.headers?.['user-agent'] || null,
    });
  } catch (err) {
    console.warn('[audit] failed:', err.message);
  }
}
