/**
 * services/aiService.js — Анализ табличных данных через AI-провайдера.
 *
 * Поддерживает OpenAI / Anthropic / DeepSeek.
 * Настройки берутся из таблицы ai_provider_settings (приоритет) или из config.
 */

import knex from '../db/knex.js';
import { config } from '../config.js';

function buildPrompt(dataRows, reportName) {
  const sample = dataRows.slice(0, 50);
  const columns = sample.length ? Object.keys(sample[0]) : [];
  return `Ты — аналитик данных. Проанализируй таблицу из файла "${reportName}".

Колонки: ${columns.join(', ')}
Количество строк: ${dataRows.length}
Образец данных (первые 50 строк):
${JSON.stringify(sample, null, 2)}

Верни СТРОГО JSON без markdown-обёрток в формате:
{
  "executive_summary": "2-3 предложения с главным выводом",
  "trends": ["тенденция 1", "тенденция 2"],
  "anomalies": ["аномалия 1"],
  "recommendations": ["рекомендация 1", "рекомендация 2"],
  "charts": [
    { "type": "bar|line|pie", "title": "Название", "data": [{"label": "...", "value": 123}] }
  ]
}`;
}

async function getSettings() {
  const db = await knex('ai_provider_settings').where({ is_active: true }).first();
  if (db) return { provider: db.provider, apiKey: db.api_key, model: db.model };
  if (config.ai.apiKey) return { provider: config.ai.provider, apiKey: config.ai.apiKey, model: config.ai.model };
  throw new Error('AI-провайдер не настроен');
}

function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function callOpenAI(s, prompt) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return parseJSON(data.choices[0].message.content);
}

async function callAnthropic(s, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: s.model || 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return parseJSON(data.content[0].text);
}

async function callDeepSeek(s, prompt) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return parseJSON(data.choices[0].message.content);
}

/**
 * @param {Array<object>} dataRows - распарсенные строки таблицы
 * @param {string} reportName
 * @returns {Promise<object>} - { executive_summary, trends, anomalies, recommendations, charts }
 */
export async function analyzeReport(dataRows, reportName) {
  const settings = await getSettings();
  const prompt = buildPrompt(dataRows, reportName);

  switch (settings.provider) {
    case 'openai':    return callOpenAI(settings, prompt);
    case 'anthropic': return callAnthropic(settings, prompt);
    case 'deepseek':  return callDeepSeek(settings, prompt);
    default: throw new Error(`Неизвестный провайдер: ${settings.provider}`);
  }
}
