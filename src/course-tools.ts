import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { log } from './types';
import { sendFile } from './waha-client';

/**
 * Validates that a resolved path stays within the allowed course folder.
 * Prevents path traversal attacks.
 */
function safePath(coursePath: string, relativePath: string): string {
  const resolved = path.resolve(coursePath, relativePath);
  if (!resolved.startsWith(path.resolve(coursePath))) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

export function searchFiles(coursePath: string, query: string): string {
  try {
    // Use grep for text search across course files
    const result = execSync(
      `grep -rni --include="*.md" --include="*.txt" --include="*.yaml" --include="*.yml" -C 2 ${JSON.stringify(query)} ${JSON.stringify(coursePath)}`,
      { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 }
    );

    // Trim overly long results
    const lines = result.split('\n');
    if (lines.length > 80) {
      return lines.slice(0, 80).join('\n') + `\n\n... (${lines.length - 80} more lines, use read_file to see specific files)`;
    }
    return result || 'No results found.';
  } catch (err: unknown) {
    // grep returns exit code 1 when no matches found
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
      return 'No results found.';
    }
    log('error', 'search_files error', { error: String(err) });
    return 'Search error occurred.';
  }
}

export function readFile(coursePath: string, relativePath: string): string {
  try {
    const fullPath = safePath(coursePath, relativePath);
    if (!fs.existsSync(fullPath)) {
      return `File not found: ${relativePath}`;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return `Path is a directory, not a file. Use list_files to see its contents.`;
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    // Limit very large files
    if (content.length > 50000) {
      return content.slice(0, 50000) + '\n\n... (file truncated at 50,000 characters)';
    }
    return content;
  } catch (err) {
    if (err instanceof Error && err.message === 'Path traversal denied') {
      return 'Access denied: path outside course folder.';
    }
    log('error', 'read_file error', { error: String(err) });
    return 'Error reading file.';
  }
}

export function listFiles(coursePath: string, subfolder?: string): string {
  try {
    const targetPath = subfolder ? safePath(coursePath, subfolder) : coursePath;
    if (!fs.existsSync(targetPath)) {
      return `Folder not found: ${subfolder || '.'}`;
    }
    if (!fs.statSync(targetPath).isDirectory()) {
      return `Not a directory: ${subfolder || '.'}`;
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const lines = entries.map(e => {
      const prefix = e.isDirectory() ? '📁 ' : '📄 ';
      return `${prefix}${e.name}`;
    });

    if (lines.length === 0) return 'Empty folder.';
    return lines.join('\n');
  } catch (err) {
    if (err instanceof Error && err.message === 'Path traversal denied') {
      return 'Access denied: path outside course folder.';
    }
    log('error', 'list_files error', { error: String(err) });
    return 'Error listing files.';
  }
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB WhatsApp limit

async function sendCourseFile(
  coursePath: string,
  relativePath: string,
  chatId: string,
  caption?: string,
): Promise<string> {
  try {
    const fullPath = safePath(coursePath, relativePath);
    if (!fs.existsSync(fullPath)) {
      return `הקובץ לא נמצא: ${relativePath}`;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return `הנתיב הוא תיקייה, לא קובץ: ${relativePath}`;
    }
    if (stat.size > MAX_FILE_SIZE) {
      return `הקובץ גדול מדי לשליחה בוואטסאפ (מעל 100MB): ${relativePath}`;
    }

    const fileData = fs.readFileSync(fullPath).toString('base64');
    const filename = path.basename(fullPath);
    const mimetype = getMimeType(fullPath);

    await sendFile(chatId, fileData, filename, mimetype, caption);
    return `הקובץ "${filename}" נשלח בהצלחה.`;
  } catch (err) {
    if (err instanceof Error && err.message === 'Path traversal denied') {
      return 'גישה נדחתה: הנתיב מחוץ לתיקיית הקורס.';
    }
    log('error', 'send_file error', { error: String(err) });
    return 'שגיאה בשליחת הקובץ.';
  }
}

/** Tool definitions for the Claude API */
export const toolDefinitions = [
  {
    name: 'search_files' as const,
    description: 'Search through all course materials (lesson plans, transcripts, schedule, syllabus) for content matching the query. Returns matching lines with surrounding context. Use this to find relevant information before reading full files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'The search term or phrase to look for in course materials',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file' as const,
    description: 'Read the full contents of a specific course file. Use after search_files to get complete context, or to read known files like schedule.md or syllabus.md. Path is relative to the course folder.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Relative path to the file within the course folder (e.g., "lessons/01-intro.md", "schedule.md")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files' as const,
    description: 'List all files and subfolders in the course directory or a specific subfolder. Use to discover what course materials are available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        folder: {
          type: 'string' as const,
          description: 'Optional subfolder to list (e.g., "lessons"). Omit to list the course root folder.',
        },
      },
      required: [],
    },
  },
  {
    name: 'send_file' as const,
    description: 'Send a course file to the student via WhatsApp. Use when a student asks for a specific document, handout, or material from the course. Path is relative to the course folder.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Relative path to the file (e.g., "lessons/01-intro.pdf")',
        },
        caption: {
          type: 'string' as const,
          description: 'Optional caption in Hebrew to send with the file',
        },
      },
      required: ['path'],
    },
  },
];

/** Execute a tool call and return the result */
export async function executeTool(
  coursePath: string,
  toolName: string,
  input: Record<string, string>,
  chatId?: string,
): Promise<string> {
  switch (toolName) {
    case 'search_files':
      return searchFiles(coursePath, input.query);
    case 'read_file':
      return readFile(coursePath, input.path);
    case 'list_files':
      return listFiles(coursePath, input.folder);
    case 'send_file':
      if (!chatId) return 'שגיאה: לא ניתן לשלוח קובץ ללא מזהה צ׳אט.';
      return sendCourseFile(coursePath, input.path, chatId, input.caption);
    default:
      return `Unknown tool: ${toolName}`;
  }
}
