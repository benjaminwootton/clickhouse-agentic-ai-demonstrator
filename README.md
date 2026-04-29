# clickhouse-agentic-ai-demonstrator

An agentic AI demonstrator showing how Claude can analyse financial services data stored in ClickHouse. The app exposes a chat interface where Claude is given a `query_clickhouse` tool, lets it issue SQL against scenario-specific databases, and streams thinking, tool calls, and results back to the browser in real time.

## Stack

- **Backend** — Node.js + Express (`server/server.js`)
- **LLM** — Anthropic Claude (`claude-sonnet-4-6`) via the `@anthropic-ai/sdk`, with extended thinking and streaming tool use
- **Database** — ClickHouse (Cloud or self-hosted) accessed over HTTPS
- **Frontend** — Static HTML/CSS/JS served from `website/`
- **Deployment** — Dockerfile + docker-compose

## Endpoints

- `POST /api/chat` — streams Claude's response (text, thinking, tool calls) over SSE
- `POST /api/query` — runs a SQL query directly against ClickHouse
- `POST /api/deploy` — executes a multi-statement SQL script to seed a scenario database
- `GET  /api/check-db/:dbName` — checks whether a scenario database already exists

## Configuration

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=...
CLICKHOUSE_URL=https://<host>:8443
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=...
```

## Running locally

```bash
cd server && npm install && npm start
```

Then open http://localhost:3000.

## Running with Docker

```bash
docker compose up --build
```
