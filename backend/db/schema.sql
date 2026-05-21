-- ═══════════════════════════════════════════════════════════════════════════════
-- CRMNadya — Schema
--
-- Принципы (см. design doc §3, §5, §19):
-- • Все ID — UUID
-- • Все timestamps — TIMESTAMPTZ (UTC)
-- • companies.calculated_status — denormalized cache; пересчитывается
--   автоматически по событиям (см. services/statusEngine.js)
-- • Полная история смены статусов запросов и компаний для аудита
-- • Outbox-таблица для transactional outbox pattern
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Хелперы ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION add_updated_at_trigger(tbl TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE trig_name TEXT := 'trg_' || tbl || '_updated_at';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trig_name) THEN
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      trig_name, tbl
    );
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEPARTMENTS (отделы — верхний уровень орг-структуры, design §19)
-- Иерархия: department → team (head + менеджеры)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS departments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT add_updated_at_trigger('departments');

-- ═══════════════════════════════════════════════════════════════════════════════
-- TEAMS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS teams (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  department_id UUID        REFERENCES departments(id) ON DELETE SET NULL,
  head_id       UUID,                            -- FK заполняется после users
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teams_department ON teams(department_id);
SELECT add_updated_at_trigger('teams');

-- ═══════════════════════════════════════════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  first_name    TEXT        NOT NULL DEFAULT '',
  last_name     TEXT        NOT NULL DEFAULT '',
  role          TEXT        NOT NULL DEFAULT 'manager'
                  CHECK (role IN ('admin','head','manager','ops')),
  team_id       UUID        REFERENCES teams(id) ON DELETE SET NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  phone         TEXT        NOT NULL DEFAULT '',
  avatar_url    TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email   ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_team    ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_users_active  ON users(is_active);
SELECT add_updated_at_trigger('users');

-- FK на head_id создаём отдельно, после того как таблица users существует
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_head_id_fkey;
ALTER TABLE teams ADD CONSTRAINT teams_head_id_fkey
  FOREIGN KEY (head_id) REFERENCES users(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMPANIES
-- calculated_status — denormalized cache, обновляется engine'ом.
-- Никакого user-facing update этого поля.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS companies (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,
  inn                TEXT,
  kpp                TEXT,
  ogrn               TEXT,
  legal_address      TEXT        NOT NULL DEFAULT '',
  actual_address     TEXT        NOT NULL DEFAULT '',
  website            TEXT        NOT NULL DEFAULT '',
  industry           TEXT        NOT NULL DEFAULT '',

  calculated_status  TEXT        NOT NULL DEFAULT 'cold_lead'
                       CHECK (calculated_status IN ('cold_lead','warm_lead','hot_lead','client','lost')),

  priority           TEXT        NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('high','medium','low')),

  regions            JSONB       NOT NULL DEFAULT '[]',
  cargo_types        JSONB       NOT NULL DEFAULT '[]',
  transport_modes    JSONB       NOT NULL DEFAULT '[]',
  tags               JSONB       NOT NULL DEFAULT '[]',

  phone_main         TEXT        NOT NULL DEFAULT '',
  email_main         TEXT        NOT NULL DEFAULT '',

  next_action_at     DATE,
  next_action_type   TEXT        NOT NULL DEFAULT '',

  owner_id           UUID        REFERENCES users(id) ON DELETE SET NULL,
  annual_revenue     NUMERIC(15,2),

  notes              TEXT        NOT NULL DEFAULT '',
  source             TEXT        NOT NULL DEFAULT '',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_owner   ON companies(owner_id);
CREATE INDEX IF NOT EXISTS idx_companies_status  ON companies(calculated_status);
CREATE INDEX IF NOT EXISTS idx_companies_inn     ON companies(inn) WHERE inn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_name_lower ON companies(lower(name));
SELECT add_updated_at_trigger('companies');

-- История смены статусов компаний (см. design §19.4)
CREATE TABLE IF NOT EXISTS company_status_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT        NOT NULL,
  trigger_event   TEXT        NOT NULL,  -- 'request_created', 'request_status_changed', 'cron_window', 'admin_manual'
  trigger_data    JSONB,
  changed_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_status_history_company ON company_status_history(company_id, changed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CONTACTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contacts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name        TEXT        NOT NULL DEFAULT '',
  last_name         TEXT        NOT NULL DEFAULT '',
  position          TEXT        NOT NULL DEFAULT '',
  role              TEXT        NOT NULL DEFAULT '',
  phone_main        TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL DEFAULT '',
  telegram          TEXT        NOT NULL DEFAULT '',
  whatsapp          TEXT        NOT NULL DEFAULT '',
  preferred_channel TEXT        NOT NULL DEFAULT 'phone'
                      CHECK (preferred_channel IN ('phone','email','telegram','whatsapp')),
  notes             TEXT        NOT NULL DEFAULT '',
  is_primary        BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
SELECT add_updated_at_trigger('contacts');

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLOSE_REASONS (справочник)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS close_reasons (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT        NOT NULL UNIQUE,
  label             TEXT        NOT NULL,
  category          TEXT        NOT NULL DEFAULT 'other'
                      CHECK (category IN ('pre_kp','post_kp','technical','other')),
  is_loss           BOOLEAN     NOT NULL DEFAULT true,
  requires_comment  BOOLEAN     NOT NULL DEFAULT false,
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_close_reasons_active ON close_reasons(is_active, sort_order);

-- ═══════════════════════════════════════════════════════════════════════════════
-- REQUESTS
-- Статусы: new | in_progress | kp_sent | negotiation | handover | closed
-- (см. design §6)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS requests (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  contact_id         UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id           UUID        REFERENCES users(id) ON DELETE SET NULL,

  status             TEXT        NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','in_progress','kp_sent','negotiation','handover','closed')),

  close_reason_id    UUID        REFERENCES close_reasons(id),
  close_comment      TEXT        NOT NULL DEFAULT '',
  closed_at          TIMESTAMPTZ,

  -- Маршрут
  route_from         TEXT        NOT NULL DEFAULT '',
  route_to           TEXT        NOT NULL DEFAULT '',
  route_via          TEXT        NOT NULL DEFAULT '',
  distance_km        NUMERIC(10,2),

  -- Груз
  cargo_type         TEXT        NOT NULL DEFAULT 'general'
                       CHECK (cargo_type IN ('general','bulk','liquid','frozen','adr','oversized')),
  cargo_description  TEXT        NOT NULL DEFAULT '',
  weight_kg          NUMERIC(10,3),
  volume_m3          NUMERIC(10,3),
  places_count       INTEGER,
  cargo_value        NUMERIC(15,2),
  is_adr             BOOLEAN     NOT NULL DEFAULT false,
  is_oversized       BOOLEAN     NOT NULL DEFAULT false,
  temperature_regime TEXT        NOT NULL DEFAULT '',

  -- Условия
  transport_type     TEXT        NOT NULL DEFAULT 'auto'
                       CHECK (transport_type IN ('auto','sea','air','rail','multimodal')),
  loading_type       TEXT        NOT NULL DEFAULT '',
  incoterms          TEXT        NOT NULL DEFAULT '',
  loading_date       DATE,
  delivery_date      DATE,

  -- Финансы
  budget             NUMERIC(15,2),
  our_rate           NUMERIC(15,2),
  carrier_rate       NUMERIC(15,2),
  margin             NUMERIC(15,2),
  margin_percent     NUMERIC(5,2),
  currency           TEXT        NOT NULL DEFAULT 'RUB'
                       CHECK (currency IN ('RUB','USD','EUR')),

  -- Этапы
  kp_sent_at         TIMESTAMPTZ,
  handover_at        TIMESTAMPTZ,
  handover_notes     TEXT        NOT NULL DEFAULT '',

  is_regular         BOOLEAN     NOT NULL DEFAULT false,
  frequency          TEXT        NOT NULL DEFAULT '',
  notes              TEXT        NOT NULL DEFAULT '',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requests_company        ON requests(company_id);
CREATE INDEX IF NOT EXISTS idx_requests_owner          ON requests(owner_id);
CREATE INDEX IF NOT EXISTS idx_requests_status         ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created        ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status_owner   ON requests(status, owner_id);
CREATE INDEX IF NOT EXISTS idx_requests_handover_at    ON requests(handover_at) WHERE handover_at IS NOT NULL;
SELECT add_updated_at_trigger('requests');

-- История смен статуса запроса
CREATE TABLE IF NOT EXISTS request_status_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID        NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT        NOT NULL,
  changed_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comment         TEXT        NOT NULL DEFAULT '',
  close_reason_id UUID        REFERENCES close_reasons(id)
);

CREATE INDEX IF NOT EXISTS idx_rsh_request ON request_status_history(request_id, changed_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACTIVITIES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS activities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        REFERENCES companies(id) ON DELETE SET NULL,
  contact_id      UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  request_id      UUID        REFERENCES requests(id) ON DELETE SET NULL,
  type            TEXT        NOT NULL
                    CHECK (type IN ('call_out','call_in','email_out','email_in','meeting','task','proposal','note')),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description     TEXT        NOT NULL DEFAULT '',
  outcome         TEXT        NOT NULL DEFAULT '',
  next_step       TEXT        NOT NULL DEFAULT '',
  next_step_due   DATE,
  is_done         BOOLEAN     NOT NULL DEFAULT false,
  owner_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activities_company  ON activities(company_id);
CREATE INDEX IF NOT EXISTS idx_activities_owner    ON activities(owner_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_type     ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_due      ON activities(next_step_due) WHERE next_step_due IS NOT NULL;
SELECT add_updated_at_trigger('activities');

-- ═══════════════════════════════════════════════════════════════════════════════
-- TASKS (задачи и напоминания, design §19)
-- Отдельная сущность: привязка к company ИЛИ request, дедлайн, исполнитель.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tasks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',
  company_id    UUID        REFERENCES companies(id) ON DELETE CASCADE,
  request_id    UUID        REFERENCES requests(id)  ON DELETE CASCADE,
  assignee_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  due_at        TIMESTAMPTZ,
  priority      TEXT        NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('high','medium','low')),
  status        TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','done','cancelled')),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_company  ON tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_request  ON tasks(request_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_at) WHERE status = 'open';
SELECT add_updated_at_trigger('tasks');

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS comments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT        NOT NULL CHECK (entity_type IN ('company','request')),
  entity_id   UUID        NOT NULL,
  author_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_type, entity_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ATTACHMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS attachments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID        NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  filename     TEXT        NOT NULL,
  file_path    TEXT        NOT NULL,
  file_size    INTEGER     NOT NULL DEFAULT 0,
  mime_type    TEXT        NOT NULL DEFAULT '',
  uploaded_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_request ON attachments(request_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PLANS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS plans (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year                 INTEGER     NOT NULL,
  month                INTEGER     NOT NULL CHECK (month BETWEEN 1 AND 12),

  target_revenue       NUMERIC(15,2) NOT NULL DEFAULT 0,
  target_won           INTEGER       NOT NULL DEFAULT 0,
  target_new_requests  INTEGER       NOT NULL DEFAULT 0,
  target_kp_sent       INTEGER       NOT NULL DEFAULT 0,
  target_activities    INTEGER       NOT NULL DEFAULT 0,
  target_calls         INTEGER       NOT NULL DEFAULT 0,
  target_meetings      INTEGER       NOT NULL DEFAULT 0,
  target_new_companies INTEGER       NOT NULL DEFAULT 0,
  notes                TEXT          NOT NULL DEFAULT '',
  created_by           UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_plans_user   ON plans(user_id);
CREATE INDEX IF NOT EXISTS idx_plans_period ON plans(year, month);
SELECT add_updated_at_trigger('plans');

-- История изменений планов (защита от понижения задним числом — design §11.6)
CREATE TABLE IF NOT EXISTS plan_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  old_values  JSONB,
  new_values  JSONB,
  changed_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_history_plan ON plan_history(plan_id, changed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTIFICATIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL DEFAULT '',
  entity_type TEXT,
  entity_id   UUID,
  is_read     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at DESC);

-- Push-подписки
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT        NOT NULL UNIQUE,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- AUDIT LOG
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT        NOT NULL,         -- 'request.status_change', 'plan.update', 'company.reassign'
  entity_type  TEXT        NOT NULL,
  entity_id    UUID,
  old_values   JSONB,
  new_values   JSONB,
  ip_address   INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs(user_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- AI REPORTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  filename    TEXT        NOT NULL,
  file_path   TEXT        NOT NULL,
  file_size   INTEGER     NOT NULL DEFAULT 0,
  uploaded_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','done','error'))
);

CREATE INDEX IF NOT EXISTS idx_ai_reports_user ON ai_reports(uploaded_by, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS ai_report_analysis (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     UUID        NOT NULL REFERENCES ai_reports(id) ON DELETE CASCADE,
  version       INTEGER     NOT NULL DEFAULT 1,
  ai_provider   TEXT        NOT NULL DEFAULT '',
  result_json   JSONB,
  error_msg     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_report ON ai_report_analysis(report_id);

CREATE TABLE IF NOT EXISTS ai_report_charts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id  UUID        NOT NULL REFERENCES ai_report_analysis(id) ON DELETE CASCADE,
  type         TEXT        NOT NULL DEFAULT 'bar',
  title        TEXT        NOT NULL DEFAULT '',
  config_json  JSONB,
  sort_order   INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_charts_analysis ON ai_report_charts(analysis_id, sort_order);

-- ═══════════════════════════════════════════════════════════════════════════════
-- OUTBOX (для transactional outbox pattern, design §7.2)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS outbox (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  processed_at  TIMESTAMPTZ,
  error_msg     TEXT,
  retry_count   INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed
  ON outbox(created_at) WHERE processed_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- AI provider settings (для UI настройки)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_provider_settings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT        NOT NULL CHECK (provider IN ('openai','anthropic','deepseek')),
  api_key     TEXT        NOT NULL,
  model       TEXT        NOT NULL DEFAULT '',
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT add_updated_at_trigger('ai_provider_settings');
