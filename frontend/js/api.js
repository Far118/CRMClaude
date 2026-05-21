/**
 * js/api.js — Тонкая обёртка над fetch.
 */

async function request(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);

  if (res.status === 401) {
    if (!location.pathname.endsWith('login.html')) location.href = '/login.html';
    throw new Error('Не авторизовано');
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

export const api = {
  get:   (p)    => request('GET', p),
  post:  (p, b) => request('POST', p, b),
  put:   (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del:   (p)    => request('DELETE', p),
};
