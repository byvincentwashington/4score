// Vercel serverless entry point.
// Imports the Express app and exports it as the default handler.
// Vercel wraps this in a serverless function — no app.listen() needed.
import app from '../src/app.js';

export default app;
