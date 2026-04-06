# Lapibot — AI Course Assistant for WhatsApp

Lapibot is a WhatsApp-based AI teaching assistant built for [AI4LAW](https://ai4law.co.il), an organization that runs professional courses on integrating AI into legal practice. The bot lives in course WhatsApp groups and answers student questions by searching through course materials using Claude AI with agentic tool-use.

Students interact with the bot by @mentioning it in a group chat or replying to its messages. Enrolled students can also DM the bot directly for personalized help. The bot searches lesson summaries, transcripts, schedules, and other course files — then responds in context, citing specific lessons and linking to recordings when relevant.

This repository is the production codebase, published as a portfolio showcase. Course materials (lesson content, participant data, recordings) are proprietary and stored in a separate private repository.

## How It Works

```
                    ┌─────────────────────────────────────────┐
                    │              VPS (Docker)                │
                    │                                          │
WhatsApp ──────────►│  WAHA (port 3000)                       │
                    │    │ webhook POST /webhook               │
                    │    ▼                                      │
                    │  Express Server (port 3001)              │
                    │    │                                      │
                    │    ├─ Is it a group message?              │
                    │    │   └─ @mention or reply-to-bot?       │
                    │    │       └─ Route group ID → course     │
                    │    │                                      │
                    │    ├─ Is it a DM?                         │
                    │    │   └─ Resolve phone → enrolled?       │
                    │    │       ├─ Yes → personalized assistant│
                    │    │       └─ No → polite rejection       │
                    │    │                                      │
                    │    └─ Student Bot (agentic loop)          │
                    │        ├─ Load system prompt + course ctx │
                    │        ├─ Fetch last ~30 messages         │
                    │        ├─ Claude API + tools ◄──┐         │
                    │        │   (search, read, list, │         │
                    │        │    send files)         │         │
                    │        └─ Send response ────────┘         │
                    │                                          │
                    │  GitHub Webhook Server (port 3002)       │
                    │    └─ On push → git pull → hot-reload     │
                    │                                          │
                    └──────────────┬───────────────────────────┘
                                   │ reads from
                                   ▼
                    ┌──────────────────────────────┐
                    │  Courses Repository (git)     │
                    │                                │
                    │  ├── system-prompt.md          │
                    │  ├── dm-not-enrolled.md        │
                    │  └── <course>/                 │
                    │       ├── config.yaml          │
                    │       ├── participants.csv     │
                    │       ├── prompt.md            │
                    │       ├── schedule.md          │
                    │       └── lessons/             │
                    │           ├── lesson-01.md     │
                    │           ├── lesson-01-transcript.txt │
                    │           └── ...              │
                    └──────────────────────────────┘
```

## The Agentic Loop

Lapibot is not a simple chatbot that stuffs all course content into the prompt. Instead, it uses Claude's tool-use capability to search and read course materials on demand:

1. Student asks a question
2. Bot receives the question along with recent chat history (~30 messages for context)
3. Claude decides which tools to call:
   - **search_files** — grep across all course materials (lesson plans, transcripts, schedule)
   - **read_file** — read a specific file in full
   - **list_files** — discover what materials are available
   - **send_file** — share a course document via WhatsApp
4. Claude reads the tool results and may call more tools (up to 10 iterations)
5. Final response is sent to the student, quoting the original message in groups

This approach keeps token costs low (only loading what's needed) and scales to large course libraries without hitting context limits.

## Course Materials Architecture

Course content lives in a **separate Git repository**, mounted into the Docker container. This separation is deliberate:

- **Course creators update content independently** — push to the courses repo, and the bot picks up changes automatically via a GitHub webhook that triggers `git pull` + hot-reload
- **No rigid schema required** — the only required file is `config.yaml` (course name, instructor, WhatsApp group IDs). Everything else is optional and freeform. The bot discovers and searches whatever files exist
- **Multiple courses, one bot** — each course folder maps WhatsApp group IDs to course context. A single Lapibot instance serves all active courses

The `config.yaml` maps a course to its WhatsApp groups:

```yaml
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

The bot's personality is defined in [`system-prompt.md`](./system-prompt.md) — a detailed Hebrew prompt that establishes:

- **Persona** — professional, direct tone matching the instructor's teaching style
- **WhatsApp formatting rules** — single-asterisk bold, no Markdown links, no tables (they break in WhatsApp), RTL-aware mixed-language handling
- **Search behavior** — when to search summaries vs. full transcripts, when to link to recordings
- **Boundaries** — only answer course-related questions, never fabricate content, redirect off-topic questions

The prompt uses `{{placeholders}}` (`{{botName}}`, `{{courseName}}`, `{{instructor}}`, etc.) that are filled per-course from `config.yaml`. Each course can also have its own `prompt.md` with additional instructions.

## Deployment

The system runs on a VPS with Docker Compose — two containers:

- **WAHA** (WhatsApp HTTP API) — self-hosted WhatsApp Web bridge using the NOWEB engine. Receives messages from WhatsApp and forwards them as webhooks to the app. Dashboard accessible only via SSH tunnel.
- **App** — Node.js server that processes webhooks, runs the agentic loop, and sends responses back through WAHA. Also runs a GitHub webhook server on a separate port for auto-pulling course updates.

The courses repository is mounted as a Docker volume. When course content is updated on GitHub, a webhook hits port 3002, the app verifies the HMAC signature, runs `git pull --ff-only`, and reloads all course configs — no restart needed.

Deploys are a single command: SSH into the VPS, pull both repos, rebuild the Docker image, and restart.

## Key Technical Decisions

- **Model fallback**: Primary model is Claude Sonnet 4.6. On rate limit or overload (529), retries with exponential backoff (3 attempts). If all fail, falls back to Claude Haiku for that request.
- **Per-group sequential queue**: Messages for the same group are processed one at a time to prevent race conditions and keep responses ordered. Different groups process in parallel.
- **Rate limiting**: Per-chat rate limiter (10 invocations/minute) prevents cost spikes from message storms.
- **DM enrollment check**: For direct messages, the bot resolves the sender's phone number (NOWEB engine uses LIDs, not phone numbers) and checks it against `participants.csv` to verify enrollment.
- **Path traversal protection**: All file operations are sandboxed to the course folder — the bot cannot read files outside its designated course directory.
- **HMAC webhook verification**: Both WAHA webhooks and GitHub webhooks are verified with HMAC signatures.
- **Multimodal input**: Students can send images and documents (per-course toggleable). Media is downloaded from WAHA, base64-encoded, and sent to Claude as part of the message.

## Tech Stack

- **TypeScript** / Node.js / Express
- **Claude API** (Anthropic SDK) with tool-use
- **WAHA Plus** — self-hosted WhatsApp Web API
- **Docker Compose** — two-service deployment
- **PapaParse** — CSV parsing for participant data

## Source Files

| File | Role |
|------|------|
| [`src/student-bot.ts`](./src/student-bot.ts) | Core logic — agentic tool-use loop with Claude |
| [`src/webhook-handler.ts`](./src/webhook-handler.ts) | WAHA webhook routing — groups, DMs, rate limiting, queuing |
| [`src/course-tools.ts`](./src/course-tools.ts) | Tool definitions and execution (search, read, list, send) |
| [`src/course-config.ts`](./src/course-config.ts) | Course loading, group routing map, enrollment lookup |
| [`src/waha-client.ts`](./src/waha-client.ts) | WAHA API wrapper — send messages, fetch history, media |
| [`src/media-handler.ts`](./src/media-handler.ts) | Media classification and download (images, docs) |
| [`src/github-webhook.ts`](./src/github-webhook.ts) | GitHub webhook — auto-pull courses + hot-reload |
| [`src/index.ts`](./src/index.ts) | Express server entry point |
| [`system-prompt.md`](./system-prompt.md) | Bot persona and behavior (Hebrew, with `{{placeholders}}`) |

## Roadmap

See [PHASE2.md](./PHASE2.md) for planned features: message database, voice message transcription, proactive reminders, analytics dashboard, and multi-tenant support.
