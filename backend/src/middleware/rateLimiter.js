import rateLimit from 'express-rate-limit';

/**
 * Standard rate limiter for all public API endpoints.
 *
 * Agents access the directory for free — this limiter prevents abuse
 * without requiring authentication. Limits are generous enough for
 * legitimate agent workloads.
 *
 * Default: 200 requests per 15 minutes per IP.
 * Configurable via RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX env vars.
 */
export const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 min
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '200'),
  standardHeaders: true,  // Return rate limit info in RateLimit-* headers
  legacyHeaders:   false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error:      'Rate limit exceeded.',
      retry_after: Math.ceil(res.getHeader('RateLimit-Reset') - Date.now() / 1000),
      message:    'AgentDir is free to query. This limit resets every 15 minutes. If you need higher throughput, contact us.',
    });
  },
});

/**
 * Stricter limiter for the MCP endpoint to prevent replay/spam.
 * 60 requests per 15 minutes per IP.
 */
export const mcpLimiter = rateLimit({
  windowMs: 900000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'MCP rate limit exceeded.',
      retry_after: Math.ceil(res.getHeader('RateLimit-Reset') - Date.now() / 1000),
    });
  },
});

/**
 * Very permissive limiter for the /.well-known/agent.json discovery endpoint.
 * Discovery crawlers may hit this frequently; we just want to prevent DoS.
 * 1000 requests per 15 minutes per IP.
 */
export const discoveryLimiter = rateLimit({
  windowMs: 900000,
  max:      1000,
  standardHeaders: true,
  legacyHeaders:   false,
});
