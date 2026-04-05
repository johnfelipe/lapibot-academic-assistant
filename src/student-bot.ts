import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { BotInvocation, ChatMessage, log } from './types';
import { getChatMessages, sendTextMessage, startTyping, stopTyping } from './waha-client';
import { toolDefinitions, executeTool } from './course-tools';
import { COURSES_PATH, parseParticipantsCsv } from './course-config';
import { botLid } from './webhook-handler';

const anthropic = new Anthropic({ maxRetries: 4 });
const PRIMARY_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 10;
const CHAT_HISTORY_LIMIT = 30;
const API_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_BASE_DELAY_MS = 15_000;
const OVERLOAD_BASE_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
const TYPING_REFRESH_MS = 8_000;

async function createMessageWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<{ response: Anthropic.Message; model: string }> {
  // Try primary model with retries
  for (let attempt = 0; attempt < API_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await anthropic.messages.create(params);
      return { response, model: params.model };
    } catch (err: unknown) {
      const isRateLimit = err instanceof Anthropic.RateLimitError;
      const isOverloaded = err instanceof Anthropic.InternalServerError;
      if (!isRateLimit && !isOverloaded) throw err; // non-retryable error

      const errorType = isRateLimit ? 'rate_limit' : 'overload';
      const baseDelay = isRateLimit ? RATE_LIMIT_BASE_DELAY_MS : OVERLOAD_BASE_DELAY_MS;

      if (attempt < API_RETRY_ATTEMPTS - 1) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        log('warn', 'API error, retrying', { errorType, attempt: attempt + 1, delayMs: delay, model: params.model });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted on primary — try fallback model once
  log('warn', 'Primary model exhausted retries, falling back', { primary: params.model, fallback: FALLBACK_MODEL });
  const response = await anthropic.messages.create({ ...params, model: FALLBACK_MODEL });
  return { response, model: FALLBACK_MODEL };
}

function loadSystemPromptTemplate(): string {
  // 1. Try courses repo root
  const coursesRepoPath = path.join(COURSES_PATH, 'system-prompt.md');
  if (fs.existsSync(coursesRepoPath)) {
    return fs.readFileSync(coursesRepoPath, 'utf-8');
  }

  // 2. Fallback to code repo root
  const codeRepoPath = path.join(__dirname, '..', 'system-prompt.md');
  if (fs.existsSync(codeRepoPath)) {
    return fs.readFileSync(codeRepoPath, 'utf-8');
  }

  throw new Error('system-prompt.md not found in courses repo or code repo');
}

function loadStudentProfile(coursePath: string, studentName: string): string | null {
  const row = parseParticipantsCsv(coursePath).find(r => r.name === studentName);
  if (!row) return null;

  const fields: string[] = [];
  if (row.title) fields.push(`תואר: ${row.title}`);
  if (row.practice) fields.push(`תחום עיסוק: ${row.practice}`);
  if (row.aiTools) fields.push(`כלי AI: ${row.aiTools}`);
  if (row.notes) fields.push(`הערות: ${row.notes}`);
  return fields.length > 0 ? fields.join('\n') : null;
}

function buildSystemPrompt(invocation: BotInvocation): string {
  const { course } = invocation;
  const { config, systemPrompt } = course;

  const now = new Date();
  const dateStr = now.toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jerusalem' });
  const timeStr = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  const template = loadSystemPromptTemplate();

  let rendered = template
    .replace(/\{\{botName\}\}/g, config.botName)
    .replace(/\{\{courseName\}\}/g, config.name)
    .replace(/\{\{instructor\}\}/g, config.instructor)
    .replace(/\{\{description\}\}/g, config.description)
    .replace(/\{\{currentDateTime\}\}/g, `${dateStr}, ${timeStr}`);

  // Append per-course custom prompt if present
  if (systemPrompt) {
    rendered += `\n\n## הנחיות נוספות לקורס\n${systemPrompt}`;
  }

  // Append DM-specific personalization
  if (invocation.isDm) {
    let dmSection = `\n\n## שיחה פרטית\nאתה משוחח בשיחה פרטית עם ${invocation.studentName}.`;

    const profile = loadStudentProfile(course.coursePath, invocation.studentName);
    if (profile) {
      dmSection += `\n\nפרופיל המשתתף/ת:\n${profile}`;
    }

    dmSection += `\n\nהנחיות לשיחה פרטית:
- פנה אל הסטודנט/ית בשמו/ה הפרטי
- ניתן לתת תשובות מפורטות יותר מאשר בקבוצה
- אין צורך להפנות לשיחה פרטית — אתם כבר בשיחה פרטית
- התאם את התשובות לתחום העיסוק והרקע של הסטודנט/ית`;

    rendered += dmSection;
  }

  return rendered;
}

function loadParticipantsMap(coursePath: string): { byPhone: Map<string, string>; names: string[] } {
  const byPhone = new Map<string, string>();
  const names: string[] = [];
  for (const row of parseParticipantsCsv(coursePath)) {
    names.push(row.name);
    if (row.phone) {
      byPhone.set(row.phone, row.name);
    }
  }
  return { byPhone, names };
}

function resolveSenderName(
  msg: ChatMessage,
  botPhoneNumber: string,
  botLid: string,
  participants: { byPhone: Map<string, string>; names: string[] },
): string {
  // Bot's own messages
  if (msg.fromMe) return 'בוט';

  const senderPhone = msg._data?.key?.participantAlt?.replace(/@.*/, '') || '';
  const senderLid = msg.participant || msg._data?.key?.participant?.replace(/@.*/, '') || '';

  if (senderPhone && senderPhone === botPhoneNumber) return 'בוט';
  if (senderLid && senderLid === botLid) return 'בוט';

  // 1. Try phone number match against participants file
  if (senderPhone && participants.byPhone.has(senderPhone)) {
    return participants.byPhone.get(senderPhone)!;
  }

  // 2. Fallback: use pushName (NOWEB) or notifyName (WEBJS)
  const pushName = msg._data?.pushName || msg._data?.notifyName || '';

  if (pushName) {
    // Try to match pushName first name against participant names for full name resolution
    for (const participantName of participants.names) {
      const firstNameFromPush = pushName.split(' ')[0];
      const firstNameFromParticipant = participantName.split(' ')[0];
      if (firstNameFromPush === firstNameFromParticipant) return participantName;
    }
    return pushName;
  }

  // 3. Last resort: phone or LID
  return senderPhone || senderLid || msg.from.replace(/@.*/, '');
}

function formatChatHistory(
  messages: ChatMessage[],
  botPhoneNumber: string,
  botLid: string,
  participants: { byPhone: Map<string, string>; names: string[] },
): string {
  if (messages.length === 0) return '';

  const formatted = messages.map(msg => {
    const sender = resolveSenderName(msg, botPhoneNumber, botLid, participants);
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
    const text = msg.body || (msg.hasMedia ? '[מדיה]' : '[הודעה ריקה]');
    return `[${time}] ${sender}: ${text}`;
  });

  return formatted.join('\n');
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string };

function buildUserMessage(invocation: BotInvocation, chatHistory: string, chatHistoryFailed: boolean): ContentBlock[] {
  const content: ContentBlock[] = [];
  const chatLabel = invocation.isDm ? 'הודעות אחרונות בשיחה' : 'הודעות אחרונות בקבוצה';

  // Chat history context
  if (chatHistory) {
    content.push({
      type: 'text',
      text: `## ${chatLabel}\n${chatHistory}`,
    });
  } else if (chatHistoryFailed) {
    content.push({
      type: 'text',
      text: `## הערה\nלא הצלחתי לטעון את היסטוריית ההודעות האחרונות. אם השאלה מתייחסת להודעה קודמת או להקשר שאני לא רואה, בקש מהסטודנט לפרט.`,
    });
  }

  // Media attachment if present
  if (invocation.media) {
    if (invocation.media.type === 'image') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: invocation.media.mimeType,
          data: invocation.media.data,
        },
      });
    } else if (invocation.media.type === 'document') {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: invocation.media.mimeType,
          data: invocation.media.data,
        },
        title: invocation.media.filename,
      });
    }
    // Audio: Claude Messages API doesn't natively support audio input yet.
    // Voice messages would need transcription (Phase 2).
  }

  // The actual student question
  content.push({
    type: 'text',
    text: `## שאלה מ${invocation.studentName}\n${invocation.questionText}`,
  });

  return content;
}

