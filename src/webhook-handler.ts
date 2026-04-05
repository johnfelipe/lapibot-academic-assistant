import crypto from 'crypto';
import { Request, Response } from 'express';
import { WebhookPayload, WebhookMessage, BotInvocation, log } from './types';
import { getCourseForGroup, getCourseForPhone, loadDmNotEnrolledMessage } from './course-config';
import { processMedia } from './media-handler';
import { handleStudentQuestion } from './student-bot';
import { sendTextMessage, getSessionStatus, resolveLidToPhone } from './waha-client';

const BOT_MENTION_NAME = process.env.BOT_MENTION_NAME || 'לפיבוט';
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || '';
const WAHA_WEBHOOK_SECRET = process.env.WAHA_WEBHOOK_SECRET || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';

// Bot's Linked ID (LID) — fetched from WAHA at startup
// NOWEB engine uses LIDs instead of phone numbers for mentions
export let botLid = '';

export async function initBotIdentifiers(): Promise<void> {
  try {
    const session = await getSessionStatus();
    if (session.me?.lid) {
      // LID comes as "163428471689324@lid", extract the numeric part
      botLid = session.me.lid.replace(/@.*/, '');
      log('info', 'Bot identifiers loaded', {
        phone: BOT_PHONE_NUMBER,
        lid: botLid,
        pushName: session.me.pushName,
      });
    }
  } catch (err) {
    log('warn', 'Could not fetch bot identifiers from WAHA', { error: String(err) });
  }
}

// Rate limiter: groupId → timestamps of recent invocations
const groupInvocations = new Map<string, number[]>();
const MAX_INVOCATIONS_PER_MINUTE = 10;

// Per-group sequential queue — prevents concurrent API calls for the same group
const groupQueues = new Map<string, BotInvocation[]>();
const groupProcessing = new Map<string, boolean>();
const MAX_QUEUE_DEPTH = 5;

function enqueueQuestion(groupId: string, invocation: BotInvocation): void {
  const queue = groupQueues.get(groupId) || [];

  if (queue.length >= MAX_QUEUE_DEPTH) {
    log('warn', 'Queue full, dropping message', {
      groupId,
      student: invocation.studentName,
      queueDepth: queue.length,
    });
    return;
  }

  queue.push(invocation);
  groupQueues.set(groupId, queue);

  // Kick off processing if idle
  if (!groupProcessing.get(groupId)) {
    processNextInQueue(groupId);
  }
}

function processNextInQueue(groupId: string): void {
  const queue = groupQueues.get(groupId);
  if (!queue || queue.length === 0) {
    groupProcessing.set(groupId, false);
    return;
  }

  groupProcessing.set(groupId, true);
  const invocation = queue.shift()!;

  handleStudentQuestion(invocation)
    .catch(err => {
      log('error', 'Unhandled error in student bot', { error: String(err), groupId });
    })
    .finally(() => {
      // Use setTimeout(0) to avoid deep recursion when queue drains rapidly
      setTimeout(() => processNextInQueue(groupId), 0);
    });
}

function checkRateLimit(groupId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const timestamps = (groupInvocations.get(groupId) || []).filter(t => t > cutoff);

  if (timestamps.length >= MAX_INVOCATIONS_PER_MINUTE) {
    return false;
  }

  timestamps.push(now);
  groupInvocations.set(groupId, timestamps);
  return true;
}

function verifyHmac(rawBody: Buffer, signature: string): boolean {
  if (!WAHA_WEBHOOK_SECRET) return true; // Skip if no secret configured
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', WAHA_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function isGroupMessage(message: WebhookMessage): boolean {
  const remote = message._data?.id?.remote || message.to || '';
  return remote.endsWith('@g.us');
}

function extractPhoneFromJid(jid: string): string {
  return jid.replace(/@.*/, '');
}

function getGroupId(message: WebhookMessage): string {
  return message._data?.id?.remote || message.to || '';
}

function isBotMentioned(message: WebhookMessage): boolean {
  const mentionedList = message._data?.mentionedJidList || [];

  // Check mentioned JID list for bot's phone number or LID
  if (mentionedList.length > 0) {
    for (const jid of mentionedList) {
      if (BOT_PHONE_NUMBER && jid.includes(BOT_PHONE_NUMBER)) return true;
      if (botLid && jid.includes(botLid)) return true;
    }
  }

  // Check message body for @mention by display name
  if (message.body && message.body.includes(`@${BOT_MENTION_NAME}`)) {
    return true;
  }

  // Check message body for @mention by LID (NOWEB engine puts LID in body)
  if (botLid && message.body && message.body.includes(`@${botLid}`)) {
    return true;
  }

  // Check message body for @mention by phone number
  if (BOT_PHONE_NUMBER && message.body && message.body.includes(`@${BOT_PHONE_NUMBER}`)) {
    return true;
  }

  return false;
}

