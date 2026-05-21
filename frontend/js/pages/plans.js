/**
 * js/pages/plans.js — Таблица планов с inline-редактированием.
 */

import Alpine from 'alpinejs';
import { api } from '../api.js';
import { initUI, toast } from '../ui.js';
import { LOOKUP, MONTHS_RU } from '../const.js';

Alpine.data('plansPage', () => ({
  loading: true,
  year:  new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  users: [],
  plans: [],
  lookup: {},
  copyModal: false,
  copyFrom: { year: 0, month: 0 },
  copying: false,
  saveState: {},     // { userId: 'saving' | 'saved' | '' }
  _timers: {},

  async init() {
    const session = await initUI({ active: 'plans', roles: ['admin','head'] });
    if (!session) return;
    this.lookup = await LOOKUP.load();
    await this.load();
  },

  get fields() { return this.lookup.plan_fields || []; },
  get factKeys() { return this.lookup.plan_fact_keys || {}; },

  get monthTitle() { return `${MONTHS_RU[this.month-1]} ${this.year}`; },

  prevMonth() {
    if (--this.month < 1) { this.month = 12; this.year--; }
    this.load();
  },
  nextMonth() {
    if (++this.month > 12) { this.month = 1; this.year++; }
    this.load();
  },

  async load() {
    this.loading = true;
    try {
      const [users, plans] = await Promise.all([
        api.get('/users').catch(() => []),
        api.get(`/plans?year=${this.year}&month=${this.month}`).catch(() => []),
      ]);
      this.users = (users || []).filter(u => u.is_active && u.role !== 'ops');
      this.plans = plans || [];
    } finally {
      this.loading = false;
    }
  },

  get monthPct() {
    const now = new Date();
    const total = new Date(this.year, this.month, 0).getDate();
    const isCurrent = this.year === now.getFullYear() && this.month === now.getMonth()+1;
    return Math.round((isCurrent ? now.getDate() : total) / total * 100);
  },

  planFor(uid) { return this.plans.find(p => p.user_id === uid) || null; },

  targetVal(uid, field) {
    const p = this.planFor(uid);
    return p ? (Number(p[field]) || 0) : 0;
  },

  factVal(uid, field) {
    const p = this.planFor(uid);
    if (!p?.fact) return null;
    const fk = this.factKeys[field];
    return fk ? Number(p.fact[fk] ?? 0) : null;
  },

  pct(uid, field) {
    const t = this.targetVal(uid, field);
    const f = this.factVal(uid, field);
    if (f === null || t === 0) return null;
    return Math.min(Math.round(f / t * 100), 100);
  },

  pctClass(p) {
    if (p === null) return 'pct-none';
    const mp = this.monthPct;
    if (p >= 100)    return 'pct-great';
    if (p >= mp)     return 'pct-ok';
    if (p >= mp*.7)  return 'pct-warn';
    return 'pct-bad';
  },

  userName(u) { return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email; },

  onInput(uid, field) {
    const k = uid;
    this.saveState[k] = 'saving';
    clearTimeout(this._timers[k + field]);
    this._timers[k + field] = setTimeout(() => this.savePlan(uid), 800);
  },

  onBlur(uid) {
    clearTimeout(this._timers[uid]);
    this.savePlan(uid);
  },

  getInputVal(uid, field) {
    const el = document.querySelector(`[data-uid="${uid}"][data-field="${field}"]`);
    return el ? (parseInt(el.value) || 0) : 0;
  },

  async savePlan(uid) {
    const data = { user_id: uid, year: this.year, month: this.month };
    for (const f of this.fields) {
      data[f.key] = this.getInputVal(uid, f.key);
    }
    this.saveState[uid] = 'saving';
    try {
      const updated = await api.post('/plans', data);
      const idx = this.plans.findIndex(p => p.user_id === uid);
      if (idx >= 0) this.plans[idx] = { ...this.plans[idx], ...updated };
      else this.plans.push(updated);
      this.saveState[uid] = 'saved';
      setTimeout(() => { this.saveState[uid] = ''; }, 1500);
    } catch (err) {
      this.saveState[uid] = '';
      toast('Ошибка сохранения: ' + err.message, 'error');
    }
  },

  openCopyModal() {
    let y = this.year, m = this.month - 1;
    if (m < 1) { m = 12; y--; }
    this.copyFrom = { year: y, month: m };
    this.copyModal = true;
  },

  get copyFromTitle() { return `${MONTHS_RU[this.copyFrom.month - 1]} ${this.copyFrom.year}`; },

  async confirmCopy() {
    this.copying = true;
    try {
      const r = await api.post('/plans/copy-month', {
        from_year: this.copyFrom.year, from_month: this.copyFrom.month,
        to_year: this.year, to_month: this.month,
      });
      this.copyModal = false;
      toast(r.message, 'success');
      await this.load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this.copying = false;
    }
  },
}));

window.Alpine = Alpine;
Alpine.start();
