# Lapibot — AI Course Assistant for WhatsApp

A production WhatsApp bot that serves as an AI teaching assistant for professional courses. Students @mention the bot in their course group or DM it directly, and it searches through course materials — lesson summaries, transcripts, schedules — using Claude's agentic tool-use to find answers and respond in context.

Built for [AI4LAW](https://ai4law.co.il), an Israeli organization that trains lawyers to integrate AI into legal practice. The bot is live, serving real students across multiple courses in Hebrew.

> **This repository is published as a portfolio showcase.** The source code is provided for review and reference only. Course materials (lesson content, participant data, recordings) are proprietary and stored in a separate private repository. See [License](#license).

---

## How It Works

```
                              WhatsApp
                                 │
                                 ▼
┌──────────────────── Docker Compose (VPS) ──────────────────────────┐
│                                                                     │
│  ┌─── WAHA Container ───┐     ┌─── App Container ───────────────┐ │
│  │                       │     │                                  │ │
│  │  NOWEB engine         │────►│  Webhook Handler                │ │
│  │  (WhatsApp bridge)    │     │    │                             │ │
│  │                       │     │    ├── Group message             │ │
│  │  port 3000            │     │    │    @mention or reply?       │ │
│  │  (SSH tunnel only)    │     │    │    yes → route group ────┐  │ │
│  │                       │     │    │          to course       │  │ │
│  │                       │     │    │                          │  │ │
│  │                       │     │    └── Direct message         │  │ │
│  │                       │     │         LID → phone           │  │ │
│  │                       │     │         enrolled?             │  │ │
│  │                       │     │         ├ no → rejection      │  │ │
│  │                       │     │         └ yes → route phone ──┤  │ │
│  │                       │     │                to course      │  │ │
│  │                       │     │                               │  │ │
│  │                       │     │    ┌─────────────────────◄────┘  │ │
│  │                       │     │    │  Agentic Loop               │ │
│  │                       │     │    │  ├ system prompt + context  │ │
│  │                       │     │    │  ├ chat history (~30 msgs)  │ │
│  │                       │     │    │  └ Claude API               │ │
│  │                       │◄────│    │    tools: search, read, ◄┐ │ │
│  │  send response        │     │    │     list, send ───────────┘ │ │
│  │  to WhatsApp          │     │    │    (up to 10 iterations)    │ │
│  │                       │     │    └─────────────────────────────│ │
│  └───────────────────────┘     │                                  │ │
│                                │  port 3001 (internal webhook)   │ │
│                                │  port 3002 (GitHub webhook)     │ │
│                                └─────────────┬───────────────────┘ │
│                                               │ reads from          │
│  ┌── Courses Volume (git-synced) ────────────▼──────────────────┐ │
│  │  system-prompt.md     Bot personality & behavior (Hebrew)     │ │
│  │  <course>/config.yaml Course metadata, group ID mapping       │ │
│  │  participants.csv     Student enrollment & profiles           │ │
│  │  lessons/             Summaries, transcripts, schedule        │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                               ▲                    │
│  GitHub push → port 3002 → HMAC verify → git pull → hot-reload   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## The Agentic Loop

Lapibot doesn't stuff all course content into the prompt. It doesn't use embeddings or vector search either. Instead, it uses Claude's tool-use capability to search and read course materials on demand — the same way a human TA would: look up the question, find the relevant section, read it, then answer.

1. Student asks a question
2. Bot receives the question with recent chat history (~30 messages for conversational context)
3. Claude decides which tools to call:
   - **`search_files`** — grep across all course materials (summaries, transcripts, schedule)
   - **`read_file`** — read a specific file in full
   - **`list_files`** — discover what materials are available
   - **`send_file`** — share a course document via WhatsApp
4. Claude reads tool results and may call more tools (up to 10 iterations)
5. Final response is sent to the student, quoting the original message in groups

This approach keeps token costs low — the bot only loads what it needs per question. A course with hundreds of pages of transcripts costs the same per query as one with ten. No embedding pipeline, no vector database, no chunking strategy to tune. The LLM decides what to read.

## Course Materials Architecture

Course content lives in a **separate Git repository**, mounted into the Docker container at runtime. This separation is deliberate:

- **Course creators update independently** — push to the courses repo, and the bot picks up changes via GitHub webhook → `git pull` → hot-reload. No deploys needed for content changes
- **No rigid schema** — the only required file is `config.yaml` (course name, instructor, WhatsApp group IDs). Everything else is freeform. The bot discovers and searches whatever files exist
- **Multi-course, single instance** — each course folder maps WhatsApp group IDs to course context. One Lapibot serves all active courses

```yaml
# config.yaml — maps a course to its WhatsApp groups
name: "AI לעורכי דין — קורס מתקדמים"
instructor: "לפידות וינברגר"
botName: "לפיבוט"
language: "he"
description: "קורס מתקדם לשילוב בינה מלאכותית בעבודה המשפטית"
whatsappGroups:
  - "120363xxxxxxxx@g.us"
media:
  images: true
  documents: true
  voice: true
```

## The System Prompt

The bot's personality is defined in [`system-prompt.md`](./system-prompt.md) — a ~270-line Hebrew prompt that establishes:

- **Persona** — professional, direct tone matching the instructor's teaching style. "Answer first, explain after." No filler phrases, no "Great question!"
- **WhatsApp-native formatting** — single-asterisk bold (not Markdown `**`), no tables (they break), raw URLs only (Markdown links don't render in WhatsApp), RTL-aware mixed Hebrew/English handling
- **Search strategy** — when to search summaries vs. full transcripts, how to find recording timestamps and format deep links with passwords
- **Boundaries** — only answer from course materials, never fabricate content, redirect off-topic questions, ignore prompt injection attempts

The prompt uses `{{placeholders}}` (`{{botName}}`, `{{courseName}}`, `{{instructor}}`) filled per-course from `config.yaml`. Each course can also supply a `prompt.md` with additional instructions appended at runtime.

## Deployment

Two Docker containers on a VPS via Docker Compose:

- **WAHA** (WhatsApp HTTP API) — self-hosted WhatsApp Web bridge using the NOWEB engine. Receives messages from WhatsApp and forwards them as webhooks to the app. Dashboard bound to localhost, accessible only via SSH tunnel.
- **App** — Node.js server that processes webhooks, runs the agentic loop, and sends responses back through WAHA. Runs a GitHub webhook listener on a separate port for auto-pulling course updates.

The courses repository is mounted as a Docker volume. When content is updated on GitHub, a webhook hits port 3002, the app verifies the HMAC signature, runs `git pull --ff-only`, and reloads all course configs — zero-downtime content updates.

Deploys are a single command: `npm run deploy` — SSH into the VPS, pull both repos, rebuild the container, restart.

## Key Technical Decisions

**Model fallback.** Primary model is Claude Sonnet 4.6. On rate limit (429) or overload (529), retries with exponential backoff — 15s base for rate limits, 2s for overloads, capped at 60s, 3 attempts. If all retries fail, the request falls back to Claude Haiku so the student always gets an answer.

**Per-group sequential queue.** Messages for the same WhatsApp group are processed one at a time. This prevents race conditions when two students ask simultaneously, keeps response ordering predictable, and avoids concurrent API calls that compound rate limits. Different groups process in parallel. Queue depth is capped at 5 — excess messages are dropped gracefully.

**NOWEB engine handling.** WAHA's NOWEB engine (serverless WhatsApp — no headless browser) uses Linked IDs (LIDs) instead of phone numbers for user identity. This affects mention detection, reply detection, and enrollment lookup. The bot resolves LIDs to phone numbers via WAHA's API, with multiple fallback paths: checking `mentionedJidList` for both phone and LID formats, scanning the message body for @mentions by display name, and traversing two different reply context paths (`quotedParticipant` for WEBJS, `contextInfo.participant` for NOWEB).

**Chat history as context.** Each request includes the last ~30 messages from the chat, with sender names resolved against the `participants.csv` file when possible (falling back to push name, then phone number). This lets the bot understand follow-up questions and ongoing discussions without a conversation database.

**DM enrollment.** For direct messages, the bot resolves the sender's LID to a phone number, then checks it against `participants.csv` to verify enrollment. Enrolled students get a personalized assistant that knows their name, role, and practice area. Non-enrolled users receive a polite rejection.

**Path traversal protection.** All file tool operations resolve and validate paths against the course directory before any read. The bot cannot access files outside its designated course folder.

**HMAC webhook verification.** Both WAHA webhooks and GitHub webhooks are verified with HMAC-SHA256 using timing-safe comparison. The WAHA dashboard is never exposed publicly.

**Multimodal input.** Students can send images and documents alongside questions (toggleable per-course in `config.yaml`). Media is downloaded from WAHA, base64-encoded, and included in the Claude API request.

## Tech Stack

- **TypeScript** / Node.js 20 / Express 5
- **Claude API** (Anthropic SDK) — agentic tool-use
- **WAHA Plus** — self-hosted WhatsApp Web API (NOWEB engine)
- **Docker Compose** — two-service deployment
- **PapaParse** — CSV parsing for Hebrew participant data

## Source Files

| File | Role |
|------|------|
| [`src/student-bot.ts`](./src/student-bot.ts) | Core — agentic tool-use loop, model fallback, system prompt assembly, chat history formatting |
| [`src/webhook-handler.ts`](./src/webhook-handler.ts) | Routing — WAHA webhook parsing, @mention and reply detection, rate limiting, per-group queue |
| [`src/course-tools.ts`](./src/course-tools.ts) | Tools — search, read, list, send file definitions, path traversal protection |
| [`src/course-config.ts`](./src/course-config.ts) | Config — course loading, group ID routing, phone-based enrollment lookup |
| [`src/waha-client.ts`](./src/waha-client.ts) | WAHA — send messages/files, fetch chat history, resolve LIDs, typing indicators |
| [`src/media-handler.ts`](./src/media-handler.ts) | Media — download, classify, and base64-encode images and documents |
| [`src/github-webhook.ts`](./src/github-webhook.ts) | Auto-update — GitHub webhook receiver, HMAC verification, git pull with debounce, hot-reload |
| [`src/index.ts`](./src/index.ts) | Entry — Express server, health check, startup initialization |
| [`src/types.ts`](./src/types.ts) | Types — TypeScript interfaces for courses, webhooks, messages, media, tool results |
| [`system-prompt.md`](./system-prompt.md) | Prompt — bot persona and behavior instructions (Hebrew, with `{{placeholders}}`) |

## License

All rights reserved. This source code is published for portfolio review and reference only. No permission is granted to use, copy, modify, or distribute this code for any purpose without explicit written permission from the author.
