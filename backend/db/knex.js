/**
 * db/knex.js — единственный экземпляр Knex.
 */

import knexLib from 'knex';
import { config } from '../config.js';

const knex = knexLib({
  client: 'pg',
  connection: {
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.database,
    user:     config.db.user,
    password: config.db.password,
    ssl:      config.db.ssl,
  },
  pool: {
    min: 2,
    max: config.db.max,
    idleTimeoutMillis:    config.db.idleTimeoutMs,
    acquireTimeoutMillis: config.db.connectTimeoutMs,
  },
});

export default knex;
