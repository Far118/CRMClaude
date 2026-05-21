/**
 * js/ui.js — Общие UI-функции: сайдбар, initUI, esc, toast, форматтеры.
 */

import { api } from './api.js';

// ── Навигация ───────────────────────────────────────────────────────────────

const NAV = [
  { section: 'Основное' },
  { id: 'dashboard',  href: '/index.html',      label: 'Дашборд',   icon: 'grid' },
  { id: 'companies',  href: '/companies.html',  label: 'Компании',  icon: 'building' },
  { id: 'requests',   href: '/requests.html',   label: 'Запросы',   icon: 'inbox' },
  { id: 'activities', href: '/activities.html', label: 'Задачи',    icon: 'check' },
  { section: 'Аналитика' },
  { id: 'reports',    href: '/reports.html',    label: 'Отчёты',    icon: 'chart' },
  { id: 'ai_reports', href: '/ai-reports.html', label: 'AI-отчёты', icon: 'sparkles' },
  { section: 'Управление', roles: ['admin','head'] },
  { id: 'team',       href: '/team.html',       label: 'Команда',   icon: 'users', roles: ['admin','head'] },
  { id: 'plans',      href: '/plans.html',      label: 'Планы',     icon: 'target', roles: ['admin','head'] },
  { section: 'Система', roles: ['admin'] },
  { id: 'admin_users',href: '/admin/users.html',label: 'Пользователи', icon: 'shield', roles: ['admin'] },
  { id: 'settings',   href: '/settings/index.html', label: 'Настройки', icon: 'gear', roles: ['admin'] },
];

const ICONS = {
  grid:     '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>',
  inbox:    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  check:    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  chart:    '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  sparkles: '<path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/>',
  users:    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  target:   '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  shield:   '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  gear:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function renderSidebar(session, activeId) {
  const items = NAV.filter(n => !n.roles || n.roles.includes(session.role));
  let html = `<div class="sidebar-brand">📦 CRMNadya</div>`;
  for (const n of items) {
    if (n.section) {
      html += `<div class="sidebar-section-title">${esc(n.section)}</div>`;
    } else {
      html += `<a href="${n.href}" class="nav-item ${n.id === activeId ? 'active' : ''}">${icon(n.icon)}<span>${esc(n.label)}</span></a>`;
    }
  }
  const initials = ((session.first_name?.[0] || session.email[0]) + (session.last_name?.[0] || '')).toUpperCase();
  const roleLabel = { admin:'Администратор', head:'Руководитель', manager:'Менеджер', ops:'Оператор' }[session.role] || session.role;
  html += `
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="avatar">${esc(initials)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc([session.first_name, session.last_name].filter(Boolean).join(' ') || session.email)}</div>
          <div style="font-size:.72rem;color:var(--text-faint)">${esc(roleLabel)}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="logoutBtn" title="Выйти">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
      </div>
    </div>`;
  return html;
}

/**
 * Инициализирует страницу: проверяет сессию, рисует сайдбар.
 * @returns session | null (если не авторизован — редирект на login)
 */
export async function initUI({ active, roles } = {}) {
  let session;
  try {
    session = await api.get('/auth/me');
  } catch {
    location.href = '/login.html';
    return null;
  }

  if (roles && !roles.includes(session.role)) {
    location.href = '/index.html';
    return null;
  }

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.innerHTML = renderSidebar(session, active);

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await api.post('/auth/logout');
    location.href = '/login.html';
  });

  // Бургер-меню
  const menuBtn = document.getElementById('menuBtn');
  const overlay = document.getElementById('sidebarOverlay');
  menuBtn?.addEventListener('click', () => {
    sidebar?.classList.add('open');
    overlay?.classList.add('show');
  });
  overlay?.addEventListener('click', () => {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('show');
  });

  return session;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export function toast(message, type = '') {
  const el = document.getElementById('toast');
  if (!el) return alert(message);
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ── Форматтеры ──────────────────────────────────────────────────────────────

export function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtMoney(n) {
  n = Number(n || 0);
  return n.toLocaleString('ru-RU');
}
export function fmtMoneyShort(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + ' млн';
  if (n >= 1_000)     return Math.round(n / 1_000) + ' тыс';
  return String(n);
}
export function todayStr() { return new Date().toISOString().split('T')[0]; }
