/**
 * Authentication Handler for Lapibot
 * 
 * Implements a WhatsApp-based login flow:
 * 1. User sends DM → bot checks if authenticated
 * 2. If not authenticated → asks for username
 * 3. User sends username → bot asks for password
 * 4. User sends password → validates against PostgreSQL (bcrypt hashed)
 * 5. If valid → creates session, user can access conversational AI
 * 6. If invalid → error message, can retry
 * 
 * Inspired by PyWA's listener pattern for multi-step conversations.
 */

import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { log } from './types';
import { sendTextMessage, deleteMessage } from './waha-client';

// ─── Configuration ───────────────────────────────────────────────────────────

const SESSION_TTL_MS = parseInt(process.env.AUTH_SESSION_TTL_MS || String(24 * 60 * 60 * 1000)); // 24h default
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.AUTH_MAX_ATTEMPTS || '5');
const LOCKOUT_DURATION_MS = parseInt(process.env.AUTH_LOCKOUT_MS || String(15 * 60 * 1000)); // 15 min

// ─── PostgreSQL Connection ───────────────────────────────────────────────────

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'lapibot_auth',
  user: process.env.PGUSER || 'lapibot',
  password: process.env.PGPASSWORD || 'lapibot_secret',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface AuthSession {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  authenticatedAt: number;
  expiresAt: number;
}

interface LoginState {
  step: 'awaiting_username' | 'awaiting_password';
  username?: string;
  startedAt: number;
}

interface FailedAttempts {
  count: number;
  lastAttempt: number;
  lockedUntil?: number;
}

// ─── In-Memory State ─────────────────────────────────────────────────────────

// chatId → AuthSession (authenticated users)
const activeSessions = new Map<string, AuthSession>();

// chatId → LoginState (users in the middle of logging in)
const loginStates = new Map<string, LoginState>();

// chatId → FailedAttempts (rate limiting)
const failedAttempts = new Map<string, FailedAttempts>();

// ─── Database Operations ─────────────────────────────────────────────────────

interface DbUser {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;
  is_active: boolean;
}

async function findUserByUsername(username: string): Promise<DbUser | null> {
  try {
    const result = await pool.query<DbUser>(
      'SELECT id, username, password_hash, display_name, role, is_active FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    return result.rows[0] || null;
  } catch (err) {
    log('error', 'Database query failed', { error: String(err) });
    return null;
  }
}

async function verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plainPassword, hash);
  } catch (err) {
    log('error', 'Password verification failed', { error: String(err) });
    return false;
  }
}

// ─── Session Management ──────────────────────────────────────────────────────

export function getAuthSession(chatId: string): AuthSession | null {
  const session = activeSessions.get(chatId);
  if (!session) return null;

  // Check expiration
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(chatId);
    log('info', 'Auth session expired', { chatId, username: session.username });
    return null;
  }

  return session;
}

export function isAuthenticated(chatId: string): boolean {
  return getAuthSession(chatId) !== null;
}

export function isInLoginFlow(chatId: string): boolean {
  const state = loginStates.get(chatId);
  if (!state) return false;

  // Expire login flows after 5 minutes of inactivity
  if (Date.now() - state.startedAt > 5 * 60 * 1000) {
    loginStates.delete(chatId);
    return false;
  }

  return true;
}

function isLockedOut(chatId: string): boolean {
  const attempts = failedAttempts.get(chatId);
  if (!attempts || !attempts.lockedUntil) return false;

  if (Date.now() > attempts.lockedUntil) {
    failedAttempts.delete(chatId);
    return false;
  }

  return true;
}

function recordFailedAttempt(chatId: string): { locked: boolean; remainingAttempts: number } {
  const attempts = failedAttempts.get(chatId) || { count: 0, lastAttempt: 0 };
  attempts.count++;
  attempts.lastAttempt = Date.now();

  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    attempts.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    failedAttempts.set(chatId, attempts);
    return { locked: true, remainingAttempts: 0 };
  }

  failedAttempts.set(chatId, attempts);
  return { locked: false, remainingAttempts: MAX_LOGIN_ATTEMPTS - attempts.count };
}

function clearFailedAttempts(chatId: string): void {
  failedAttempts.delete(chatId);
}

// ─── Login Flow Handler ──────────────────────────────────────────────────────

/**
 * Handles the authentication flow for a DM message.
 * Returns:
 * - 'authenticated' if user has active session (proceed to bot)
 * - 'handled' if message was consumed by auth flow (don't process further)
 */
