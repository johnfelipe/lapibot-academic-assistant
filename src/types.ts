export interface CourseConfig {
  name: string;
  instructor: string;
  botName: string;
  language: string;
  description: string;
  whatsappGroups: string[];
  media: {
    images: boolean;
    documents: boolean;
    voice: boolean;
  };
}

export interface CourseContext {
  config: CourseConfig;
  coursePath: string;
  systemPrompt: string | null;
}

export interface WebhookPayload {
  event: string;
  session: string;
  engine: string;
  payload: WebhookMessage;
}

export interface WebhookMessage {
  id: string;
  timestamp: number;
  from: string;
  to: string;
  body: string;
  hasMedia: boolean;
  fromMe: boolean;
  _data: WebhookMessageData;
}

export interface WebhookMessageData {
  id: {
    fromMe: boolean;
    remote: string;
    id: string;
    _serialized: string;
  };
  body: string;
  type: string;
  notifyName: string;
  from: string;
  to: string;
  mentionedJidList?: string[];
  quotedMsg?: {
    body: string;
    from: string;
    id?: { _serialized: string };
  };
  quotedStanzaID?: string;
  quotedParticipant?: string;
  // NOWEB engine stores reply context here instead of quotedMsg/quotedParticipant
  message?: {
    extendedTextMessage?: {
      contextInfo?: {
        participant?: string;
        stanzaId?: string;
        quotedMessage?: { conversation?: string };
      };
    };
  };
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  from: string;
  to: string;
  body: string;
  fromMe: boolean;
  hasMedia: boolean;
  participant?: string; // sender LID in group messages (NOWEB)
  _data?: {
    notifyName?: string;
    pushName?: string; // sender display name (NOWEB)
    type?: string;
    key?: {
      participant?: string; // sender LID (e.g., "257161284292715@lid")
      participantAlt?: string; // sender phone (e.g., "972501234567@s.whatsapp.net")
    };
  };
  mediaUrl?: string;
  media?: {
    mimetype: string;
    filename: string;
  };
}

export interface MediaContent {
  type: 'image' | 'document' | 'audio';
  mimeType: string;
  data: string; // base64
  filename?: string;
}

export interface BotInvocation {
  message: WebhookMessage;
  course: CourseContext;
  studentName: string;
  questionText: string;
  media?: MediaContent;
  isDm?: boolean;    // true for private messages
  chatId?: string;   // explicit chat ID (group ID or sender JID)
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
}

export function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}
