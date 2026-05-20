require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const https = require('https');
const OpenAI = require('openai');
const { Langfuse } = require('langfuse');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'website')));

const INDUSTRY_PATHS = ['/', '/fs', '/igaming', '/construction'];
for (const p of INDUSTRY_PATHS) {
  app.get(p, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'website', 'index.html'));
  });
}

const client = new OpenAI({
  apiKey: process.env.FIREWORKS_API_KEY,
  baseURL: process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1'
});
const MODEL = process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/deepseek-v4-pro';
const BASE_URL = process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1';
console.log(`[llm] provider=fireworks model=${MODEL} baseURL=${BASE_URL}`);

const langfuse = (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)
  ? new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_HOST || 'http://78.47.43.63:3000'
    })
  : null;
if (langfuse) console.log(`[langfuse] enabled host=${process.env.LANGFUSE_HOST || 'http://78.47.43.63:3000'}`);
else console.log('[langfuse] disabled (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to enable)');

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
    baseSystem = 'You are an AI agent assistant for a ClickHouse Agentic AI demonstrator covering financial services, iGaming, and construction scenarios.';
  }

  const systemPrompt = `${baseSystem}\n\nYou are DeepSeek V4 Pro running on Fireworks AI (not Claude, not GPT). If asked what model you are or who hosts you, answer truthfully: "DeepSeek V4 Pro, served by Fireworks AI."\n\nAlways use the query_clickhouse tool to retrieve real data before answering. Present results as markdown tables. If a query fails because the database doesn't exist, tell the user to click "Deploy This Example" first.`;

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
      dbName
    }
  }) : null;

  const streamLLM = async (messages) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const generation = trace ? trace.generation({
        name: 'fireworks.chat.completions',
        model: MODEL,
        modelParameters: { max_tokens: 12000 },
        input: { messages, tools }
      }) : null;
      try {
        const stream = await client.chat.completions.create({
          model: MODEL,
          max_tokens: 12000,
          stream: true,
          tools,
          tool_choice: 'auto',
          messages
        });

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

    for (let i = 0; i < 6; i++) {
      const { text, toolCalls, finishReason } = await streamLLM(messages);
      lastAssistantText = text;

      if (finishReason !== 'tool_calls' || toolCalls.length === 0) break;

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
            const raw = await clickhouseQuery(sql, dbName);
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

    if (trace) {
      trace.update({ output: lastAssistantText });
      await langfuse.flushAsync();
    }
    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('Fireworks error:', err.message);
    if (trace) {
      trace.update({ output: err.message, metadata: { error: true } });
      await langfuse.flushAsync().catch(() => {});
    }
    send({ type: 'error', message: err.message });
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
