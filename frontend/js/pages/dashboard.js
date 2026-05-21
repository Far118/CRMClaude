/**
 * js/pages/dashboard.js — Alpine-компонент дашборда.
 */

import Alpine from 'alpinejs';
import { api } from '../api.js';
import { initUI, fmtMoneyShort, todayStr } from '../ui.js';
import { LOOKUP, companyStatusLabel, companyStatusColor, MONTHS_RU } from '../const.js';

const normDate = v => v ? String(v).split('T')[0] : '';

Alpine.data('dashboardPage', () => ({
  session: null,
  loading: true,
  activities: [],
  companies: [],
  planData: null,
  staffData: [],
  agingCount: 0,
  stats: { overdue: 0, today: 0 },
  greetTitle: 'Дашборд',
  greetSub: '',
  freshCompanies: [],
  weekActivity: { calls: 0, emails: 0, meetings: 0, proposals: 0 },

  async init() {
    this.session = await initUI({ active: 'dashboard' });
    if (!this.session) return;
    await LOOKUP.load();

    const h = new Date().getHours();
    const greet = h < 6 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : 'Добрый вечер';
    this.greetTitle = `${greet}, ${this.session.first_name || this.session.email.split('@')[0]}!`;

    const [activities, companies, planData, staffData, aging] = await Promise.all([
      api.get('/activities?mine=true').catch(() => []),
      api.get('/companies').catch(() => []),
      api.get('/plans/my').catch(() => null),
      this.isHead ? api.get('/dashboard/staff').catch(() => []) : Promise.resolve([]),
      api.get('/reports/aging').catch(() => []),
    ]);

    this.activities = activities;
    this.companies = companies;
    this.planData = planData;
    this.staffData = staffData;
    this.agingCount = aging.length;

    this._computeStats();
    this.freshCompanies = [...companies].sort((a,b) => (b.created_at||'').localeCompare(a.created_at||'')).slice(0, 5);
    this._computeWeek();
    this.loading = false;
  },

  get isHead() { return ['admin','head'].includes(this.session?.role); },

  _computeStats() {
    const today = todayStr();
    const tasks = this.activities.filter(a => a.next_step && a.next_step_due && !a.is_done);
    const overdue = tasks.filter(a => normDate(a.next_step_due) < today);
    const todayT = tasks.filter(a => normDate(a.next_step_due) === today);
    this.stats = { overdue: overdue.length, today: todayT.length };

    const parts = [];
    if (this.stats.overdue) parts.push(`<b style="color:var(--error)">${this.stats.overdue} просрочено</b>`);
    if (this.stats.today)   parts.push(`${this.stats.today} на сегодня`);
    if (!parts.length)      parts.push('всё под контролем ✓');
    this.greetSub = parts.join(' · ');
  },

  _computeWeek() {
    const weekAgo = (() => { const d = new Date(); d.setDate(d.getDate()-7); return d.toISOString(); })();
    const w = this.activities.filter(a => a.occurred_at && a.occurred_at >= weekAgo);
    this.weekActivity = {
      calls:     w.filter(a => ['call_out','call_in'].includes(a.type)).length,
      emails:    w.filter(a => ['email_out','email_in'].includes(a.type)).length,
      meetings:  w.filter(a => a.type === 'meeting').length,
      proposals: w.filter(a => a.type === 'proposal').length,
    };
  },

  get weekTotal() { return Object.values(this.weekActivity).reduce((s,v) => s+v, 0); },

  get planMonth() {
    const now = new Date();
    return `${MONTHS_RU[now.getMonth()]} ${now.getFullYear()}`;
  },

  get planDaysInfo() {
    if (!this.planData?.plan) return null;
    const now = new Date();
    const total = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    return { passed: now.getDate(), total, pct: Math.round(now.getDate()/total*100) };
  },

  get planRows() {
    if (!this.planData?.plan) return [];
    const { plan, fact, progress } = this.planData;
    const monthPct = this.planDaysInfo?.pct || 50;

    const rows = [
      { label:'💰 Выручка',     pct:progress.revenue,       nums:`${fmtMoneyShort(fact.revenue)} / ${fmtMoneyShort(plan.target_revenue)}` },
      { label:'🏆 Выиграно',    pct:progress.won,           nums:`${fact.won} / ${plan.target_won}` },
      { label:'📋 Запросов',    pct:progress.new_requests,  nums:`${fact.new_requests} / ${plan.target_new_requests}` },
      { label:'📄 КП',          pct:progress.kp_sent,       nums:`${fact.kp_sent} / ${plan.target_kp_sent}` },
      { label:'🎯 Активностей', pct:progress.activities,    nums:`${fact.activities} / ${plan.target_activities}` },
      { label:'📞 Звонков',     pct:progress.calls,         nums:`${fact.calls} / ${plan.target_calls}` },
      { label:'🤝 Встреч',      pct:progress.meetings,      nums:`${fact.meetings} / ${plan.target_meetings}` },
      { label:'🏢 Компаний',    pct:progress.new_companies, nums:`${fact.new_companies} / ${plan.target_new_companies}` },
    ].filter(r => r.pct !== null);

    return rows.map(r => {
      const p = r.pct || 0;
      const barClass = p>=100?'good':p>=monthPct?'ok':p>=monthPct*.7?'warn':'behind';
      const color = p>=100?'var(--success)':p>=monthPct?'var(--primary)':p>=monthPct*.7?'var(--warning)':'var(--error)';
      return { ...r, p: Math.min(p, 100), barClass, color };
    });
  },

  statusLabel: companyStatusLabel,
  statusColor: companyStatusColor,
  fmtShort: fmtMoneyShort,
  pctColor(p) {
    if (p === null) return 'var(--text-muted)';
    return p >= 100 ? 'var(--success)' : p >= 70 ? 'var(--warning)' : 'var(--error)';
  },
}));

window.Alpine = Alpine;
Alpine.start();
