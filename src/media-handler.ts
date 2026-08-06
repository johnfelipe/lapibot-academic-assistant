import { downloadMedia } from './waha-client';
import { WebhookMessage, MediaContent, CourseContext, log } from './types';

/** Map WAHA media types to our content types */
function classifyMedia(mimetype: string): 'image' | 'document' | 'audio' | null {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/') || mimetype === 'audio/ogg; codecs=opus') return 'audio';
  if (
    mimetype === 'application/pdf' ||
    mimetype.startsWith('application/vnd.') ||
    mimetype === 'application/msword' ||
    mimetype === 'text/plain'
  ) {
    return 'document';
  }
  return null;
}

/** Spanish labels for media types (for disabled-type responses) */
const mediaTypeLabels: Record<string, string> = {
  image: 'imágenes',
  document: 'documentos',
  audio: 'mensajes de voz',
};

/**
 * Process media from a webhook message.
 * Returns MediaContent if media is present and enabled, or an error/disabled message string.
 */
export async function processMedia(
  message: WebhookMessage,
  course: CourseContext
): Promise<{ media?: MediaContent; disabledMessage?: string }> {
  if (!message.hasMedia) return {};

  // Determine media type from the webhook payload
  const payload = message as unknown as {
    mediaUrl?: string;
    media?: { mimetype: string; filename: string };
  };

  if (!payload.mediaUrl || !payload.media?.mimetype) {
    log('warn', 'Message has media but missing mediaUrl or mimetype', { messageId: message.id });
    return {};
  }

  const mediaType = classifyMedia(payload.media.mimetype);
  if (!mediaType) {
    log('info', 'Unsupported media type', { mimetype: payload.media.mimetype });
    return {};
  }

  // Check if this media type is enabled for the course
  const mediaConfig = course.config.media;
  const configKey = mediaType === 'image' ? 'images' : mediaType === 'document' ? 'documents' : 'voice';
  if (!mediaConfig[configKey]) {
    return {
      disabledMessage: `No estoy configurado para leer ${mediaTypeLabels[mediaType]} en este grupo`,
    };
  }

  // Download and encode the media
  try {
    const buffer = await downloadMedia(payload.mediaUrl);
    const base64 = buffer.toString('base64');

    return {
      media: {
        type: mediaType,
        mimeType: payload.media.mimetype,
        data: base64,
        filename: payload.media.filename,
      },
    };
  } catch (err) {
    log('error', 'Failed to download media', { error: String(err), messageId: message.id });
    return {
      disabledMessage: 'No pude leer el archivo que adjuntaste. ¿Puedes intentarlo de nuevo?',
    };
  }
}
