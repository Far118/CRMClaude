/**
 * js/pages/companies.js
 */

import Alpine from 'alpinejs';
import { api } from '../api.js';
import { initUI, fmtDate, toast } from '../ui.js';
import { LOOKUP, companyStatusLabel, companyStatusColor } from '../const.js';

Alpine.data('companiesPage', () => ({
  loading: true,
  companies: [],
  lookup: {},
  q: '',
  statusFilter: '',
  modalOpen: false,
  saving: false,
  form: { name: '', inn: '', phone_main: '', email_main: '', source: '' },

  async init() {
    const session = await initUI({ active: 'companies' });
    if (!session) return;
    this.lookup = await LOOKUP.load();

    // ?new=1 → сразу открыть модалку
    if (new URLSearchParams(location.search).get('new') === '1') this.openNew();

    await this.load();
  },

  async load() {
    this.loading = true;
    try {
      const p = new URLSearchParams();
      if (this.q) p.set('q', this.q);
      if (this.statusFilter) p.set('status', this.statusFilter);
      this.companies = await api.get('/companies?' + p.toString());
    } catch (err) {
      toast('Ошибка загрузки: ' + err.message, 'error');
    } finally {
      this.loading = false;
    }
  },

  openNew() {
    this.form = { name: '', inn: '', phone_main: '', email_main: '', source: '' };
    this.modalOpen = true;
  },

  async save() {
    if (!this.form.name.trim()) { toast('Укажите название', 'error'); return; }
    this.saving = true;
    try {
      const created = await api.post('/companies', this.form);
      this.modalOpen = false;
      toast('Компания создана', 'success');
      location.href = `/company.html?id=${created.id}`;
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    } finally {
      this.saving = false;
    }
  },

  statusLabel: companyStatusLabel,
  statusColor: companyStatusColor,
  fmtDate,
}));

window.Alpine = Alpine;
Alpine.start();
