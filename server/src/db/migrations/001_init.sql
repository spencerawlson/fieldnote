-- ---------------------------------------------------------------------------
-- Fieldnote initial schema
--
-- Design notes:
--  * The PROJECT is the source of truth. Reports and presentations are
--    projections over project knowledge, never the primary store.
--  * Elaborated knowledge lives in `claims`: every generated sentence carries
--    a provenance label (USER_FACT / EVIDENCE / AI_EXPLANATION / AI_INFERENCE /
--    AI_RECOMMENDATION) and a confidence level. Outputs cite claim ids, so a
--    report sentence can always be traced back to its origin.
--  * SQLite is the default engine (zero-ops, embedded). Types are written so
--    the same DDL ports to PostgreSQL with the mechanical changes documented
--    in docs/DATABASE.md.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_login_at   TEXT
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  summary           TEXT,
  objective         TEXT,
  scope             TEXT,
  requirements      TEXT,
  environment       TEXT,
  architecture      TEXT,
  conclusion        TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','complete','archived')),
  domain            TEXT,
  elaboration_depth INTEGER NOT NULL DEFAULT 2 CHECK (elaboration_depth BETWEEN 1 AND 4),
  tone              TEXT NOT NULL DEFAULT 'technical',
  audience          TEXT NOT NULL DEFAULT 'technical-team',
  settings_json     TEXT NOT NULL DEFAULT '{}',
  started_at        TEXT,
  ended_at          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_projects_owner ON projects(owner_id, updated_at DESC);
CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_members_user ON project_members(user_id);

-- ---------------------------------------------------------------------------
-- Work capture
-- ---------------------------------------------------------------------------

CREATE TABLE steps (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  title            TEXT NOT NULL,
  user_description TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT 'other',
  status           TEXT NOT NULL DEFAULT 'done'
                   CHECK (status IN ('planned','in-progress','done','failed','skipped')),
  occurred_at      TEXT,
  configuration    TEXT,
  expected_result  TEXT,
  actual_result    TEXT,
  validation       TEXT,
  source           TEXT NOT NULL DEFAULT 'user'
                   CHECK (source IN ('user','ai-structured','import')),
  ai_state         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (ai_state IN ('pending','elaborated','stale','failed')),
  ai_confidence    TEXT CHECK (ai_confidence IN ('high','medium','low')),
  elaboration_depth INTEGER,
  content_hash     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_steps_project ON steps(project_id, position);
CREATE INDEX idx_steps_state ON steps(project_id, ai_state);

CREATE TABLE step_links (
  from_step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  to_step_id   TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN ('depends-on','follows','relates-to','supersedes')),
  origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  PRIMARY KEY (from_step_id, to_step_id, relation)
);

