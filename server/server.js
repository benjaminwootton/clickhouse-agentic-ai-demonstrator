require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const https = require('https');
const OpenAI = require('openai');
const { Langfuse } = require('langfuse');
const figlet = require('figlet');

// Banner — printed before any startup logging so the output reads top-down
console.log('\n' + figlet.textSync('Agentic AI', { font: 'Standard' }));
console.log('ClickHouse Agentic Analytics Platform\n');

const path = require('path');
const fsSync = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Fail fast on missing configuration rather than booting with a default that
// points nowhere. ClickHouse is required; model providers can be added later
// from the admin UI, so they are not checked here.
{
  const envPath = path.join(__dirname, '..', '.env');
  const envFileExists = fsSync.existsSync(envPath);
  const chUrl = (process.env.CLICKHOUSE_URL || '').trim();
  const problems = [];

  if (!chUrl) {
    problems.push('CLICKHOUSE_URL is not set');
  } else {
    let parsed = null;
    try { parsed = new URL(chUrl); } catch { /* handled below */ }
    if (!parsed) {
      problems.push(`CLICKHOUSE_URL is not a valid URL (got "${chUrl}")`);
    } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`CLICKHOUSE_URL must start with http:// or https:// (got "${chUrl}")`);
    }
  }

  if (problems.length) {
    console.error('Cannot start \u2014 ClickHouse is not configured.\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    const inContainer = fsSync.existsSync('/.dockerenv');
    if (inContainer) {
      // .env is never copied into the image; Compose reads it on the host and
      // passes the values through, so point at the project directory.
      console.error('\nCreate a .env file in the project directory on your machine:\n');
      console.error('  cp .env.example .env\n');
      console.error('Docker Compose reads it and passes the values into the container.');
      console.error('The defaults in .env.example target a ClickHouse on localhost:8123.');
    } else if (!envFileExists) {
      console.error(`\nNo .env file was found at ${envPath}. Create one with:\n`);
      console.error('  cp .env.example .env\n');
      console.error('then set CLICKHOUSE_URL, CLICKHOUSE_USER and CLICKHOUSE_PASSWORD.');
    } else {
      console.error('\nSet it in your .env file, for example:\n');
      console.error('  CLICKHOUSE_URL=http://localhost:8123');
    }
    console.error('');
    process.exit(1);
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'website')));

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT,
    model            TEXT NOT NULL,
    system_prompt    TEXT NOT NULL,
    instance_id      TEXT NOT NULL,
    db_name          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'live',
    created_at       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clickhouse_instances (
    id       TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    url      TEXT NOT NULL,
    user     TEXT NOT NULL,
    password TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS scenario_overrides (
    scenario_id      TEXT PRIMARY KEY,
    status           TEXT,
    tags             TEXT,
    system_prompt    TEXT,
    questions        TEXT,
    expose_internals INTEGER
  );
  CREATE TABLE IF NOT EXISTS providers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    api_key    TEXT NOT NULL DEFAULT '',
    base_url   TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
ensureColumn('scenario_overrides', 'tags',             'TEXT');
ensureColumn('scenario_overrides', 'system_prompt',    'TEXT');
ensureColumn('scenario_overrides', 'questions',        'TEXT');
ensureColumn('scenario_overrides', 'expose_internals', 'INTEGER');

function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('agents', 'status',           "TEXT NOT NULL DEFAULT 'live'");
ensureColumn('agents', 'tags',             'TEXT');
ensureColumn('agents', 'questions',        'TEXT');
ensureColumn('agents', 'sector',           'TEXT');
ensureColumn('agents', 'sector_label',     'TEXT');
ensureColumn('agents', 'long_description', 'TEXT');
ensureColumn('agents', 'agent_schema',     'TEXT');
ensureColumn('agents', 'sample_data',      'TEXT');
ensureColumn('agents', 'allow_deploy',     'INTEGER NOT NULL DEFAULT 1');
ensureColumn('agents', 'is_builtin',       'INTEGER NOT NULL DEFAULT 0');
ensureColumn('agents', 'expose_internals', 'INTEGER NOT NULL DEFAULT 1');

function normalizeQuestions(input) {
  if (Array.isArray(input)) return input.map(q => String(q).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split('\n').map(q => q.trim()).filter(Boolean);
  return [];
}
function normalizeTags(input) {
  if (Array.isArray(input)) return input.map(t => String(t).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

// Seed providers from .env if the table is empty
{
  const count = db.prepare('SELECT COUNT(*) AS c FROM providers').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO providers (id, name, api_key, base_url, model, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    let seeded = 0;
    for (let i = 1; i <= 5; i++) {
      const name    = (process.env[`PROVIDER_${i}_NAME`]     || '').trim();
      const apiKey  = (process.env[`PROVIDER_${i}_API_KEY`]  || '').trim();
      const baseUrl = (process.env[`PROVIDER_${i}_BASE_URL`] || '').trim();
      const model   = (process.env[`PROVIDER_${i}_MODEL`]    || '').trim();
      if (!name || !baseUrl || !model) continue;
      insert.run(`provider-${i}`, name, apiKey, baseUrl, model, now + i);
      seeded++;
    }
    if (seeded) console.log(`[seed] copied ${seeded} providers from .env into sqlite`);
  }
}

let PROVIDERS = [];
let PROVIDERS_BY_ID = {};
let PROVIDERS_BY_MODEL = {};

function refreshProviders() {
  const rows = db.prepare('SELECT id, name, api_key, base_url, model FROM providers ORDER BY created_at ASC').all();
  PROVIDERS = rows.map(r => ({
    id: r.id,
    name: r.name,
    apiKey: r.api_key || 'not-required',
    baseUrl: r.base_url,
    model: r.model,
    client: new OpenAI({ apiKey: r.api_key || 'not-required', baseURL: r.base_url })
  }));
  PROVIDERS_BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));
  PROVIDERS_BY_MODEL = Object.fromEntries(PROVIDERS.map(p => [p.model, p]));
}
refreshProviders();

function resolveProvider(requested) {
  return PROVIDERS_BY_ID[requested] || PROVIDERS_BY_MODEL[requested] || PROVIDERS[0];
}
function getDefaultModelId() {
  return PROVIDERS[0]?.id || null;
}

// Seed default ClickHouse instance from .env if empty
{
  const count = db.prepare('SELECT COUNT(*) AS c FROM clickhouse_instances').get().c;
  if (count === 0) {
    db.prepare(`
      INSERT INTO clickhouse_instances (id, label, url, user, password) VALUES (?, ?, ?, ?, ?)
    `).run(
      'default',
      process.env.CLICKHOUSE_LABEL || 'Default',
      process.env.CLICKHOUSE_URL,
      process.env.CLICKHOUSE_USER || 'default',
      process.env.CLICKHOUSE_PASSWORD || ''
    );
    console.log('[seed] default clickhouse instance copied from .env');
  }
}

// Seed built-in agents from seed-builtins.json if missing
{
  const seedPath = path.join(__dirname, 'seed-builtins.json');
  if (fsSync.existsSync(seedPath)) {
    const seed = JSON.parse(fsSync.readFileSync(seedPath, 'utf8'));
    const have = new Set(db.prepare('SELECT id FROM agents').all().map(r => r.id));
    const insert = db.prepare(`
      INSERT INTO agents (id, name, description, long_description, sector, sector_label,
                          model, system_prompt, instance_id, db_name, status, tags, questions,
                          agent_schema, sample_data, allow_deploy, is_builtin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const defaultModelId = PROVIDERS[0]?.id || 'provider-1';
    const now = Date.now();
    let inserted = 0;
    for (const a of seed) {
      if (have.has(a.id)) continue;
      insert.run(
        a.id,
        a.name,
        a.description || '',
        a.longDescription || null,
        a.sector || null,
        a.sectorLabel || null,
        defaultModelId,
        a.systemPrompt || `You are an AI analyst for ${a.name}.`,
        'default',
        `demo_${a.id.replace(/-/g, '_')}`,
        a.status || 'draft',
        JSON.stringify(a.tags || []),
        JSON.stringify(a.questions || []),
        a.schema || null,
        a.sampleData || null,
        a.allowDeploy === false ? 0 : 1,
        a.isBuiltin ? 1 : 0,
        now
      );
      inserted++;
    }
    if (inserted) console.log(`[seed] inserted ${inserted} built-in agents`);
  }
}

function getInstance(id) {
  return db.prepare('SELECT * FROM clickhouse_instances WHERE id = ?').get(id || 'default')
      || db.prepare("SELECT * FROM clickhouse_instances WHERE id = 'default'").get();
}
function normalizeQuestions(input) {
  if (Array.isArray(input)) return input.map(q => String(q).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split('\n').map(q => q.trim()).filter(Boolean);
  return [];
}
function normalizeTags(input) {
  if (Array.isArray(input)) return input.map(t => String(t).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}
const SETTING_DEFAULTS = {
  homeTitle: 'AI agents that talk to your data.',
  homeDescription: 'A curated set of analytical agents wired into ClickHouse, ready to answer questions in plain English. Pick one to chat with — or build your own.',
  homeEyebrow: 'Live Agents · ClickHouse',
  langfusePublicKey: '',
  langfuseSecretKey: '',
  langfuseBaseUrl: 'https://cloud.langfuse.com'
};
function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { ...SETTING_DEFAULTS, ...map };
}

// Seed langfuse settings from .env if not yet stored
{
  const have = new Set(db.prepare('SELECT key FROM settings').all().map(r => r.key));
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const envSeeds = [
    ['langfusePublicKey', process.env.LANGFUSE_PUBLIC_KEY],
    ['langfuseSecretKey', process.env.LANGFUSE_SECRET_KEY],
    ['langfuseBaseUrl',   process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST]
  ];
  let seeded = 0;
  for (const [k, v] of envSeeds) {
    if (!have.has(k) && v && String(v).trim()) { upsert.run(k, String(v).trim()); seeded++; }
  }
  if (seeded) console.log(`[seed] copied ${seeded} langfuse setting(s) from .env into sqlite`);
}

const CLICKHOUSE_INSTANCES = [
  {
    id: 'default',
    label: process.env.CLICKHOUSE_LABEL || 'Default (from .env)',
    url: process.env.CLICKHOUSE_URL,
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || ''
  }
];
const instancesById = Object.fromEntries(CLICKHOUSE_INSTANCES.map(i => [i.id, i]));

const INDUSTRY_PATHS = ['/', '/fs', '/igaming', '/construction', '/healthcare', '/admin'];
for (const p of INDUSTRY_PATHS) {
  app.get(p, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'website', 'index.html'));
  });
}

let langfuse = null;
function refreshLangfuse(opts) {
  const s = getAllSettings();
  const pk = (s.langfusePublicKey || '').trim();
  const sk = (s.langfuseSecretKey || '').trim();
  const baseUrl = (s.langfuseBaseUrl || '').trim() || 'https://cloud.langfuse.com';
  if (pk && sk) {
    langfuse = new Langfuse({ publicKey: pk, secretKey: sk, baseUrl });
    if (process.env.LANGFUSE_DEBUG === '1') langfuse.debug(true);
    if (!(opts && opts.silent)) console.log(`[langfuse] enabled host=${baseUrl}`);
  } else {
    langfuse = null;
    if (!(opts && opts.silent)) console.log('[langfuse] disabled (set public + secret keys in Site Administration → Observability)');
  }
}
refreshLangfuse({ silent: true });

function clickhouseQuery(sql, database, instanceId) {
  return new Promise((resolve, reject) => {
    const inst = instancesById[instanceId || 'default'] || instancesById['default'];
    const base = new URL(inst.url);
    const isHttps = base.protocol === 'https:';
    const transport = isHttps ? https : http;
    const params = new URLSearchParams();
    if (database) params.set('database', database);
    params.set('default_format', 'TabSeparatedWithNames');

    const body = Buffer.from(sql, 'utf8');
    const auth = Buffer.from(`${inst.user}:${inst.password}`).toString('base64');

    const options = {
      hostname: base.hostname,
      port: parseInt(base.port) || (isHttps ? 8443 : 8123),
      path: '/?' + params.toString(),
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'text/plain',
        'Content-Length': body.length
      }
    };

    const req = transport.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const msg = data.trim() || `HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim();
          reject(new Error(msg));
        } else {
          resolve(data.trim());
        }
      });
    });

    req.on('error', err => {
      reject(new Error(err.message || err.code || String(err)));
    });
    req.write(body);
    req.end();
  });
}

