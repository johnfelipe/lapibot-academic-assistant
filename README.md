# Lapibot — Course Assistant Bot

WhatsApp bot that assists students in [AI4LAW](https://ai4law.co.il)'s educational courses. Students can @mention the bot or reply to its messages in a course WhatsApp group, or DM the bot directly. The bot searches course materials and answers questions using Claude AI with agentic tool-use.

**Group chats:** Triggered by @mention or reply to bot. Routes by WhatsApp group ID to the matching course.

**Direct messages:** Enrolled students (matched by phone number from `participants.csv`) get the same course assistant experience, personalized with their name and profile. Non-enrolled users receive a polite rejection message.

> **Note:** This is a portfolio showcase of the production Lapibot system. Course materials (lesson content, participant data, recordings) are not included as they are proprietary to AI4LAW.

## Architecture

```
WhatsApp ──► WAHA (Docker, port 3000)
               │ webhook
               ▼
           Node.js Server (Express, port 3001)
               │
               ├── Webhook Handler
               │     • Group msgs: @mention / reply-to-bot → route by group ID
               │     • DMs: resolve phone (LID → phone via WAHA API) → enrollment lookup
               │     • Non-enrolled DMs → polite rejection
               │
               ├── Student Bot (per request)
               │     • Loads course context + system prompt
               │     • Fetches chat history for context
               │     • Claude API with tool-use (search/read course files)
               │     • DMs: personalized with student profile
               │
               ├── WAHA Client
               │     • Send responses (text, files)
               │     • Fetch message history
               │     • Resolve LIDs to phone numbers
               │
               └── reads ──► courses/ (git-synced separate repo)
                               ├── system-prompt.md
                               ├── dm-not-enrolled.md
                               └── <course>/
                                     ├── config.yaml
                                     ├── participants.csv
                                     └── lessons/
```

## Features

- **Agentic tool-use**: Bot uses Claude API tools to search, read, list, and send course files — not just static responses
- **Multi-course**: Single instance serves multiple courses, routed by WhatsApp group ID
- **Multimodal**: Accepts images and documents from students (per-course toggleable)
- **DM support**: Enrolled students can chat privately with the bot for personalized help
- **Model fallback**: Primary model (Claude Sonnet 4.6) with automatic fallback to Haiku on overload
- **Rate limiting**: Per-group/per-chat rate limiting to prevent cost spikes
- **Sequential queue**: Per-group message queue prevents concurrent API calls
- **Hot-reload**: GitHub webhook auto-pulls course updates and reloads configs without restart
- **Security**: HMAC webhook verification, path traversal protection, non-root Docker user
- **Hebrew-first**: System prompt, bot persona, and WhatsApp formatting optimized for Hebrew (RTL)

## Prerequisites

- Node.js 20+
- Docker & Docker Compose
- WAHA Plus license (self-hosted WhatsApp API)
- Anthropic API key

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your API keys
npm run dev
```

## Deployment

### First-time setup

```bash
ssh user@vps

cd /opt
git clone <this-repo> lapibot-course-assistant
git clone <courses-repo> lapibot-courses

cd lapibot-course-assistant
cp .env.example .env
# Edit .env with real values

docker compose -f docker/docker-compose.yml up -d

# Authenticate WAHA: SSH tunnel to port 3000, open dashboard, scan QR
ssh -L 3000:localhost:3000 user@vps
# Then open http://localhost:3000 in browser
```

### Ongoing deploys

```bash
npm run deploy    # SSH → git pull both repos → docker compose up --build
npm run logs      # Tail app container logs
```

## Course Structure

Each course lives in a separate folder within the courses repo:

```
my-course/
├── config.yaml        # required: course metadata + group IDs
├── participants.csv   # optional: student data (enables DM access + personalization)
├── prompt.md          # optional: custom bot instructions
├── schedule.md        # optional: class schedule
└── lessons/           # optional: lesson plans, transcripts
    ├── 01-intro.md
    └── ...
```

Example `config.yaml`:

```yaml
name: "שם הקורס"
instructor: "שם המרצה"
botName: "לפיבוט"
language: "he"
description: "תיאור קצר של הקורס"
whatsappGroups:
  - "120363xxxxx@g.us"    # WhatsApp group ID
media:
  images: true
  documents: true
  voice: true
```

## System Prompt

The bot's personality, behavior, and formatting rules are defined in `system-prompt.md` (included in this repo). It uses `{{placeholders}}` filled per-course from `config.yaml`:

- `{{botName}}` — bot display name (e.g., "לפיבוט")
- `{{courseName}}` — course name
- `{{instructor}}` — instructor name
- `{{description}}` — course description
- `{{currentDateTime}}` — injected at runtime

Each course can also have its own `prompt.md` with additional instructions appended to the system prompt.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WAHA_API_URL` | WAHA server URL (default: `http://waha:3000`) |
| `WAHA_SESSION` | WAHA session name (default: `default`) |
| `WAHA_API_KEY` | WAHA API authentication key |
| `WAHA_WEBHOOK_SECRET` | Shared HMAC secret for webhook verification |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `PORT` | Server port (default: `3001`) |
| `BOT_MENTION_NAME` | Bot name for @mention detection (default: `לפיבוט`) |
| `BOT_PHONE_NUMBER` | Bot's WhatsApp number (for reply detection) |
| `COURSES_PATH` | Path to courses folder (default: `./courses`) |
| `ADMIN_CHAT_ID` | WhatsApp chat ID for admin alerts |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub webhook signature verification |
| `GITHUB_COURSES_REPO` | GitHub repo for courses (e.g., `user/lapibot-courses`) |
| `VPS_HOST` | SSH target for deploy script |
| `VPS_PROJECT_DIR` | Remote project path (default: `/opt/lapibot-course-assistant`) |
| `VPS_COURSES_DIR` | Remote courses path (default: `/opt/lapibot-courses`) |

## Docker Services

- **waha**: WAHA Plus (WhatsApp Web API, NOWEB engine). Port 3000, accessible only via SSH tunnel.
- **app**: Node.js bot server. Port 3001 (internal, WAHA webhooks). Port 3002 (public, GitHub webhook for auto-pull).

## AI Model

- Primary: `claude-sonnet-4-6` with retries on 529 overload (exponential backoff)
- Fallback: `claude-haiku-4-5-20251001` if primary exhausted

## Auto-Pull Course Updates

When changes are pushed to the courses repo's `main` branch, a GitHub webhook notifies the bot at port 3002. The bot verifies the HMAC signature, runs `git pull --ff-only`, and hot-reloads all course configs. See `src/github-webhook.ts`.

## Phase 2

See [PHASE2.md](./PHASE2.md) for planned features: message database, backoffice bot, analytics, multi-tenant support, and more.

## Key Files

| File | Description |
|------|-------------|
| `src/index.ts` | Express server entry point |
| `src/webhook-handler.ts` | WAHA webhook parsing + group/DM routing |
| `src/student-bot.ts` | Agentic tool-use loop with Claude (core logic) |
| `src/course-tools.ts` | Tool definitions: search_files, read_file, list_files, send_file |
| `src/media-handler.ts` | Download + encode media from WAHA (images, docs) |
| `src/waha-client.ts` | WAHA API wrapper (send messages, fetch history) |
| `src/course-config.ts` | Load course configs, build group→course routing map |
| `src/github-webhook.ts` | GitHub webhook for auto-pulling course updates |
| `system-prompt.md` | Bot system prompt — persona, formatting rules, behavior |
