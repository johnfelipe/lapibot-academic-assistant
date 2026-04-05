import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { execFile } from 'child_process';
import { loadAllCourses } from './course-config';
import { log } from './types';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const GITHUB_COURSES_REPO = process.env.GITHUB_COURSES_REPO || '';
const COURSES_PATH = process.env.COURSES_PATH || './courses';
const WEBHOOK_PORT = parseInt(process.env.GITHUB_WEBHOOK_PORT || '3002', 10);

// Debounce state
let pullInProgress = false;
let pendingPull = false;
let lastPullTime = 0;
const DEBOUNCE_MS = 10_000;

function verifyGitHubSignature(rawBody: Buffer, signature: string): boolean {
  if (!GITHUB_WEBHOOK_SECRET) return false; // require secret — never skip
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const expected = `sha256=${hmac.digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function gitPull(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Ensure remote uses SSH URL (host may use a different SSH alias)
    const sshUrl = `git@github.com:${GITHUB_COURSES_REPO}.git`;
    execFile('git', ['-C', COURSES_PATH, 'remote', 'set-url', 'origin', sshUrl], (setUrlErr) => {
      if (setUrlErr) {
        reject(new Error(`git remote set-url failed: ${setUrlErr.message}`));
        return;
      }
      execFile(
        'git',
        ['-C', COURSES_PATH, 'pull', '--ff-only'],
        { timeout: 30_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`git pull failed: ${stderr || error.message}`));
          } else {
            resolve(stdout.trim());
          }
        },
      );
    });
  });
}

async function performPull(): Promise<void> {
  if (pullInProgress) {
    pendingPull = true;
    log('info', 'GitHub webhook: pull already in progress, queued pending pull');
    return;
  }

  const now = Date.now();
  if (now - lastPullTime < DEBOUNCE_MS) {
    pendingPull = true;
    log('info', 'GitHub webhook: debounced, queued pending pull');
    setTimeout(() => {
      if (pendingPull) {
        pendingPull = false;
        performPull().catch(err => {
          log('error', 'GitHub webhook: deferred pull failed', { error: String(err) });
        });
      }
    }, DEBOUNCE_MS - (now - lastPullTime));
    return;
  }

  pullInProgress = true;
  pendingPull = false;

  try {
    const result = await gitPull();
    lastPullTime = Date.now();
    log('info', 'GitHub webhook: git pull succeeded', { output: result });

    loadAllCourses();
    log('info', 'GitHub webhook: courses reloaded successfully');
  } catch (err) {
    log('error', 'GitHub webhook: git pull failed', { error: String(err) });
  } finally {
    pullInProgress = false;

    // If another push arrived while we were pulling, pull again
    if (pendingPull) {
      pendingPull = false;
      performPull().catch(err => {
        log('error', 'GitHub webhook: pending pull failed', { error: String(err) });
      });
    }
  }
}

function handleGitHubWebhook(req: Request, res: Response): void {
  // Verify signature
  const signature = (req.headers['x-hub-signature-256'] || '') as string;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

  if (!rawBody || !verifyGitHubSignature(rawBody, signature)) {
    log('warn', 'GitHub webhook: signature verification failed');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Only process push events
  const event = req.headers['x-github-event'] as string;
  if (event !== 'push') {
    res.status(200).json({ ok: true, ignored: `event: ${event}` });
    return;
  }

  // Only process pushes to main branch
  const payload = req.body;
  if (payload.ref !== 'refs/heads/main') {
    log('info', 'GitHub webhook: ignoring push to non-main branch', { ref: payload.ref });
    res.status(200).json({ ok: true, ignored: 'not main branch' });
    return;
  }

  // Respond immediately, pull in background
  res.status(200).json({ ok: true, pulling: true });

  performPull().catch(err => {
    log('error', 'GitHub webhook: pull failed', { error: String(err) });
  });
}

export function startGitHubWebhookServer(): void {
  if (!GITHUB_WEBHOOK_SECRET || !GITHUB_COURSES_REPO) {
    log('info', 'GitHub webhook: disabled (missing GITHUB_WEBHOOK_SECRET or GITHUB_COURSES_REPO)');
    return;
  }

  const app = express();

  app.use(express.json({
    verify: (_req, _res, buf) => {
      (_req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));

  app.post('/github-webhook', handleGitHubWebhook);

  app.listen(WEBHOOK_PORT, () => {
    log('info', `GitHub webhook server started on port ${WEBHOOK_PORT}`);
  });
}
