/**
 * js/const.js — Константы фронтенда из /api/lookup (загружаются один раз).
 */

import { api } from './api.js';

const _cache = { data: null, promise: null };

export const LOOKUP = {
  async load() {
    if (_cache.data) return _cache.data;
    if (_cache.promise) return _cache.promise;
    _cache.promise = api.get('/lookup')
      .then(d => { _cache.data = d; return d; })
      .catch(() => ({}));
    return _cache.promise;
  },
  get() { return _cache.data || {}; },
};

export function companyStatusLabel(s) { return _cache.data?.company_status_labels?.[s] || s; }
export function companyStatusColor(s) { return _cache.data?.company_status_colors?.[s] || 'gray'; }
export function requestStatusLabel(s) { return _cache.data?.request_status_labels?.[s] || s; }
export function requestStatusColor(s) { return _cache.data?.request_status_colors?.[s] || 'gray'; }
export function activityLabel(t)      { return _cache.data?.activity_type_labels?.[t] || t; }

export const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
export const MONTHS_SHORT = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
export const DOW_RU = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
