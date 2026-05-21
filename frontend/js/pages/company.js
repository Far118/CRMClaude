/**
 * js/pages/company.js — Alpine-компонент карточки компании.
 */

import Alpine from 'alpinejs';
import { api } from '../api.js';
import { initUI, fmtDate, fmtDateTime, fmtMoney, toast } from '../ui.js';
import { LOOKUP, companyStatusLabel, companyStatusColor, requestStatusLabel, requestStatusColor, activityLabel } from '../const.js';

Alpine.data('companyPage', () => ({
  loading: true,
  session: null,
  company: null,
  requests: [],
  contacts: [],
  activities: [],
  comments: [],
  history: [],
  lookup: {},
  tab: 'overview',
  editMode: false,
  editForm: {},
  saving: false,
  addActModal: false,
  addContactModal: false,
  actForm: { type: 'call_out', description: '', outcome: '', next_step: '', next_step_due: '' },
  newComment: '',

  async init() {
    this.session = await initUI({ active: 'companies' });
    if (!this.session) return;
    this.lookup = await LOOKUP.load();

    const id = new URLSearchParams(location.search).get('id');
    if (!id) { location.href = '/companies.html'; return; }

    // Определяем стартовую вкладку
    const tabParam = new URLSearchParams(location.search).get('tab');
    if (tabParam) this.tab = tabParam;

    try {
      const [company, requests, contacts, activities, comments, history] = await Promise.all([
        api.get(`/companies/${id}`),
        api.get(`/requests?company_id=${id}`),
        api.get(`/contacts?company_id=${id}`),
        api.get(`/activities?company_id=${id}`),
        api.get(`/comments?entity_type=company&entity_id=${id}`),
        api.get(`/companies/${id}/history`),
      ]);
      this.company = company;
      this.requests = requests;
      this.contacts = contacts;
      this.activities = activities;
      this.comments = comments;
      this.history = history;
      this.editForm = { ...company };
    } catch (err) {
      toast('Ошибка загрузки: ' + err.message, 'error');
    } finally {
      this.loading = false;
    }
  },

  get activeRequests() {
    return this.requests.filter(r => !['handover','closed'].includes(r.status));
  },

  get wonCount() {
    return this.requests.filter(r => r.status === 'handover').length;
  },

  get sortedRequests() {
    return [...this.requests].sort((a, b) => {
      const active = r => !['handover','closed'].includes(r.status);
      if (active(a) && !active(b)) return -1;
      if (!active(a) && active(b)) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  },

  newRequest() {
    location.href = `/requests.html?new=1&company_id=${this.company.id}`;
  },

  async saveEdit() {
    if (!this.editForm.name?.trim()) { toast('Название обязательно', 'error'); return; }
    this.saving = true;
    try {
      this.company = await api.put(`/companies/${this.company.id}`, this.editForm);
      this.editMode = false;
      toast('Сохранено', 'success');
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    } finally {
      this.saving = false;
    }
  },

  async saveActivity() {
    if (!this.actForm.description && !this.actForm.outcome) { toast('Заполните описание', 'error'); return; }
    this.saving = true;
    try {
      const a = await api.post('/activities', { ...this.actForm, company_id: this.company.id });
      this.activities.unshift(a);
      this.addActModal = false;
      this.actForm = { type: 'call_out', description: '', outcome: '', next_step: '', next_step_due: '' };
      toast('Активность добавлена', 'success');
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    } finally {
      this.saving = false;
    }
  },

  async addComment() {
    if (!this.newComment.trim()) return;
    try {
      const c = await api.post('/comments', {
        entity_type: 'company',
        entity_id: this.company.id,
        body: this.newComment.trim(),
      });
      this.comments.unshift({ ...c, author_name: [this.session.first_name, this.session.last_name].filter(Boolean).join(' ') || this.session.email });
      this.newComment = '';
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    }
  },

  stLabel: companyStatusLabel,
  stColor: companyStatusColor,
  reqLabel: requestStatusLabel,
  reqColor: requestStatusColor,
  actLabel: activityLabel,
  fmtDate,
  fmtDateTime,
  fmtMoney,
}));

window.Alpine = Alpine;
Alpine.start();
