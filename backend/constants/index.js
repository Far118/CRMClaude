/**
 * constants/index.js — единый источник истины для всех enum-значений.
 *
 * Используется в:
 *   - Zod-схемах роутов
 *   - Алгоритме пересчёта статуса компании
 *   - Endpoint'е /api/lookup → фронтенд получает все константы оттуда
 *
 * Изменения в enum'ах ВСЕГДА делаются здесь + миграция БД.
 */

// ── Компании ──────────────────────────────────────────────────────────────────

export const COMPANY_STATUSES = ['cold_lead', 'warm_lead', 'hot_lead', 'client', 'lost'];

export const COMPANY_STATUS_LABELS = {
  cold_lead: 'Холодный лид',
  warm_lead: 'Тёплый лид',
  hot_lead:  'Горячий лид',
  client:    'Клиент',
  lost:      'Потерян',
};

export const COMPANY_STATUS_COLORS = {
  cold_lead: 'gray',
  warm_lead: 'blue',
  hot_lead:  'orange',
  client:    'green',
  lost:      'red',
};

export const COMPANY_PRIORITIES = ['high', 'medium', 'low'];
export const COMPANY_PRIORITY_LABELS = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };

// ── Запросы ───────────────────────────────────────────────────────────────────

export const REQUEST_STATUSES = ['new', 'in_progress', 'kp_sent', 'negotiation', 'handover', 'closed'];

export const REQUEST_STATUS_LABELS = {
  new:         'Новый',
  in_progress: 'В работе',
  kp_sent:     'Отправлено КП',
  negotiation: 'Согласование',
  handover:    'Передан в договоры',
  closed:      'Закрыт',
};

export const REQUEST_STATUS_COLORS = {
  new:         'blue',
  in_progress: 'orange',
  kp_sent:     'purple',
  negotiation: 'yellow',
  handover:    'green',
  closed:      'gray',
};

/** Активные статусы (запрос «в работе») — определяют тёплый/горячий лид */
export const ACTIVE_STATUSES = ['new', 'in_progress', 'kp_sent', 'negotiation'];
export const HOT_STATUSES    = ['kp_sent', 'negotiation'];
export const WARM_STATUSES   = ['new', 'in_progress'];

/** Допустимые переходы статусов запроса. Используется в роуте PATCH /:id/status */
export const ALLOWED_TRANSITIONS = {
  new:         ['in_progress', 'closed'],
  in_progress: ['kp_sent', 'closed', 'new'],
  kp_sent:     ['negotiation', 'handover', 'closed'],
  negotiation: ['handover', 'closed', 'kp_sent'],
  handover:    ['closed'], // только admin
  closed:      ['in_progress'], // reopen, только head/admin
};

// ── Логистика ─────────────────────────────────────────────────────────────────

export const TRANSPORT_TYPES = ['auto', 'sea', 'air', 'rail', 'multimodal'];
export const TRANSPORT_TYPE_LABELS = {
  auto:       'Автомобиль',
  sea:        'Морской',
  air:        'Авиа',
  rail:       'Ж/Д',
  multimodal: 'Мультимодальный',
};

export const CARGO_TYPES = ['general', 'bulk', 'liquid', 'frozen', 'adr', 'oversized'];
export const CARGO_TYPE_LABELS = {
  general:   'Генеральный',
  bulk:      'Навалочный',
  liquid:    'Наливной',
  frozen:    'Заморозка',
  adr:       'Опасный (ADR)',
  oversized: 'Негабарит',
};

export const CURRENCIES = ['RUB', 'USD', 'EUR'];

export const INCOTERMS = ['', 'EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];

// ── Активности ────────────────────────────────────────────────────────────────

export const ACTIVITY_TYPES = ['call_out', 'call_in', 'email_out', 'email_in', 'meeting', 'task', 'proposal', 'note'];

export const ACTIVITY_TYPE_LABELS = {
  call_out:  'Исходящий звонок',
  call_in:   'Входящий звонок',
  email_out: 'Исходящее письмо',
  email_in:  'Входящее письмо',
  meeting:   'Встреча',
  task:      'Задача',
  proposal:  'КП',
  note:      'Заметка',
};

// ── Пользователи ──────────────────────────────────────────────────────────────

export const USER_ROLES = ['admin', 'head', 'manager', 'ops'];

export const USER_ROLE_LABELS = {
  admin:   'Администратор',
  head:    'Руководитель',
  manager: 'Менеджер',
  ops:     'Операционист',
};

// ── Планы ─────────────────────────────────────────────────────────────────────

export const PLAN_FIELDS = [
  { key: 'target_revenue',       label: 'Выручка, ₽',      isRevenue: true },
  { key: 'target_won',           label: 'Выиграно сделок' },
  { key: 'target_new_requests',  label: 'Новых запросов' },
  { key: 'target_kp_sent',       label: 'Отправлено КП' },
  { key: 'target_activities',    label: 'Активностей' },
  { key: 'target_calls',         label: 'Звонков' },
  { key: 'target_meetings',      label: 'Встреч' },
  { key: 'target_new_companies', label: 'Новых компаний' },
];

/** Маппинг target_* → ключ в объекте fact (см. routes/plans.js getFact()) */
export const PLAN_FACT_KEYS = {
  target_revenue:       'revenue',
  target_won:           'won',
  target_new_requests:  'new_requests',
  target_kp_sent:       'kp_sent',
  target_activities:    'activities',
  target_calls:         'calls',
  target_meetings:      'meetings',
  target_new_companies: 'new_companies',
};

// ── Причины закрытия (seed справочника) ───────────────────────────────────────

export const DEFAULT_CLOSE_REASONS = [
  { code: 'lost_pre_kp_no_response',   label: 'Нет обратной связи (до КП)',  category: 'pre_kp',    is_loss: true,  requires_comment: false, sort_order: 10 },
  { code: 'lost_pre_kp_rejected',      label: 'Отказ до КП',                  category: 'pre_kp',    is_loss: true,  requires_comment: true,  sort_order: 20 },
  { code: 'lost_post_kp_price',        label: 'Не согласовали ставку',        category: 'post_kp',   is_loss: true,  requires_comment: true,  sort_order: 30 },
  { code: 'lost_post_kp_competitor',   label: 'Проиграли конкуренту',         category: 'post_kp',   is_loss: true,  requires_comment: true,  sort_order: 40 },
  { code: 'lost_post_kp_changed_mind', label: 'Передумали',                   category: 'post_kp',   is_loss: true,  requires_comment: false, sort_order: 50 },
  { code: 'lost_post_kp_no_response',  label: 'Нет обратной связи (после КП)',category: 'post_kp',   is_loss: true,  requires_comment: false, sort_order: 60 },
  { code: 'cancel_by_client',          label: 'Отмена клиентом',              category: 'other',     is_loss: true,  requires_comment: false, sort_order: 70 },
  { code: 'tech_duplicate',            label: 'Дубль',                        category: 'technical', is_loss: false, requires_comment: true,  sort_order: 80 },
  { code: 'tech_non_target',           label: 'Нецелевой запрос',             category: 'technical', is_loss: false, requires_comment: false, sort_order: 90 },
  { code: 'tech_test',                 label: 'Тестовый/учебный',             category: 'technical', is_loss: false, requires_comment: false, sort_order: 100 },
];

// ── AI ────────────────────────────────────────────────────────────────────────

export const AI_PROVIDERS = ['openai', 'anthropic', 'deepseek'];
export const AI_PROVIDER_LABELS = {
  openai:    'OpenAI',
  anthropic: 'Anthropic (Claude)',
  deepseek:  'DeepSeek',
};