export async function handleAuthFlow(chatId: string, messageBody: string, messageId?: string): Promise<'authenticated' | 'handled'> {
  // 1. Check if already authenticated
  if (isAuthenticated(chatId)) {
    // Check for logout command
    if (messageBody.toLowerCase() === '/logout' || messageBody.toLowerCase() === '/salir') {
      const session = activeSessions.get(chatId);
      activeSessions.delete(chatId);
      await sendTextMessage(chatId, `Sesión cerrada correctamente. ¡Hasta pronto, ${session?.displayName || 'usuario'}! 👋\n\nPara volver a acceder, escribe cualquier mensaje.`);
      return 'handled';
    }
    return 'authenticated';
  }

  // 2. Check if locked out
  if (isLockedOut(chatId)) {
    const attempts = failedAttempts.get(chatId)!;
    const remainingMs = attempts.lockedUntil! - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60000);
    await sendTextMessage(chatId, `⚠️ Tu cuenta está temporalmente bloqueada por múltiples intentos fallidos.\n\nIntenta de nuevo en ${remainingMin} minuto(s).`);
    return 'handled';
  }

  // 3. Check if in login flow
  const state = loginStates.get(chatId);

  if (!state) {
    // Start login flow
    loginStates.set(chatId, { step: 'awaiting_username', startedAt: Date.now() });
    await sendTextMessage(chatId,
      `🔐 *Autenticación requerida*\n\n` +
      `Para acceder al asistente académico, necesitas iniciar sesión.\n\n` +
      `Por favor, ingresa tu *nombre de usuario*:`
    );
    return 'handled';
  }

  if (state.step === 'awaiting_username') {
    // User sent their username
    const username = messageBody.trim();

    if (!username || username.length < 2) {
      await sendTextMessage(chatId, `El nombre de usuario no es válido. Por favor, ingrésalo de nuevo:`);
      return 'handled';
    }

    // Move to password step
    loginStates.set(chatId, { step: 'awaiting_password', username, startedAt: state.startedAt });
    await sendTextMessage(chatId, `Ahora ingresa tu *contraseña*:`);
    return 'handled';
  }

  if (state.step === 'awaiting_password') {
    // User sent their password — delete it immediately for security
    const password = messageBody.trim();
    const username = state.username!;

    // Delete the password message from chat (security: don't leave passwords visible)
    if (messageId) {
      deleteMessage(chatId, messageId).catch(() => {});
    }

    // Send a masked confirmation so user knows we received it
    await sendTextMessage(chatId, '🔑 Contraseña recibida: ********\n\nVerificando credenciales...');

    // Clear login state
    loginStates.delete(chatId);

    // Validate credentials against PostgreSQL
    const user = await findUserByUsername(username);

    if (!user) {
      const { locked, remainingAttempts } = recordFailedAttempt(chatId);
      if (locked) {
        await sendTextMessage(chatId, `❌ Credenciales incorrectas.\n\n⚠️ Has excedido el número máximo de intentos. Tu cuenta ha sido bloqueada temporalmente por 15 minutos.`);
      } else {
        await sendTextMessage(chatId, `❌ Credenciales incorrectas. Intentos restantes: ${remainingAttempts}\n\nEscribe cualquier mensaje para intentar de nuevo.`);
      }
      return 'handled';
    }

    if (!user.is_active) {
      await sendTextMessage(chatId, `❌ Tu cuenta está desactivada. Contacta al administrador del curso.`);
      return 'handled';
    }

    const passwordValid = await verifyPassword(password, user.password_hash);

    if (!passwordValid) {
      const { locked, remainingAttempts } = recordFailedAttempt(chatId);
      if (locked) {
        await sendTextMessage(chatId, `❌ Credenciales incorrectas.\n\n⚠️ Has excedido el número máximo de intentos. Tu cuenta ha sido bloqueada temporalmente por 15 minutos.`);
      } else {
        await sendTextMessage(chatId, `❌ Credenciales incorrectas. Intentos restantes: ${remainingAttempts}\n\nEscribe cualquier mensaje para intentar de nuevo.`);
      }
      return 'handled';
    }

    // Authentication successful!
    clearFailedAttempts(chatId);
    const now = Date.now();
    activeSessions.set(chatId, {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      authenticatedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });

    log('info', 'User authenticated successfully', { chatId, username: user.username, displayName: user.display_name });

    await sendTextMessage(chatId,
      `✅ *¡Bienvenido/a, ${user.display_name}!*\n\n` +
      `Has iniciado sesión correctamente.\n` +
      `Ahora puedes hacerme preguntas sobre el curso.\n\n` +
      `_Tu sesión expira en 24 horas. Escribe /salir para cerrar sesión._`
    );
    return 'handled';
  }

  // Fallback: shouldn't reach here
  loginStates.delete(chatId);
  return 'handled';
}

// ─── Database Initialization ─────────────────────────────────────────────────

export async function initAuthDatabase(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        role VARCHAR(20) DEFAULT 'student',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );
    `);
    log('info', 'Auth database initialized (users table ready)');
  } catch (err) {
    log('error', 'Failed to initialize auth database', { error: String(err) });
  }
}

// ─── Utility: Hash password (for seeding) ────────────────────────────────────

export async function hashPassword(plainPassword: string): Promise<string> {
  const SALT_ROUNDS = 12;
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [chatId, session] of activeSessions.entries()) {
    if (now > session.expiresAt) {
      activeSessions.delete(chatId);
      log('info', 'Cleaned up expired session', { chatId, username: session.username });
    }
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
