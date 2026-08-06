import { AzureOpenAI } from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import fs from 'fs';
import path from 'path';
import { BotInvocation, ChatMessage, log } from './types';
import { getChatMessages, sendTextMessage, startTyping, stopTyping } from './waha-client';
import { toolDefinitions, executeTool } from './course-tools';
import { COURSES_PATH, parseParticipantsCsv } from './course-config';
import { botLid } from './webhook-handler';

// Azure OpenAI configuration
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4-nano';
const AZURE_API_VERSION = process.env.AZURE_API_VERSION || '2025-04-01-preview';

const client = new AzureOpenAI({
  apiKey: AZURE_API_KEY,
  endpoint: AZURE_ENDPOINT,
  apiVersion: AZURE_API_VERSION,
});

const PRIMARY_MODEL = AZURE_DEPLOYMENT;
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 10;
const CHAT_HISTORY_LIMIT = 30;
const API_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_BASE_DELAY_MS = 15_000;
const TYPING_REFRESH_MS = 8_000;
const MAX_RETRY_DELAY_MS = 60_000;

// Convert Anthropic-style tool definitions to OpenAI function format
function getOpenAITools(): ChatCompletionTool[] {
  return toolDefinitions.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
    },
  }));
}

async function createChatCompletionWithRetry(
  messages: Array<{role: string; content: string | Array<any>; tool_call_id?: string; name?: string}>,
  systemPrompt: string,
): Promise<{response: any; model: string}> {
  for (let attempt = 0; attempt < API_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: PRIMARY_MODEL,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ] as any,
        tools: getOpenAITools(),
        tool_choice: 'auto',
      });
      return { response, model: PRIMARY_MODEL };
    } catch (err: unknown) {
      const isRetryable = err && typeof err === 'object' && 'status' in err &&
        ((err as any).status === 429 || (err as any).status >= 500);
      if (!isRetryable) throw err;

      if (attempt < API_RETRY_ATTEMPTS - 1) {
        const delay = Math.min(RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        log('warn', 'API error, retrying', { attempt: attempt + 1, delayMs: delay, model: PRIMARY_MODEL });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error('All API retry attempts exhausted');
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
  if (row.title) fields.push(`Título: ${row.title}`);
  if (row.practice) fields.push(`Área de práctica: ${row.practice}`);
  if (row.aiTools) fields.push(`Herramientas de IA: ${row.aiTools}`);
  if (row.notes) fields.push(`Notas: ${row.notes}`);
  return fields.length > 0 ? fields.join('\n') : null;
}

function buildSystemPrompt(invocation: BotInvocation): string {
  const { course } = invocation;
  const { config, systemPrompt } = course;

  const now = new Date();
  const dateStr = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  const template = loadSystemPromptTemplate();

  let rendered = template
    .replace(/\{\{botName\}\}/g, config.botName)
    .replace(/\{\{courseName\}\}/g, config.name)
    .replace(/\{\{instructor\}\}/g, config.instructor)
    .replace(/\{\{description\}\}/g, config.description)
    .replace(/\{\{currentDateTime\}\}/g, `${dateStr}, ${timeStr}`);

  // Append per-course custom prompt if present
  if (systemPrompt) {
    rendered += `\n\n## Instrucciones adicionales del curso\n${systemPrompt}`;
  }

  // Append DM-specific personalization
  if (invocation.isDm) {
    let dmSection = `\n\n## Conversación privada\nEstás conversando en privado con ${invocation.studentName}.`;

    const profile = loadStudentProfile(course.coursePath, invocation.studentName);
    if (profile) {
      dmSection += `\n\nPerfil del participante:\n${profile}`;
    }

    dmSection += `\n\nInstrucciones para la conversación privada:
- Dirígete al estudiante por su nombre
- Puedes dar respuestas más detalladas que en el grupo
- No hace falta derivar a una conversación privada: ya están en una
- Adapta las respuestas al área de práctica y al perfil del estudiante`;

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
  if (msg.fromMe) return 'Bot';

  const senderPhone = msg._data?.key?.participantAlt?.replace(/@.*/, '') || '';
  const senderLid = msg.participant || msg._data?.key?.participant?.replace(/@.*/, '') || '';

  if (senderPhone && senderPhone === botPhoneNumber) return 'Bot';
  if (senderLid && senderLid === botLid) return 'Bot';

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
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const text = msg.body || (msg.hasMedia ? '[multimedia]' : '[mensaje vacío]');
    return `[${time}] ${sender}: ${text}`;
  });

  return formatted.join('\n');
}

function buildUserMessage(invocation: BotInvocation, chatHistory: string, chatHistoryFailed: boolean): string {
  const parts: string[] = [];
  const chatLabel = invocation.isDm ? 'Mensajes recientes de la conversación' : 'Mensajes recientes del grupo';

  // Chat history context
  if (chatHistory) {
    parts.push(`## ${chatLabel}\n${chatHistory}`);
  } else if (chatHistoryFailed) {
    parts.push(`## Nota\nNo pude cargar el historial de mensajes recientes. Si la pregunta se refiere a un mensaje anterior o a un contexto que no veo, pide al estudiante que lo detalle.`);
  }

  // Media attachment note (Azure OpenAI doesn't support inline base64 documents/images in the same way)
  if (invocation.media) {
    if (invocation.media.type === 'image') {
      parts.push(`[El estudiante adjuntó una imagen que no puedo procesar directamente en este momento.]`);
    } else if (invocation.media.type === 'document') {
      parts.push(`[El estudiante adjuntó un documento: ${invocation.media.filename}]`);
    }
  }

  // The actual student question
  parts.push(`## Pregunta de ${invocation.studentName}\n${invocation.questionText}`);

  return parts.join('\n\n');
}

export async function handleStudentQuestion(invocation: BotInvocation): Promise<void> {
  const { message, course } = invocation;
  const chatId = invocation.chatId || message._data?.id?.remote || message.to;
  const messageId = message.id || message._data?.id?._serialized || '';
  const replyTo = invocation.isDm ? undefined : (messageId || undefined);
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

  // Show "typing..." and refresh periodically
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  try {
    await startTyping(chatId).catch(() => {});
    typingInterval = setInterval(() => {
      startTyping(chatId).catch(() => {});
    }, TYPING_REFRESH_MS);
  } catch { /* non-fatal */ }

  try {
    // Fetch recent chat history
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

    // Agentic loop with OpenAI function calling
    const messages: Array<any> = [
      { role: 'user', content: userContent },
    ];

    let finalResponse = '';

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const { response } = await createChatCompletionWithRetry(messages, systemPrompt);

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      // Add assistant message to conversation history
      messages.push(assistantMessage);

      // Check if we got a final text response (no tool calls)
      if (choice.finish_reason === 'stop' || !assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        finalResponse = assistantMessage.content || '';
        break;
      }

      // Process tool calls
      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments || '{}');

        log('info', 'Tool call', { tool: fnName, input: fnArgs });

        const result = await executeTool(course.coursePath, fnName, fnArgs, chatId);

        // Add tool result to conversation
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      continue;
    }

    if (!finalResponse) {
      finalResponse = 'Lo siento, no pude procesar la pregunta. Intenta preguntar de nuevo.';
    }

    // Send response
    await sendTextMessage(chatId, finalResponse, replyTo);

    const duration = Date.now() - startTime;
    log('info', 'Question answered', {
      chatId,
      isDm: invocation.isDm || false,
      student: invocation.studentName,
      durationMs: duration,
      model: PRIMARY_MODEL,
    });

  } catch (err) {
    log('error', 'Failed to process student question', {
      error: String(err),
      chatId,
      student: invocation.studentName,
    });

    // Send apology message
    try {
      await sendTextMessage(chatId, 'Lo siento, tuve un problema técnico. Intenta de nuevo en un momento.');
    } catch (sendErr) {
      log('error', 'Failed to send error message', { error: String(sendErr) });
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    stopTyping(chatId).catch(() => {});
  }
}