function isReplyToBot(message: WebhookMessage): boolean {
  if (!BOT_PHONE_NUMBER && !botLid) return false;

  // Check standard WAHA fields (WEBJS engine)
  const quotedParticipant = message._data?.quotedParticipant || '';
  if (BOT_PHONE_NUMBER && quotedParticipant.includes(BOT_PHONE_NUMBER)) return true;
  if (botLid && quotedParticipant.includes(botLid)) return true;

  const quotedFrom = message._data?.quotedMsg?.from || '';
  if (BOT_PHONE_NUMBER && quotedFrom.includes(BOT_PHONE_NUMBER)) return true;
  if (botLid && quotedFrom.includes(botLid)) return true;

  // Check NOWEB engine path: contextInfo.participant
  const contextParticipant = message._data?.message?.extendedTextMessage?.contextInfo?.participant || '';
  if (BOT_PHONE_NUMBER && contextParticipant.includes(BOT_PHONE_NUMBER)) return true;
  if (botLid && contextParticipant.includes(botLid)) return true;

  return false;
}

function extractQuestionText(body: string): string {
  // Remove all forms of @mention from the question text
  let text = body;
  text = text.replace(new RegExp(`@?${BOT_MENTION_NAME}`, 'g'), '');
  if (botLid) text = text.replace(new RegExp(`@?${botLid}`, 'g'), '');
  if (BOT_PHONE_NUMBER) text = text.replace(new RegExp(`@?${BOT_PHONE_NUMBER}`, 'g'), '');
  text = text.trim();
  return text || body;
}

async function notifyAdmin(message: string): Promise<void> {
  if (!ADMIN_CHAT_ID) return;
  try {
    await sendTextMessage(ADMIN_CHAT_ID, message);
  } catch (err) {
    log('error', 'Failed to notify admin', { error: String(err) });
  }
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // HMAC verification
  const signature = (req.headers['x-webhook-hmac'] || req.headers['x-webhook-hmac-sha256'] || '') as string;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (WAHA_WEBHOOK_SECRET && rawBody && !verifyHmac(rawBody, signature)) {
    log('warn', 'Webhook HMAC verification failed');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Parse the webhook payload
  const payload = req.body as WebhookPayload;

  // Log incoming webhook (keep concise for production)
  log('info', 'Webhook received', {
    event: payload.event,
    from: payload.payload?.from,
    body: payload.payload?.body?.slice(0, 100),
    fromMe: payload.payload?.fromMe,
  });

  // Only process message events
  if (payload.event !== 'message') {
    res.status(200).json({ ok: true });
    return;
  }

  const message = payload.payload;
  if (!message) {
    res.status(200).json({ ok: true });
    return;
  }

  // Ignore messages from the bot itself
  if (message.fromMe) {
    res.status(200).json({ ok: true });
    return;
  }

  // Handle DM (private message)
  if (!isGroupMessage(message)) {
    res.status(200).json({ ok: true, processing: true });

    // Resolve phone: NOWEB engine sends DMs from LIDs, not phone JIDs
    let phone = extractPhoneFromJid(message.from);
    if (message.from.endsWith('@lid')) {
      const resolved = await resolveLidToPhone(message.from);
      if (resolved) phone = resolved;
    }
    const enrollment = getCourseForPhone(phone);

    if (!enrollment) {
      log('info', 'DM from non-enrolled user', { phone });
      await sendTextMessage(message.from, loadDmNotEnrolledMessage());
      return;
    }

    log('info', 'DM from enrolled student', { phone, student: enrollment.studentName, course: enrollment.course.config.name });

    if (!checkRateLimit(message.from)) {
      log('warn', 'Rate limit exceeded for DM', { phone });
      return;
    }

    const { media, disabledMessage } = await processMedia(message, enrollment.course);
    if (disabledMessage) {
      await sendTextMessage(message.from, disabledMessage);
      return;
    }

    const invocation: BotInvocation = {
      message,
      course: enrollment.course,
      studentName: enrollment.studentName,
      questionText: message.body?.trim() || '',
      media,
      isDm: true,
      chatId: message.from,
    };

    enqueueQuestion(message.from, invocation);
    return;
  }

  const groupId = getGroupId(message);

  // Check if the bot is triggered (mention or reply to bot)
  const mentioned = isBotMentioned(message);
  const replyToBot = isReplyToBot(message);

  if (!mentioned && !replyToBot) {
    res.status(200).json({ ok: true });
    return;
  }

  // Respond immediately so WAHA doesn't retry
  res.status(200).json({ ok: true, processing: true });

  // Rate limit check
  if (!checkRateLimit(groupId)) {
    log('warn', 'Rate limit exceeded', { groupId });
    return;
  }

  // Look up course for this group
  const course = getCourseForGroup(groupId);
  if (!course) {
    log('warn', 'Unrecognized group', { groupId });
    // Attempt to extract group name from message data
    const groupName = message._data?.id?.remote || groupId;
    await notifyAdmin(`קבוצה לא מוגדרת: ${groupName} (${groupId})`);
    return;
  }

  // Process media if present
  const { media, disabledMessage } = await processMedia(message, course);
  if (disabledMessage) {
    await sendTextMessage(groupId, disabledMessage);
    return;
  }

  // Build bot invocation
  const invocation: BotInvocation = {
    message,
    course,
    studentName: message._data?.notifyName || message.from.replace(/@.*/, ''),
    questionText: extractQuestionText(message.body),
    media,
    chatId: groupId,
  };

  // Enqueue for sequential processing (don't await — we already sent 200)
  enqueueQuestion(groupId, invocation);
}
