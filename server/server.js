require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'website')));

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

function clickhouseQuery(sql, database) {
  return new Promise((resolve, reject) => {
    const base = new URL(process.env.CLICKHOUSE_URL || 'https://localhost:8443');
    const isHttps = base.protocol === 'https:';
    const transport = isHttps ? https : http;
    const params = new URLSearchParams();
    if (database) params.set('database', database);
    params.set('default_format', 'TabSeparatedWithNames');

    const body = Buffer.from(sql, 'utf8');
    const auth = Buffer.from(
      `${process.env.CLICKHOUSE_USER || 'default'}:${process.env.CLICKHOUSE_PASSWORD || ''}`
    ).toString('base64');

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

app.post('/api/chat', async (req, res) => {
  const { message, scenario } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const dbName = scenario?.dbName || null;

  let baseSystem;
  if (scenario?.systemPrompt) {
    baseSystem = `${scenario.systemPrompt}\n\nDatabase schema:\n${scenario.schema}`;
  } else if (scenario) {
    baseSystem = `You are an AI analyst for the "${scenario.title}" scenario (${scenario.sectorLabel}). ${scenario.description}\n\nDatabase schema:\n${scenario.schema}`;
  } else {
    baseSystem = 'You are an AI agent assistant for a ClickHouse financial services demonstrator.';
  }

  const systemPrompt = `${baseSystem}\n\nAlways use the query_clickhouse tool to retrieve real data before answering. Present results as markdown tables. If a query fails because the database doesn't exist, tell the user to click "Deploy This Example" first.`;

  const tools = [{
    name: 'query_clickhouse',
    description: `Run a SQL SELECT query against ClickHouse database '${dbName}'. Returns tab-separated results with a header row. Always use this tool to answer analytical questions with real data.`,
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'ClickHouse SQL to execute. No trailing semicolon.' }
      },
      required: ['sql']
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

  const streamClaude = async (messages) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const stream = client.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 12000,
          thinking: { type: 'enabled', budget_tokens: 3000 },
          system: systemPrompt,
          tools,
          messages
        });

        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              send({ type: 'text', text: event.delta.text });
            } else if (event.delta.type === 'thinking_delta') {
              send({ type: 'thinking', text: event.delta.thinking });
            }
          }
        }

        return await stream.finalMessage();
      } catch (err) {
        if (err.status === 529 && attempt < 3) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  };

  try {
    const messages = [{ role: 'user', content: message }];
    let queryIndex = 0;

    for (let i = 0; i < 6; i++) {
      const finalMsg = await streamClaude(messages);

      if (finalMsg.stop_reason !== 'tool_use') break;

      const toolUses = finalMsg.content.filter(b => b.type === 'tool_use');
      const assistantContent = finalMsg.content.filter(b => b.type !== 'thinking' || b.thinking);
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResults = await Promise.all(toolUses.map(async toolUse => {
        const idx = queryIndex++;
        send({ type: 'query_start', sql: toolUse.input.sql, index: idx });
        let content;
        try {
          const raw = await clickhouseQuery(toolUse.input.sql, dbName);
          content = raw || '(empty result set)';
          if (content.length > 8000) content = content.substring(0, 8000) + '\n…(truncated)';
          const rowCount = content === '(empty result set)' ? 0 : Math.max(0, content.split('\n').filter(Boolean).length - 1);
          send({ type: 'query_done', index: idx, rowCount });
        } catch (err) {
          content = `Query error: ${err.message}`;
          send({ type: 'query_done', index: idx, error: err.message });
        }
        return { type: 'tool_result', tool_use_id: toolUse.id, content };
      }));

      messages.push({ role: 'user', content: toolResults });
    }

    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('Anthropic error:', err.message);
    send({ type: 'error', message: err.message });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