export async function handleStudentQuestion(invocation: BotInvocation): Promise<void> {
  const { message, course } = invocation;
  const chatId = invocation.chatId || message._data?.id?.remote || message.to;
  const messageId = message.id || message._data?.id?._serialized || '';
  const replyTo = invocation.isDm ? undefined : (messageId || undefined); // No quoting in DMs
  const botPhoneNumber = process.env.BOT_PHONE_NUMBER || '';
  const startTime = Date.now();
  const participants = loadParticipantsMap(course.coursePath);

  log('info', 'Processing student question', {
    chatId,
    isDm: invocation.isDm || false,
    student: invocation.studentName,
    question: invocation.questionText.slice(0, 100),
    hasMedia: !!invocation.media,
  });

  // Show "typing..." and refresh every 20s so it doesn't expire
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  try {
    await startTyping(chatId).catch(() => {});
    typingInterval = setInterval(() => {
      startTyping(chatId).catch(() => {});
    }, TYPING_REFRESH_MS);
  } catch { /* non-fatal */ }

  try {
    // Fetch recent chat history (non-fatal — proceed without if WAHA store isn't enabled)
    let chatHistory = '';
    let chatHistoryFailed = false;
    try {
      const chatMessages = await getChatMessages(chatId, CHAT_HISTORY_LIMIT);
      chatHistory = formatChatHistory(chatMessages, botPhoneNumber, botLid, participants);
    } catch (historyErr) {
      chatHistoryFailed = true;
      log('warn', 'Could not fetch chat history', { error: String(historyErr), chatId });
    }

    // Build the system prompt and user message
    const systemPrompt = buildSystemPrompt(invocation);
    const userContent = buildUserMessage(invocation, chatHistory, chatHistoryFailed);

    // Agentic loop
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userContent as Anthropic.ContentBlockParam[] },
    ];

    let finalResponse = '';
    let activeModel = PRIMARY_MODEL;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const { response, model: usedModel } = await createMessageWithRetry({
        model: activeModel,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: toolDefinitions as Anthropic.Tool[],
        messages,
      });
      activeModel = usedModel; // stick with whichever model worked for the rest of the loop

      // Check if we got a final text response
      if (response.stop_reason === 'end_turn') {
        finalResponse = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        break;
      }

      // Process tool calls
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
        );

        if (toolUseBlocks.length === 0) {
          // No tool calls but stop_reason is tool_use — extract text and break
          finalResponse = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map(block => block.text)
            .join('\n');
          break;
        }

        // Log tool calls
        for (const tool of toolUseBlocks) {
          log('info', 'Tool call', { tool: tool.name, input: tool.input as Record<string, unknown> });
        }

        // Execute tools and build results
        const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
          toolUseBlocks.map(async tool => ({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: await executeTool(course.coursePath, tool.name, tool.input as Record<string, string>, chatId),
          }))
        );

        // Add assistant response and tool results to conversation
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });

        continue;
      }

      // Unexpected stop reason — extract whatever text we have
      finalResponse = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      break;
    }

    if (!finalResponse) {
      finalResponse = 'מצטער, לא הצלחתי לעבד את השאלה. נסו לשאול שוב.';
    }

    // Send response, quoting the original message (skip quoting in DMs)
    await sendTextMessage(chatId, finalResponse, replyTo);

    const duration = Date.now() - startTime;
    log('info', 'Question answered', {
      chatId,
      isDm: invocation.isDm || false,
      student: invocation.studentName,
      durationMs: duration,
      model: activeModel,
    });

  } catch (err) {
    log('error', 'Failed to process student question', {
      error: String(err),
      chatId,
      student: invocation.studentName,
    });

    // Send apology message
    try {
      await sendTextMessage(chatId, 'מצטער, נתקלתי בבעיה טכנית. נסו שוב בעוד רגע.');
    } catch (sendErr) {
      log('error', 'Failed to send error message', { error: String(sendErr) });
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    stopTyping(chatId).catch(() => {});
  }
}
