import 'dotenv/config';
import express from 'express';
import { handleWebhook, initBotIdentifiers } from './webhook-handler';
import { initAuthDatabase } from './auth-handler';
import { loadAllCourses } from './course-config';
import { getSessionStatus } from './waha-client';
import { startGitHubWebhookServer } from './github-webhook';
import { log } from './types';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();

// Parse JSON body, preserving raw body for HMAC verification
app.use('/webhook', express.json({
  verify: (_req, _res, buf) => {
    (_req as unknown as { rawBody: Buffer }).rawBody = buf;
  },
}));

// Default JSON parser for other routes
app.use(express.json());

// Health check endpoint
app.get('/health', async (_req, res) => {
  try {
    const wahaStatus = await getSessionStatus();
    res.json({
      status: 'ok',
      waha: wahaStatus.status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      waha: 'unreachable',
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

// WAHA webhook endpoint
app.post('/webhook', handleWebhook);

// Load course configs and start server
loadAllCourses();

app.listen(PORT, async () => {
  log('info', `Lapibot server started on port ${PORT}`);
  // Initialize auth database (creates table if not exists)
  await initAuthDatabase();
  // Fetch bot's LID from WAHA (needed for NOWEB mention detection)
  await initBotIdentifiers();
});

// Start GitHub webhook server on separate port (only if configured)
startGitHubWebhookServer();
