import { ChatMessage, log } from './types';

const WAHA_API_URL = process.env.WAHA_API_URL || 'http://localhost:3000';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WAHA_API_KEY) h['X-Api-Key'] = WAHA_API_KEY;
  return h;
}

async function wahaFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${WAHA_API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(), ...(options.headers as Record<string, string> || {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WAHA API error ${response.status}: ${text}`);
  }
  return response.json();
}

export async function startTyping(chatId: string): Promise<void> {
  await wahaFetch(`/api/${WAHA_SESSION}/presence`, {
    method: 'POST',
    body: JSON.stringify({ chatId, presence: 'typing' }),
  });
}

export async function stopTyping(chatId: string): Promise<void> {
  await wahaFetch(`/api/${WAHA_SESSION}/presence`, {
    method: 'POST',
    body: JSON.stringify({ chatId, presence: 'paused' }),
  });
}

export async function sendTextMessage(chatId: string, text: string, replyTo?: string): Promise<string> {
  const body: Record<string, string> = { session: WAHA_SESSION, chatId, text };
  if (replyTo) body.reply_to = replyTo;

  const data = await wahaFetch('/api/sendText', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as { id?: { _serialized?: string; id?: string } };

  const messageId = data.id?._serialized || data.id?.id || 'sent';
  log('info', 'Message sent', { chatId, messageId });
  return messageId;
}

export async function getChatMessages(chatId: string, limit: number = 30): Promise<ChatMessage[]> {
  const data = await wahaFetch(
    `/api/${WAHA_SESSION}/chats/${chatId}/messages?limit=${limit}&downloadMedia=false`,
    { method: 'GET' }
  );
  return data as ChatMessage[];
}

export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  // mediaUrl from WAHA is a full URL to the WAHA server
  const url = mediaUrl.startsWith('http') ? mediaUrl : `${WAHA_API_URL}${mediaUrl}`;
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function sendFile(
  chatId: string,
  fileData: string,
  filename: string,
  mimetype: string,
  caption?: string,
): Promise<string> {
  const data = await wahaFetch('/api/sendFile', {
    method: 'POST',
    body: JSON.stringify({
      session: WAHA_SESSION,
      chatId,
      file: {
        mimetype,
        data: fileData,
        filename,
      },
      caption: caption || '',
    }),
  }) as { id?: { _serialized?: string; id?: string } };

  const messageId = data.id?._serialized || data.id?.id || 'sent';
  log('info', 'File sent', { chatId, filename, messageId });
  return messageId;
}

export async function getSessionStatus(): Promise<{ status: string; me?: { id: string; pushName?: string; lid?: string } }> {
  const data = await wahaFetch(`/api/sessions/${WAHA_SESSION}`, { method: 'GET' });
  return data as { status: string; me?: { id: string; pushName?: string; lid?: string } };
}

/**
 * Resolve a LID to a phone number using WAHA's LID API.
 * Returns the phone number (e.g. "972501234567") or null if not found.
 */
export async function resolveLidToPhone(lid: string): Promise<string | null> {
  try {
    const id = lid.replace(/@.*/, '');
    const data = await wahaFetch(`/api/${WAHA_SESSION}/lids/${id}`, { method: 'GET' }) as { lid: string; pn: string | null };
    if (data.pn) {
      return data.pn.replace(/@.*/, '');
    }
    return null;
  } catch {
    return null;
  }
}
