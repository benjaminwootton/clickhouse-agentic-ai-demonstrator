# clickhouse-agentic-ai-demonstrator

An agentic AI demonstrator showing how DeepSeek V4 Pro on Fireworks AI can analyse financial services data stored in ClickHouse. The app exposes a chat interface where the model is given a `query_clickhouse` tool, lets it issue SQL against scenario-specific databases, and streams thinking, tool calls, and results back to the browser in real time.

## Stack

- **Backend** — Node.js + Express (`server/server.js`)
- **LLM** — DeepSeek V4 Pro via Fireworks AI's OpenAI-compatible API, with streaming tool use
- **Database** — ClickHouse (Cloud or self-hosted) accessed over HTTPS
- **Frontend** — Static HTML/CSS/JS served from `website/`
- **Deployment** — Dockerfile + docker-compose

## Endpoints

- `POST /api/chat` — streams the model response (text, thinking, tool calls) over SSE
- `POST /api/query` — runs a SQL query directly against ClickHouse
- `POST /api/deploy` — executes a multi-statement SQL script to seed a scenario database
- `GET  /api/check-db/:dbName` — checks whether a scenario database already exists

## Configuration

Copy `.env.example` to `.env` and fill in:

```
FIREWORKS_API_KEY=...
FIREWORKS_MODEL=accounts/fireworks/models/deepseek-v4-pro
FIREWORKS_BASE_URL=https://api.fireworks.ai/inference/v1
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
