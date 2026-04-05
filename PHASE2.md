# Phase 2 — Deferred Features

Features not in Phase 1 MVP, with context on why/when they'd be needed.

## Near-term (after test group validation)

### Message database
SQLite or Postgres for message history storage + full-text search. **When needed:** students ask about things shared weeks ago and WAHA's history isn't sufficient, or for usage analytics.

### Voice message support
Download .ogg voice messages, transcribe (Whisper or Claude audio), then process. **When needed:** students send voice questions. Currently the Claude Messages API doesn't support direct audio input — transcription step required.

### Proactive reminders
Bot sends reminders before scheduled classes. **Requires:** cron-like scheduler, reading schedule.md, sending unprompted messages.

### Web search tool
Bot can search the internet for supplementary info. Adds a `web_search` tool to the agentic loop. Low effort, high value.

### Agent Skills for structured response patterns
Implement Anthropic's [Agent Skills protocol](https://agentskills.io) to define how the bot should answer specific types of questions. Each skill would be a `SKILL.md` file with instructions for a particular answer format and the reasoning approach required. **Use case:** questions that have a desired answer structure (e.g., legal procedure breakdowns, comparison tables, step-by-step guides) or require domain-specific thinking patterns. Skills would be loaded into the system prompt on-demand using progressive disclosure, keeping token costs low. **When needed:** as course content grows and specific question types emerge with recurring answer patterns.

## Medium-term

### Backoffice bot
Lapidot managing courses via WhatsApp or phone. **Options:** custom Claude Code bridge via WhatsApp (see peleg-orchestra by aviz85), or Happy Coder app for direct Claude Code phone control.

### Daily/weekly group summaries
Auto-generated summaries of group activity, key Q&A, shared materials. **Requires:** scheduled task, access to group message history.

### Write insights to course folders
Bot saves valuable group discussions/insights back to course repo. **Requires:** write access to courses repo, git commit/push logic, deduplication.

### Advanced guardrails
- **Layer 2:** Fast classifier (Haiku) to pre-filter off-topic questions before the main LLM call
- **Layer 3:** Output validation to catch hallucinations or inappropriate responses

## Long-term

### Analytics dashboard
Web UI showing: questions asked, response times, topics, usage per group. **Requires:** database (see above).

### Multi-tenant
Support multiple instructors (not just Lapidot). Each with their own courses, groups, billing.

### Vector search / RAG
When course content grows too large for grep-based search (hundreds of long transcripts), add embedding-based retrieval.

### Session management
For very long conversations, manage per-student context beyond the recent-messages window.

### Cloud migration of backoffice
Move backoffice to VPS + Cloudflare Tunnel for remote access.

### VPS migration
Docker-based setup makes VPS migration straightforward (~30 minutes).

### Video message support
Extract key frames from video, send to Claude for analysis. Expensive — skip unless there's demand.