function parseStatements(script) {
  const statements = [];
  let current = '';

  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    if (/^USE\s+/i.test(trimmed)) continue;

    current += (current ? '\n' : '') + line;

    if (trimmed.endsWith(';')) {
      const stmt = current.replace(/;\s*$/, '').trim();
      if (stmt) statements.push(stmt);
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

app.get('/api/check-db/:dbName', async (req, res) => {
  try {
    const result = await clickhouseQuery(
      `SELECT count() FROM system.databases WHERE name = '${req.params.dbName}'`
    );
    res.json({ exists: result.trim() === '1' });
  } catch (err) {
    res.json({ exists: false });
  }
});

app.post('/api/deploy', async (req, res) => {
  const { script, dbName } = req.body;
  if (!script || !dbName) return res.status(400).json({ error: 'script and dbName required' });

  const statements = parseStatements(script);
  const errors = [];
  let executed = 0;

  console.log(`[deploy] dbName=${dbName} statements=${statements.length} scriptBytes=${script.length}`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const isDbLevel = /^(DROP|CREATE)\s+DATABASE/i.test(stmt);
    const preview = stmt.replace(/\s+/g, ' ').substring(0, 120);
    console.log(`[deploy] (${i + 1}/${statements.length}) ${isDbLevel ? '[db] ' : ''}${preview}${stmt.length > 120 ? '…' : ''}`);
    try {
      await clickhouseQuery(stmt + ';', isDbLevel ? null : dbName);
      executed++;
    } catch (err) {
      console.error(`[deploy] FAILED (${i + 1}/${statements.length}): ${err.message}`);
      console.error(`[deploy] full statement:\n${stmt}`);
      errors.push({ statement: stmt.substring(0, 200) + (stmt.length > 200 ? '…' : ''), error: err.message });
    }
  }

  console.log(`[deploy] done dbName=${dbName} executed=${executed} errors=${errors.length}`);

  if (executed === 0 && errors.length > 0) {
    return res.status(500).json({ success: false, errors });
  }

  res.json({ success: true, executed, errors });
});

app.post('/api/query', async (req, res) => {
  const { sql, dbName } = req.body;
  if (!sql) return res.status(400).json({ error: 'sql required' });
  try {
    const raw = await clickhouseQuery(sql, dbName || null);
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return res.json({ columns: [], rows: [] });
    const columns = lines[0].split('\t');
    const rows = lines.slice(1).map(l => l.split('\t'));
    res.json({ columns, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenario-overrides', (req, res) => {
  const rows = db.prepare('SELECT scenario_id AS scenarioId, status, tags, system_prompt AS systemPrompt, questions, expose_internals AS exposeInternals FROM scenario_overrides').all();
  res.json({
    overrides: rows.map(r => ({
      scenarioId: r.scenarioId,
      status: r.status || null,
      tags: r.tags ? JSON.parse(r.tags) : null,
      systemPrompt: r.systemPrompt || null,
      questions: r.questions ? JSON.parse(r.questions) : null,
      exposeInternals: r.exposeInternals === null || r.exposeInternals === undefined ? null : !!r.exposeInternals
    }))
  });
});

app.put('/api/scenario-overrides/:id', (req, res) => {
  const { status, tags, systemPrompt, questions, exposeInternals } = req.body || {};
  if (status !== undefined && status !== null && status !== 'draft' && status !== 'live') {
    return res.status(400).json({ error: "status must be 'draft' or 'live'" });
  }
  const existing = db.prepare('SELECT scenario_id, status, tags, system_prompt, questions, expose_internals FROM scenario_overrides WHERE scenario_id = ?').get(req.params.id);
  const nextStatus = status !== undefined ? status : (existing?.status ?? null);
  const nextTags = tags !== undefined ? JSON.stringify(normalizeTags(tags)) : (existing?.tags ?? null);
  const nextPrompt = systemPrompt !== undefined ? (String(systemPrompt).trim() || null) : (existing?.system_prompt ?? null);
  const nextQuestions = questions !== undefined ? JSON.stringify(normalizeQuestions(questions)) : (existing?.questions ?? null);
  const nextExpose = exposeInternals === undefined ? (existing?.expose_internals ?? null) : (exposeInternals ? 1 : 0);
  db.prepare(`
    INSERT INTO scenario_overrides (scenario_id, status, tags, system_prompt, questions, expose_internals) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scenario_id) DO UPDATE SET status=excluded.status, tags=excluded.tags, system_prompt=excluded.system_prompt, questions=excluded.questions, expose_internals=excluded.expose_internals
  `).run(req.params.id, nextStatus, nextTags, nextPrompt, nextQuestions, nextExpose);
  res.json({
    scenarioId: req.params.id,
    status: nextStatus,
    tags: nextTags ? JSON.parse(nextTags) : null,
    systemPrompt: nextPrompt,
    questions: nextQuestions ? JSON.parse(nextQuestions) : null,
    exposeInternals: nextExpose === null ? null : !!nextExpose
  });
});

app.get('/api/settings', (req, res) => {
  res.json({ settings: getAllSettings() });
});

app.put('/api/settings', (req, res) => {
  const incoming = req.body || {};
  const allowed = Object.keys(SETTING_DEFAULTS);
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, v);
  });
  const entries = Object.entries(incoming).filter(([k]) => allowed.includes(k)).map(([k, v]) => [k, String(v ?? '')]);
  tx(entries);
  if (entries.some(([k]) => k === 'langfusePublicKey' || k === 'langfuseSecretKey' || k === 'langfuseBaseUrl')) {
    refreshLangfuse();
  }
  res.json({ settings: getAllSettings() });
});

app.get('/api/clickhouse-instances', (req, res) => {
  res.json({ instances: CLICKHOUSE_INSTANCES.map(({ id, label, url }) => ({ id, label, url })) });
});

app.get('/api/models', (req, res) => {
  res.json({
    models: PROVIDERS.map(p => ({
      id: p.id,
      label: `${p.name} — ${p.model}`,
      provider: p.name,
      model: p.model
    }))
  });
});

function providerRowToJson(r) {
  return {
    id: r.id,
    name: r.name,
    apiKey: r.api_key || '',
    baseUrl: r.base_url,
    model: r.model,
    createdAt: r.created_at
  };
}

app.get('/api/providers', (req, res) => {
  const rows = db.prepare('SELECT id, name, api_key, base_url, model, created_at FROM providers ORDER BY created_at ASC').all();
  res.json({ providers: rows.map(providerRowToJson) });
});

app.post('/api/providers', (req, res) => {
  const { name, apiKey, baseUrl, model } = req.body || {};
  if (!name?.trim() || !baseUrl?.trim() || !model?.trim()) {
    return res.status(400).json({ error: 'name, baseUrl, and model are required' });
  }
  const id = `provider-${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = Date.now();
  db.prepare('INSERT INTO providers (id, name, api_key, base_url, model, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name.trim(), (apiKey || '').trim(), baseUrl.trim(), model.trim(), createdAt);
  refreshProviders();
  const row = db.prepare('SELECT id, name, api_key, base_url, model, created_at FROM providers WHERE id = ?').get(id);
  res.json({ provider: providerRowToJson(row) });
});

app.patch('/api/providers/:id', (req, res) => {
  const { name, apiKey, baseUrl, model } = req.body || {};
  const sets = [];
  const args = [];
  if (typeof name === 'string' && name.trim())    { sets.push('name = ?');     args.push(name.trim()); }
  if (typeof apiKey === 'string')                 { sets.push('api_key = ?');  args.push(apiKey.trim()); }
  if (typeof baseUrl === 'string' && baseUrl.trim()) { sets.push('base_url = ?'); args.push(baseUrl.trim()); }
  if (typeof model === 'string' && model.trim()) { sets.push('model = ?');    args.push(model.trim()); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  args.push(req.params.id);
  const info = db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (!info.changes) return res.status(404).json({ error: 'Provider not found' });
  refreshProviders();
  const row = db.prepare('SELECT id, name, api_key, base_url, model, created_at FROM providers WHERE id = ?').get(req.params.id);
  res.json({ provider: providerRowToJson(row) });
});

app.delete('/api/providers/:id', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM providers').get().c;
  if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last provider — the app needs at least one.' });
  const info = db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Provider not found' });
  refreshProviders();
  res.json({ deleted: info.changes });
});

function rowToAgent(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    longDescription: r.longDescription || null,
    sector: r.sector || null,
    sectorLabel: r.sectorLabel || null,
    model: r.model,
    systemPrompt: r.systemPrompt,
    instanceId: r.instanceId,
    dbName: r.dbName,
    status: r.status,
    tags: r.tags ? JSON.parse(r.tags) : [],
    questions: r.questions ? JSON.parse(r.questions) : [],
    schema: r.schema || null,
    sampleData: r.sampleData || null,
    allowDeploy: r.allowDeploy !== 0,
    isBuiltin: r.isBuiltin === 1,
    exposeInternals: r.exposeInternals !== 0,
    createdAt: r.createdAt
  };
}

app.get('/api/agents', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, description, long_description AS longDescription,
           sector, sector_label AS sectorLabel,
           model, system_prompt AS systemPrompt,
           instance_id AS instanceId, db_name AS dbName, status, tags, questions,
           agent_schema AS schema, sample_data AS sampleData,
           allow_deploy AS allowDeploy, is_builtin AS isBuiltin,
           expose_internals AS exposeInternals,
           created_at AS createdAt
    FROM agents ORDER BY is_builtin DESC, created_at ASC
  `).all();
  res.json({ agents: rows.map(rowToAgent) });
});

app.post('/api/agents', (req, res) => {
  const { name, description, model, systemPrompt, instanceId, dbName, status, tags, questions } = req.body || {};
  if (!name || !model || !systemPrompt || !instanceId || !dbName) {
    return res.status(400).json({ error: 'name, model, systemPrompt, instanceId, and dbName are required' });
  }
  if (!instancesById[instanceId]) {
    return res.status(400).json({ error: `Unknown ClickHouse instance: ${instanceId}` });
  }
  const finalStatus = status === 'draft' ? 'draft' : 'live';
  const finalTags = JSON.stringify(normalizeTags(tags));
  const finalQuestions = JSON.stringify(normalizeQuestions(questions));
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO agents (id, name, description, model, system_prompt, instance_id, db_name, status, tags, questions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description || '', model, systemPrompt, instanceId, dbName, finalStatus, finalTags, finalQuestions, createdAt);
  res.json({
    agent: { id, name, description: description || '', model, systemPrompt, instanceId, dbName,
             status: finalStatus, tags: JSON.parse(finalTags), questions: JSON.parse(finalQuestions), createdAt }
  });
});

app.patch('/api/agents/:id', (req, res) => {
  const { status, tags, name, description, systemPrompt, questions } = req.body || {};
  const sets = [];
  const args = [];
  if (status !== undefined) {
    if (status !== 'draft' && status !== 'live') {
      return res.status(400).json({ error: "status must be 'draft' or 'live'" });
    }
    sets.push('status = ?'); args.push(status);
  }
  if (tags !== undefined) {
    sets.push('tags = ?'); args.push(JSON.stringify(normalizeTags(tags)));
  }
  if (questions !== undefined) {
    sets.push('questions = ?'); args.push(JSON.stringify(normalizeQuestions(questions)));
  }
  if (typeof name === 'string') { sets.push('name = ?'); args.push(name); }
  if (typeof description === 'string') { sets.push('description = ?'); args.push(description); }
  if (typeof systemPrompt === 'string') { sets.push('system_prompt = ?'); args.push(systemPrompt); }
  if (req.body && req.body.exposeInternals !== undefined) {
    sets.push('expose_internals = ?'); args.push(req.body.exposeInternals ? 1 : 0);
  }
  if (req.body && req.body.allowDeploy !== undefined) {
    sets.push('allow_deploy = ?'); args.push(req.body.allowDeploy ? 1 : 0);
  }
  if (typeof req.body?.model === 'string' && req.body.model.trim()) { sets.push('model = ?'); args.push(req.body.model.trim()); }
  if (typeof req.body?.schema === 'string') { sets.push('agent_schema = ?'); args.push(req.body.schema); }
  if (typeof req.body?.sampleData === 'string') { sets.push('sample_data = ?'); args.push(req.body.sampleData); }
  if (typeof req.body?.longDescription === 'string') { sets.push('long_description = ?'); args.push(req.body.longDescription); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  args.push(req.params.id);
  const info = db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  if (!info.changes) return res.status(404).json({ error: 'Agent not found' });
  res.json({ updated: info.changes });
});

app.delete('/api/agents/:id', (req, res) => {
  const info = db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
  res.json({ deleted: info.changes });
});

app.post('/api/chat', async (req, res) => {
  const { message, scenario, customAgent } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const instanceId = customAgent?.instanceId || 'default';
  const dbName = customAgent?.dbName || scenario?.dbName || null;
  const requestedModel = customAgent?.model || getDefaultModelId();
  if (!requestedModel || PROVIDERS.length === 0) {
    return res.status(500).json({ error: 'No LLM providers configured. Add one under Site Administration → Providers.' });
  }
  const provider = resolveProvider(requestedModel);
  const client = provider.client;
  const targetModel = provider.model;

  let baseSystem;
  if (customAgent?.systemPrompt) {
    baseSystem = customAgent.schema
      ? `${customAgent.systemPrompt}\n\nDatabase schema:\n${customAgent.schema}`
      : customAgent.systemPrompt;
  } else if (scenario?.systemPrompt) {
    baseSystem = `${scenario.systemPrompt}\n\nDatabase schema:\n${scenario.schema}`;
  } else if (scenario) {
    baseSystem = `You are an AI analyst for the "${scenario.title}" scenario (${scenario.sectorLabel}). ${scenario.description}\n\nDatabase schema:\n${scenario.schema}`;
  } else {
    baseSystem = 'You are an AI agent assistant for a ClickHouse agentic analytics platform covering financial services, iGaming, construction, and healthcare scenarios.';
  }

  const systemPrompt = customAgent
    ? `${baseSystem}\n\nYou have access to a ClickHouse database named '${dbName}'. Always use the query_clickhouse tool to retrieve real data before answering. Present tabular results as markdown tables.`
    : `${baseSystem}\n\nYou are ${provider.model} served by ${provider.name}. If asked what model you are or who hosts you, answer truthfully with those names.\n\nAlways use the query_clickhouse tool to retrieve real data before answering. Present results as markdown tables. If a query fails because the database doesn't exist, tell the user to click "Deploy This Example" first.`;

  const tools = [{
    type: 'function',
    function: {
      name: 'query_clickhouse',
      description: `Run a SQL SELECT query against ClickHouse database '${dbName}'. Returns tab-separated results with a header row. Always use this tool to answer analytical questions with real data.`,
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'ClickHouse SQL to execute. No trailing semicolon.' }
        },
        required: ['sql']
      }
    }
  }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (req.socket) req.socket.setNoDelay(true);
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const trace = langfuse ? langfuse.trace({
    name: 'chat',
    input: message,
    metadata: {
      scenario: scenario?.title,
      sector: scenario?.sectorLabel,
      customAgent: customAgent?.name,
      model: requestedModel,
      provider: provider.name,
      resolvedModel: targetModel,
      instanceId,
      dbName
    }
  }) : null;

  const streamLLM = async (messages, opts = {}) => {
    const toolChoice = opts.toolChoice ?? 'auto';
    for (let attempt = 0; attempt < 4; attempt++) {
      const generation = trace ? trace.generation({
        name: `${provider.name}.chat.completions`,
        model: targetModel,
        modelParameters: { max_tokens: 12000, tool_choice: toolChoice },
        input: { messages, tools: toolChoice === 'none' ? [] : tools }
      }) : null;
      const tStart = Date.now();
      let tFirstByte = null;
      try {
        const req = {
          model: targetModel,
          max_tokens: 12000,
          stream: true,
          stream_options: { include_usage: true },
          messages
        };
        if (toolChoice !== 'none') {
          req.tools = tools;
          req.tool_choice = toolChoice;
        }
        const stream = await client.chat.completions.create(req);
        const tHeaders = Date.now();
        console.log(`[chat] llm headers=${tHeaders - tStart}ms attempt=${attempt} provider=${provider.name} model=${targetModel}`);

        let assembledText = '';
        let assembledReasoning = '';
        const toolCallsByIndex = new Map();
        let finishReason = null;
        let usage = null;

        for await (const chunk of stream) {
          const choice = chunk.choices && chunk.choices[0];
          if (!choice) {
            if (chunk.usage) usage = chunk.usage;
            continue;
          }
          const delta = choice.delta || {};

          if (typeof delta.content === 'string' && delta.content.length) {
            if (tFirstByte === null) {
              tFirstByte = Date.now();
              console.log(`[chat] llm first-token=${tFirstByte - tStart}ms`);
            }
            assembledText += delta.content;
            send({ type: 'text', text: delta.content });
          }
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
            assembledReasoning += delta.reasoning_content;
            send({ type: 'thinking', text: delta.reasoning_content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let entry = toolCallsByIndex.get(idx);
              if (!entry) {
                entry = { id: '', type: 'function', function: { name: '', arguments: '' } };
                toolCallsByIndex.set(idx, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.function.name = tc.function.name;
              if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }

        const toolCalls = [...toolCallsByIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v);

        if (generation) {
          generation.end({
            output: { content: assembledText, reasoning: assembledReasoning, tool_calls: toolCalls },
            usage: usage ? {
              input: usage.prompt_tokens,
              output: usage.completion_tokens,
              total: usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
            } : undefined,
            metadata: { finish_reason: finishReason, attempt }
          });
        }

        const tDone = Date.now();
        console.log(`[chat] llm total=${tDone - tStart}ms toolCalls=${toolCalls.length} finish=${finishReason} promptTokens=${usage?.prompt_tokens ?? '?'} outTokens=${usage?.completion_tokens ?? '?'}`);
        return { text: assembledText, toolCalls, finishReason };
      } catch (err) {
        if (generation) {
          generation.end({ level: 'ERROR', statusMessage: err.message, metadata: { attempt } });
        }
        const status = err.status || err.response?.status;
        if ((status === 429 || (status >= 500 && status < 600)) && attempt < 3) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  };

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ];
    let queryIndex = 0;
    let lastAssistantText = '';

    const MAX_TOOL_ITERATIONS = 25;
    let hitToolLoopCap = false;
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const { text, toolCalls, finishReason } = await streamLLM(messages);
      lastAssistantText = text;

      if (finishReason !== 'tool_calls' || toolCalls.length === 0) break;
      if (i === MAX_TOOL_ITERATIONS - 1) { hitToolLoopCap = true; break; }

      messages.push({
        role: 'assistant',
        content: text || '',
        tool_calls: toolCalls
      });

      await Promise.all(toolCalls.map(async toolCall => {
        const idx = queryIndex++;
        let sql = '';
        try {
          sql = JSON.parse(toolCall.function.arguments || '{}').sql || '';
        } catch (e) {
          sql = '';
        }
        const span = trace ? trace.span({
          name: 'query_clickhouse',
          input: { sql, dbName }
        }) : null;
        send({ type: 'query_start', sql, index: idx });
        let content;
        if (!sql) {
          content = `Query error: tool call had no valid sql argument`;
          send({ type: 'query_done', index: idx, error: 'no sql argument' });
          if (span) span.end({ level: 'ERROR', statusMessage: 'no sql argument' });
        } else {
          try {
            const raw = await clickhouseQuery(sql, dbName, instanceId);
            content = raw || '(empty result set)';
            if (content.length > 8000) content = content.substring(0, 8000) + '\n…(truncated)';
            const rowCount = content === '(empty result set)' ? 0 : Math.max(0, content.split('\n').filter(Boolean).length - 1);
            send({ type: 'query_done', index: idx, rowCount });
            if (span) span.end({ output: { rowCount, preview: content.substring(0, 500) } });
          } catch (err) {
            content = `Query error: ${err.message}`;
            send({ type: 'query_done', index: idx, error: err.message });
            if (span) span.end({ level: 'ERROR', statusMessage: err.message });
          }
        }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content
        });
      }));
    }

    if (!lastAssistantText.trim()) {
      console.log(`[chat] final response empty (hitToolLoopCap=${hitToolLoopCap}); forcing summary with tool_choice=none`);
      const summaryPrompt = hitToolLoopCap
        ? `You have used the maximum number of query attempts (${MAX_TOOL_ITERATIONS}). Summarise the findings from the queries you have already run so far, in a helpful markdown answer for the user. Do not attempt any more queries.`
        : `Provide a final markdown answer for the user based on the queries you have already run. Do not make any more tool calls.`;
      const forcedMessages = [...messages, { role: 'user', content: summaryPrompt }];
      const { text: forcedText } = await streamLLM(forcedMessages, { toolChoice: 'none' });
      if (forcedText.trim()) lastAssistantText = forcedText;
    }

    if (trace) {
      trace.update({ output: lastAssistantText });
      await langfuse.flushAsync();
    }
    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error(`${provider.name} error:`, err.message);
    if (trace) {
      trace.update({ output: err.message, metadata: { error: true } });
      await langfuse.flushAsync().catch(() => {});
    }
    send({ type: 'error', message: err.message });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}

function startup() {
  // Providers
  if (PROVIDERS.length === 0) {
    console.log('Providers: none configured');
    console.log('  Add one in Site Administration → Providers, or set PROVIDER_1_* in .env\n');
  } else {
    console.log(`Providers (${PROVIDERS.length}):`);
    PROVIDERS.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.name} — ${p.model}${i === 0 ? ' (default)' : ''}`);
    });
    console.log('');
  }

  // Agents and observability
  const agentCount = db.prepare('SELECT COUNT(*) AS c FROM agents').get().c;
  console.log(`Agents: ${agentCount}`);
  console.log(`Observability: ${langfuse ? 'Langfuse enabled' : 'disabled'}\n`);

  // Start HTTP server FIRST (non-blocking)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`  URL:  http://localhost:${PORT}\n`);
  });

  // Test ClickHouse connection in background (non-blocking, 6 second timeout)
  const inst = instancesById['default'];
  console.log(`Testing connection to "${inst.label}" (${inst.url})...`);
  withTimeout(clickhouseQuery('SELECT 1'), 6000)
    .then(() => console.log('ClickHouse connection successful!\n'))
    .catch(err => {
      console.log(`ClickHouse connection failed: ${err.message}`);
      console.log('The UI still loads — set CLICKHOUSE_* in .env and restart, or configure it in Site Administration.\n');
    });
}

startup();
