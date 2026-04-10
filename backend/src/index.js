import app from './app.js';

const PORT = parseInt(process.env.PORT || '3001');

app.listen(PORT, () => {
  console.log(`[4score] API listening on port ${PORT}`);
  console.log(`[4score] Environment: ${process.env.NODE_ENV || 'development'}`);
});
