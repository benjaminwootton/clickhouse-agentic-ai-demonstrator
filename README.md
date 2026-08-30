A platform for agentic analytics against ClickHouse. Point it at your data, give it a schema, and ask questions in plain language — a model writes the SQL, runs it against ClickHouse, and shows you its reasoning, the queries it issued, and the rows that came back. It ships with 92 example scenarios across four industries so you can see the shape of it before pointing it at anything of your own.

By [Benjamin Wootton](https://benjaminwootton.com).

## Running

Clone the repository and create your config:

```bash
git clone https://github.com/benjaminwootton/clickhouse-agentic-analytics-platform
cd clickhouse-agentic-analytics-platform
cp .env.example .env
```

`.env.example` is set up for a ClickHouse running locally on port 8123 over plain HTTP, so if that is what you have, it works unedited. It is commented throughout, including how to reach a ClickHouse on your own machine from inside the container and what to do when that connection times out.

ClickHouse is the one thing the app requires — it refuses to start if `CLICKHOUSE_URL` is unset or malformed, and names what is missing rather than failing later with a confusing error. Model providers are optional at boot and can be added from the admin UI.

Start with Docker Compose:

```bash
docker compose up --build
```

Access the UI at http://localhost:3000.

## Model providers

Any OpenAI-compatible endpoint works — the app talks to providers through the OpenAI SDK and only needs a base URL, a model id, and an API key. That covers Fireworks, Baseten, Together, Groq, OpenRouter, OpenAI itself, and anything you self-host behind vLLM, Ollama, or llama.cpp.

Configure up to five providers in `.env` with the `PROVIDER_1_` through `PROVIDER_5_` prefixes:

```bash
PROVIDER_1_NAME=Fireworks
PROVIDER_1_API_KEY=your-api-key
PROVIDER_1_BASE_URL=https://api.fireworks.ai/inference/v1
PROVIDER_1_MODEL=accounts/fireworks/models/deepseek-v4-pro
```

Providers from `.env` are copied into the local database on first boot. After that they are managed from **Site Administration → Providers**, where you can add, edit, and remove them without restarting. Every configured provider appears in a picker on the agent page, so you can put the same question to several models and compare how they reason and what SQL they write.

An API key is optional, which is what makes unauthenticated local endpoints work.

## Agents

An agent is a ClickHouse schema, a system prompt, and a set of suggested questions. Ask one a question and the answer streams back as it happens — the model's reasoning, the `query_clickhouse` tool calls it makes, the SQL it wrote, and the rows that came back, followed by its interpretation. Seeing the SQL matters: it is the difference between trusting an answer and checking one.

Build your own from **Site Administration → Agents** by supplying a schema and, optionally, sample data. Custom agents behave exactly like the bundled ones.

## Example scenarios

The bundled scenarios live in [`server/seed-builtins.json`](server/seed-builtins.json) — a single JSON array where each entry is one agent:

```json
{
  "id": "patient-safety-incidents",
  "name": "Patient Safety Incident Agent",
  "description": "Analyse patient safety incidents — falls, medication errors...",
  "sector": "ps",
  "sectorLabel": "Patient Safety",
  "schema": "-- Patient Safety Incident Schema\nCREATE TABLE incidents (...)",
  "sampleData": "INSERT INTO incidents SELECT ... FROM numbers(420);",
  "systemPrompt": "You are a patient safety analyst...",
  "questions": ["What is our incident rate per 1,000 occupied bed days by ward?"],
  "status": "live",
  "tags": ["Patient Safety"]
}
```

On first boot the file is read and any agent whose `id` is not already in the local database is inserted, so adding an entry and restarting picks it up without disturbing anything already there. Editing an existing entry does not overwrite what is already stored — change those from the admin UI.

`schema` and `sampleData` are ordinary ClickHouse SQL. Deploy a scenario from its page and the app creates the database and runs both, which takes a few seconds and turns a catalogue entry into something you can genuinely interrogate. All the data is synthetic; none of it points at anything real.

The bundled set covers 92 agents across 25 sectors and four industries:

| Industry | Path | Sectors |
| --- | --- | --- |
| Financial Services | `/fs` | Capital markets, retail and commercial banking, payments, compliance, wealth and asset management, insurance, tax, private equity, accounting, crypto, corporate finance, valuations |
| iGaming | `/igaming` | Sportsbook trading, casino and live games, player CRM, responsible gambling and fraud, affiliates |
| Construction | `/construction` | Cost planning, quantity surveying, project controls, procurement, safety and quality |
| Healthcare | `/healthcare` | Patient safety |

## Observability

Set Langfuse credentials to trace every conversation — prompts, completions, tool calls, latency, and token counts:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=
```

Leave `LANGFUSE_HOST` empty for Langfuse Cloud, or point it at a self-hosted instance. Tracing stays off until both keys are present, and can also be configured from **Site Administration → Observability**.

## How it works

- **Backend** — Node.js and Express (`server/server.js`), streaming responses over SSE
- **LLM** — any OpenAI-compatible provider, with streaming tool use
- **Database** — ClickHouse, Cloud or self-hosted, over HTTP
- **State** — SQLite at `server/data.sqlite` for providers, agents, and settings
- **Frontend** — static HTML, CSS, and JavaScript served from `website/`

To run it directly rather than in Docker:

```bash
cd server && npm install && npm start
```

### Next Steps

Please visit https://benjaminwootton.com for more details on the project and my ClickHouse consulting services.
