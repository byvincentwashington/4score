import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { apiLimiter, mcpLimiter, discoveryLimiter } from './middleware/rateLimiter.js';
import queryRoute      from './routes/query.js';
import listingsRoute   from './routes/listings.js';
import wellknownRoute  from './routes/wellknown.js';
import reputationRoute from './routes/reputation.js';

const app = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.set('trust proxy', 1); // Required on Railway/Vercel for accurate req.ip

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow agents from any origin
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Fully open — this is a public API designed for agents from any origin.
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));

// ── Health check (no rate limit — used by Railway uptime checks) ─────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: '4score-api', timestamp: new Date().toISOString() });
});

// ── Discovery & MCP ──────────────────────────────────────────────────────────
// /.well-known/agent.json  → GET discovery manifest
// /mcp                     → POST MCP JSON-RPC endpoint
app.use('/.well-known', discoveryLimiter, wellknownRoute);
app.use('/mcp',         mcpLimiter,       wellknownRoute);

// ── Core API ─────────────────────────────────────────────────────────────────
app.use('/api/v1/query',      apiLimiter, queryRoute);
app.use('/api/v1/listings',   apiLimiter, listingsRoute);
app.use('/api/v1/reputation', apiLimiter, reputationRoute);

// ── 404 fallthrough ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    hint:  'See /.well-known/agent.json for available endpoints.',
  });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[app] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
