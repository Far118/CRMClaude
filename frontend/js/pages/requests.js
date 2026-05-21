/**
 * js/pages/requests.js
 */

import Alpine from 'alpinejs';
import { api } from '../api.js';
import { initUI, fmtDate, fmtMoney, toast } from '../ui.js';
import { LOOKUP, requestStatusLabel, requestStatusColor } from '../const.js';

Alpine.data('requestsPage', () => ({
  loading: true,
  session: null,
  requests: [],
  lookup: {},
  users: [],
  myCompanies: [],
  statusFilter: '',
  ownerFilter: '',
  q: '',
  selectedRequest: null,
  closingStatus: null,
  closeReasonId: '',
  closeComment: '',
  newModal: false,
  saving: false,
  newForm: { company_id: '', route_from: '', route_to: '', cargo_type: 'general', transport_type: 'auto', weight_kg: null, budget: null, notes: '' },

  async init() {
    this.session = await initUI({ active: 'requests' });
    if (!this.session) return;
    this.lookup = await LOOKUP.load();

    if (this.isHead) {
      this.users = await api.get('/users').catch(() => []);
    }
    this.myCompanies = await api.get('/companies').catch(() => []);

    // ?new=1 & company_id
    const sp = new URLSearchParams(location.search);
    if (sp.get('new') === '1') {
      this.newForm.company_id = sp.get('company_id') || '';
      this.newModal = true;
    }

    // ?status=
    const st = sp.get('status');
    if (st) this.statusFilter = st;

    await this.load();
  },

  get isHead() { return ['admin','head'].includes(this.session?.role); },

  async load() {
    this.loading = true;
    try {
      const p = new URLSearchParams();
      if (this.statusFilter) p.set('status', this.statusFilter);
      if (this.ownerFilter)  p.set('owner_id', this.ownerFilter);
      if (this.q)            p.set('q', this.q);
      this.requests = await api.get('/requests?' + p.toString());
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    } finally {
      this.loading = false;
    }
  },

  openNew() { this.newForm = { company_id: '', route_from: '', route_to: '', cargo_type: 'general', transport_type: 'auto', weight_kg: null, budget: null, notes: '' }; this.newModal = true; },

  async createRequest() {
    if (!this.newForm.company_id) { toast('Выберите компанию', 'error'); return; }
    this.saving = true;
    try {
      const r = await api.post('/requests', this.newForm);
      this.newModal = false;
      toast('Запрос создан', 'success');
      location.href = `/requests.html?id=${r.id}`;
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    } finally {
      this.saving = false;
    }
  },

  get allowedNextStatuses() {
    if (!this.selectedRequest) return [];
    const transitions = this.lookup.allowed_transitions || {};
    return transitions[this.selectedRequest.status] || [];
  },

  promptStatus(st) {
    if (st === 'closed') { this.closingStatus = 'closed'; return; }
    this.applyStatusTo(st);
  },

  async applyStatus() {
    const reason = (this.lookup.close_reasons || []).find(r => r.id === this.closeReasonId);
    if (reason?.requires_comment && !this.closeComment.trim()) { toast('Для этой причины нужен комментарий', 'error'); return; }
    await this.applyStatusTo('closed');
  },

  async applyStatusTo(st) {
    try {
      const body = { status: st };
      if (st === 'closed') { body.close_reason_id = this.closeReasonId; body.comment = this.closeComment; }
      const updated = await api.patch(`/requests/${this.selectedRequest.id}/status`, body);
      const idx = this.requests.findIndex(r => r.id === updated.id);
      if (idx >= 0) this.requests[idx] = { ...this.requests[idx], ...updated };
      this.selectedRequest = null;
      this.closingStatus = null;
      this.closeReasonId = '';
      this.closeComment = '';
      toast('Статус обновлён', 'success');
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    }
  },

  reqLabel: requestStatusLabel,
  reqColor: requestStatusColor,
  fmtDate,
  fmtMoney,
}));

window.Alpine = Alpine;
Alpine.start();
