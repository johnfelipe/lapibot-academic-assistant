import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import Papa from 'papaparse';
import { CourseConfig, CourseContext, log } from './types';

export const COURSES_PATH = process.env.COURSES_PATH || './courses';

// Group ID → CourseContext mapping
const groupCourseMap = new Map<string, CourseContext>();

// Phone → CourseContext + student name mapping (for DMs)
const phoneCourseMap = new Map<string, { course: CourseContext; studentName: string }>();

// Cached DM rejection message for non-enrolled users
let dmNotEnrolledMessage: string | null = null;

function loadCourseConfig(coursePath: string): CourseConfig | null {
  const configPath = path.join(coursePath, 'config.yaml');
  if (!fs.existsSync(configPath)) return null;

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = parseYaml(raw) as CourseConfig;

  // Defaults for optional fields
  if (!config.media) {
    config.media = { images: true, documents: true, voice: true };
  }

  return config;
}

function loadOptionalFile(coursePath: string, filename: string): string | null {
  const filePath = path.join(coursePath, filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export interface ParticipantRow {
  name: string;
  firstName: string;
  phone: string; // normalized: 972xx format
  title: string;
  practice: string;
  aiTools: string;
  notes: string;
}

/**
 * Parse participants.csv into structured rows using proper CSV parsing.
 * Handles quoted fields with commas correctly.
 * Phone normalization: 05xx → 972xx, strips annotations like "(עוז כהן)".
 */
export function parseParticipantsCsv(coursePath: string): ParticipantRow[] {
  const csvPath = path.join(coursePath, 'participants.csv');
  if (!fs.existsSync(csvPath)) return [];

  const content = fs.readFileSync(csvPath, 'utf-8');
  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  const records = result.data as Record<string, string>[];

  return records
    .filter(r => r['שם פרטי'])
    .map(r => {
      let phone = (r['טלפון'] || r['סלולרי'] || '').replace(/\s*\(.*?\)\s*/g, '').replace(/[^0-9]/g, '');

      const firstName = r['שם פרטי'];
      const lastName = r['שם משפחה'] || '';
      return {
        name: lastName ? `${firstName} ${lastName}` : firstName,
        firstName,
        phone,
        title: r['תואר'] || '',
        practice: r['תחום עיסוק'] || '',
        aiTools: r['כלי AI בשימוש'] || '',
        notes: r['הערות וציפיות'] || '',
      };
    });
}

function loadParticipantPhones(coursePath: string, course: CourseContext): void {
  for (const row of parseParticipantsCsv(coursePath)) {
    if (!row.phone || phoneCourseMap.has(row.phone)) continue;
    phoneCourseMap.set(row.phone, { course, studentName: row.name });
  }
}

export function loadAllCourses(): void {
  groupCourseMap.clear();
  phoneCourseMap.clear();
  dmNotEnrolledMessage = null;

  if (!fs.existsSync(COURSES_PATH)) {
    log('warn', 'Courses path does not exist', { path: COURSES_PATH });
    return;
  }

  const entries = fs.readdirSync(COURSES_PATH, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // skip hidden dirs like .git

    const coursePath = path.join(COURSES_PATH, entry.name);
    const config = loadCourseConfig(coursePath);
    if (!config) {
      log('warn', 'No config.yaml found in course folder', { folder: entry.name });
      continue;
    }

    const systemPrompt = loadOptionalFile(coursePath, 'prompt.md');

    const context: CourseContext = { config, coursePath, systemPrompt };

    for (const groupId of config.whatsappGroups) {
      if (groupCourseMap.has(groupId)) {
        log('warn', 'Duplicate group ID across courses', {
          groupId,
          course: config.name,
        });
      }
      groupCourseMap.set(groupId, context);
      log('info', 'Registered group', { groupId, course: config.name });
    }

    // Build phone→course map from participants.csv
    loadParticipantPhones(coursePath, context);
  }

  log('info', 'Courses loaded', {
    courseCount: entries.filter(e => e.isDirectory()).length,
    groupCount: groupCourseMap.size,
    enrolledPhones: phoneCourseMap.size,
  });
}

export function getCourseForGroup(groupId: string): CourseContext | undefined {
  return groupCourseMap.get(groupId);
}

export function getAllGroupIds(): string[] {
  return Array.from(groupCourseMap.keys());
}

export function getCourseForPhone(phone: string): { course: CourseContext; studentName: string } | undefined {
  return phoneCourseMap.get(phone);
}

export function loadDmNotEnrolledMessage(): string {
  if (dmNotEnrolledMessage) return dmNotEnrolledMessage;

  const filePath = path.join(COURSES_PATH, 'dm-not-enrolled.md');
  if (fs.existsSync(filePath)) {
    dmNotEnrolledMessage = fs.readFileSync(filePath, 'utf-8').trim();
  } else {
    dmNotEnrolledMessage = 'שלום! אני לפיבוט, העוזר הלימודי של קורסי AI4LAW.\nאני זמין רק למשתתפי הקורסים.';
  }
  return dmNotEnrolledMessage;
}