CREATE TABLE commands (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id      TEXT REFERENCES steps(id) ON DELETE CASCADE,
  problem_id   TEXT,
  language     TEXT NOT NULL DEFAULT 'bash',
  content      TEXT NOT NULL,
  output       TEXT,
  explanation  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','evidence','ai-suggested')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_commands_step ON commands(step_id, position);
CREATE INDEX idx_commands_project ON commands(project_id);

-- ---------------------------------------------------------------------------
-- Files and evidence
-- ---------------------------------------------------------------------------

CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id   TEXT NOT NULL REFERENCES users(id),
  storage_key   TEXT NOT NULL,
  thumb_key     TEXT,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  checksum      TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  scan_state    TEXT NOT NULL DEFAULT 'pending'
                CHECK (scan_state IN ('pending','clean','suspect','skipped')),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX idx_files_project ON files(project_id, created_at DESC);
CREATE INDEX idx_files_checksum ON files(project_id, checksum);

CREATE TABLE evidence (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'screenshot'
                 CHECK (kind IN ('screenshot','photo','diagram','document','log','config','code','link','other')),
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT,
  caption        TEXT,
  source         TEXT,
  captured_at    TEXT,
  review_state   TEXT NOT NULL DEFAULT 'unreviewed'
                 CHECK (review_state IN ('unreviewed','ai-analyzed','user-confirmed','user-corrected','rejected')),
  confidence     TEXT CHECK (confidence IN ('high','medium','low')),
  sensitive      INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_evidence_project ON evidence(project_id, position);
CREATE INDEX idx_evidence_state ON evidence(project_id, review_state);

-- The evidence chain: STEP / PROBLEM / RESOLUTION / RESULT / TEST -> EVIDENCE
CREATE TABLE evidence_links (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  evidence_id  TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('step','problem','resolution','result','test','project')),
  target_id    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'supports'
               CHECK (role IN ('supports','before','after','symptom','investigation','resolution','validation')),
  origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  confidence   TEXT CHECK (confidence IN ('high','medium','low')),
  note         TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (evidence_id, target_type, target_id, role)
);
CREATE INDEX idx_evlinks_target ON evidence_links(target_type, target_id);
CREATE INDEX idx_evlinks_project ON evidence_links(project_id);

CREATE TABLE image_analyses (
  id             TEXT PRIMARY KEY,
  evidence_id    TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  detected_app   TEXT,
  detected_os    TEXT,
  observations_json TEXT NOT NULL DEFAULT '[]',
  entities_json  TEXT NOT NULL DEFAULT '{}',
  suggested_json TEXT NOT NULL DEFAULT '{}',
  confidence     TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  superseded     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_imageanalysis_ev ON image_analyses(evidence_id, superseded);

CREATE TABLE ocr_results (
  id            TEXT PRIMARY KEY,
  evidence_id   TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  engine        TEXT NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  redacted_text TEXT,
  confidence    REAL,
  superseded    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_ocr_ev ON ocr_results(evidence_id, superseded);

CREATE TABLE secret_findings (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  detector     TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  preview      TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_secrets_project ON secret_findings(project_id, acknowledged);

-- ---------------------------------------------------------------------------
-- Troubleshooting
-- ---------------------------------------------------------------------------

CREATE TABLE problems (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id        TEXT REFERENCES steps(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  symptoms       TEXT,
  impact         TEXT,
  hypothesis     TEXT,
  root_cause     TEXT,
  root_cause_provenance TEXT NOT NULL DEFAULT 'AI_INFERENCE',
  root_cause_confidence TEXT CHECK (root_cause_confidence IN ('high','medium','low')),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','investigating','resolved','unresolved','wont-fix')),
  detected_at    TEXT,
  resolved_at    TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  ai_state       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (ai_state IN ('pending','elaborated','stale','failed')),
  content_hash   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_problems_project ON problems(project_id, position);

CREATE TABLE investigations (
  id          TEXT PRIMARY KEY,
  problem_id  TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  action      TEXT NOT NULL,
  finding     TEXT,
  tool        TEXT,
  origin      TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','evidence','ai-suggested')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_investigations_problem ON investigations(problem_id, position);

CREATE TABLE resolutions (
  id           TEXT PRIMARY KEY,
  problem_id   TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  validation   TEXT,
  validated    INTEGER NOT NULL DEFAULT 0,
  origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai-suggested')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_resolutions_problem ON resolutions(problem_id);

-- ---------------------------------------------------------------------------
-- Testing and results
-- ---------------------------------------------------------------------------

CREATE TABLE tests (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_id       TEXT REFERENCES steps(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  method        TEXT,
  expected      TEXT,
  observed      TEXT,
  outcome       TEXT NOT NULL DEFAULT 'untested'
                CHECK (outcome IN ('pass','fail','partial','untested')),
  performed_at  TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_tests_project ON tests(project_id, position);

CREATE TABLE results (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  detail      TEXT,
  metric      TEXT,
  value       TEXT,
  provenance  TEXT NOT NULL DEFAULT 'USER_FACT',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_results_project ON results(project_id, position);

CREATE TABLE refs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  url         TEXT,
  detail      TEXT,
  origin      TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','ai')),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_refs_project ON refs(project_id, position);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  UNIQUE (project_id, name)
);

CREATE TABLE entity_tags (
  tag_id       TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  PRIMARY KEY (tag_id, entity_type, entity_id)
);

-- ---------------------------------------------------------------------------
-- The knowledge layer: provenance-labelled claims
-- ---------------------------------------------------------------------------

CREATE TABLE claims (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('project','step','problem','evidence','test','result','command')),
  subject_id    TEXT NOT NULL,
  slot          TEXT NOT NULL,
  provenance    TEXT NOT NULL CHECK (provenance IN
                  ('USER_FACT','EVIDENCE','AI_EXPLANATION','AI_INFERENCE','AI_RECOMMENDATION')),
  confidence    TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  text          TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 2 CHECK (depth BETWEEN 1 AND 4),
  supports_json TEXT NOT NULL DEFAULT '[]',
  position      INTEGER NOT NULL DEFAULT 0,
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  accepted      INTEGER,
  generation_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_claims_subject ON claims(subject_type, subject_id, position);
CREATE INDEX idx_claims_project ON claims(project_id, provenance);
CREATE INDEX idx_claims_slot ON claims(subject_type, subject_id, slot);

-- ---------------------------------------------------------------------------
-- AI bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE ai_runs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  service        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','error','cached')),
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_cents     REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  cache_key      TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_airuns_project ON ai_runs(project_id, created_at DESC);
CREATE INDEX idx_airuns_cache ON ai_runs(cache_key);
CREATE INDEX idx_airuns_user_month ON ai_runs(user_id, created_at);

CREATE TABLE ai_cache (
  cache_key   TEXT PRIMARY KEY,
  service     TEXT NOT NULL,
  model       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ai_insights (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('missing-step','missing-evidence','contradiction','unexplained-action',
                   'unsupported-claim','duplicate-step','missing-validation','incomplete-troubleshooting',
                   'logical-gap','questionable-assumption','needs-confirmation','sequence-issue',
                   'slide-text-heavy','slide-weak-transition','slide-repetition','slide-missing-visual',
                   'recommendation')),
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical','warning','info')),
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  suggestion    TEXT,
  targets_json  TEXT NOT NULL DEFAULT '[]',
  confidence    TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','dismissed','resolved')),
  scope         TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project','presentation','report')),
  scope_id      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_insights_project ON ai_insights(project_id, state, severity);
CREATE INDEX idx_insights_scope ON ai_insights(scope, scope_id);

-- ---------------------------------------------------------------------------
-- Outputs: reports, presentations, Q&A
-- ---------------------------------------------------------------------------

CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_key  TEXT NOT NULL DEFAULT 'technical',
  title         TEXT NOT NULL,
  subtitle      TEXT,
  author        TEXT,
  tone          TEXT NOT NULL DEFAULT 'technical',
  audience      TEXT NOT NULL DEFAULT 'technical-team',
  depth         INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generating','ready','failed')),
  version       INTEGER NOT NULL DEFAULT 1,
  source_hash   TEXT,
  generated_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX idx_reports_project ON reports(project_id, updated_at DESC);

CREATE TABLE report_sections (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES report_sections(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  heading        TEXT NOT NULL,
  position       INTEGER NOT NULL,
  blocks_json    TEXT NOT NULL DEFAULT '[]',
  claim_ids_json TEXT NOT NULL DEFAULT '[]',
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_sections_report ON report_sections(report_id, position);

CREATE TABLE presentations (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL DEFAULT 'technical-demo',
  title        TEXT NOT NULL,
  subtitle     TEXT,
  presenter    TEXT,
  audience     TEXT NOT NULL DEFAULT 'technical-team',
  tone         TEXT NOT NULL DEFAULT 'technical',
  slide_target INTEGER NOT NULL DEFAULT 12,
  theme        TEXT NOT NULL DEFAULT 'slate',
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generating','ready','failed')),
  version      INTEGER NOT NULL DEFAULT 1,
  source_hash  TEXT,
  generated_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_pres_project ON presentations(project_id, updated_at DESC);

CREATE TABLE slides (
  id                TEXT PRIMARY KEY,
  presentation_id   TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  layout            TEXT NOT NULL DEFAULT 'bullets'
                    CHECK (layout IN ('title','bullets','bullets-image','image','two-column','before-after','table','quote','code','diagram','closing')),
  title             TEXT NOT NULL,
  subtitle          TEXT,
  bullets_json      TEXT NOT NULL DEFAULT '[]',
  body_json         TEXT NOT NULL DEFAULT '{}',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  speaker_notes     TEXT NOT NULL DEFAULT '',
  claim_ids_json    TEXT NOT NULL DEFAULT '[]',
  edited_by_user    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_slides_pres ON slides(presentation_id, position);

CREATE TABLE questions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  presentation_id TEXT REFERENCES presentations(id) ON DELETE SET NULL,
  category        TEXT NOT NULL DEFAULT 'implementation',
  level           TEXT NOT NULL DEFAULT 'intermediate'
                  CHECK (level IN ('beginner','intermediate','advanced','expert')),
  text            TEXT NOT NULL,
  difficulty      INTEGER NOT NULL DEFAULT 2,
  position        INTEGER NOT NULL DEFAULT 0,
  edited_by_user  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_questions_project ON questions(project_id, position);

CREATE TABLE answers (
  id                TEXT PRIMARY KEY,
  question_id       TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  grounding_json    TEXT NOT NULL DEFAULT '[]',
  general_knowledge TEXT,
  confidence        TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  edited_by_user    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_answers_question ON answers(question_id);

CREATE TABLE exports (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('report','presentation','project')),
  subject_id      TEXT NOT NULL,
  format          TEXT NOT NULL CHECK (format IN ('pdf','docx','html','md','pptx','json')),
  storage_key     TEXT,
  byte_size       INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed')),
  validation_json TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_exports_subject ON exports(subject_type, subject_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Versioning, jobs, audit
-- ---------------------------------------------------------------------------

CREATE TABLE versions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user','ai','system')),
  actor_id      TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, revision)
);
CREATE INDEX idx_versions_entity ON versions(entity_type, entity_id, revision DESC);
CREATE INDEX idx_versions_project ON versions(project_id, created_at DESC);

CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  type           TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  progress       INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  message        TEXT NOT NULL DEFAULT '',
  result_json    TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  run_after      TEXT NOT NULL,
  locked_at      TEXT,
  locked_by      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_jobs_pickup ON jobs(status, run_after);
CREATE INDEX idx_jobs_project ON jobs(project_id, created_at DESC);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  user_id      TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  ip           TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_project ON audit_log(project_id, created_at DESC);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE search_index USING fts5(
  title,
  body,
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  project_id  UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE embeddings (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  dims         INTEGER NOT NULL,
  vector       BLOB NOT NULL,
  text_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, model)
);
CREATE INDEX idx_embeddings_project ON embeddings(project_id);
