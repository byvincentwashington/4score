-- AgentDir — Capability Seed Data
-- These are the machine-readable capability tags agents filter on.
-- Keep slugs stable — they are part of the public query API contract.

INSERT INTO capabilities (name, slug, description) VALUES
  -- Text & Language
  ('Text Generation',        'text-generation',      'Generate human-quality text, articles, or copy'),
  ('Text Summarization',     'text-summarization',   'Condense long-form content into summaries'),
  ('Translation',            'translation',          'Translate content between languages'),
  ('Classification',         'classification',       'Categorize or label text, images, or data'),
  ('Sentiment Analysis',     'sentiment-analysis',   'Detect tone, emotion, or opinion in text'),
  ('Named Entity Recognition','ner',                 'Extract people, places, orgs, dates from text'),

  -- Data & Search
  ('Web Search',             'web-search',           'Query the live web and return results'),
  ('Semantic Search',        'semantic-search',      'Find relevant content by meaning, not keywords'),
  ('Data Extraction',        'data-extraction',      'Pull structured data from unstructured sources'),
  ('Data Enrichment',        'data-enrichment',      'Augment records with additional context or signals'),
  ('Vector Embeddings',      'vector-embeddings',    'Convert text or media into vector representations'),
  ('Database Query',         'database-query',       'Query structured databases via SQL or API'),

  -- Code & Execution
  ('Code Generation',        'code-generation',      'Write, complete, or explain code'),
  ('Code Execution',         'code-execution',       'Run code in a sandboxed environment'),
  ('API Integration',        'api-integration',      'Connect to and orchestrate third-party APIs'),

  -- Files & Media
  ('Document Parsing',       'document-parsing',     'Extract content from PDFs, Word docs, spreadsheets'),
  ('File Processing',        'file-processing',      'Transform, convert, or process file formats'),
  ('Image Generation',       'image-generation',     'Create or edit images from prompts'),
  ('Image Analysis',         'image-analysis',       'Describe, classify, or extract data from images'),
  ('Audio Transcription',    'audio-transcription',  'Convert speech or audio to text'),
  ('Audio Generation',       'audio-generation',     'Generate speech or audio from text'),
  ('Video Processing',       'video-processing',     'Analyze, caption, or transform video content'),

  -- Communication & Actions
  ('Email Sending',          'email-sending',        'Send transactional or marketing emails'),
  ('SMS / Push',             'sms-push',             'Send SMS messages or push notifications'),
  ('Calendar Management',    'calendar-management',  'Read, create, or update calendar events'),
  ('Browser Automation',     'browser-automation',   'Control a browser to perform web actions'),

  -- Identity & Payments
  ('Payment Processing',     'payment-processing',   'Charge, refund, or manage payment transactions'),
  ('Identity Verification',  'identity-verification','Verify user identity via documents or biometrics'),
  ('Authentication / SSO',   'auth-sso',             'Handle login, OAuth flows, and SSO'),

  -- Infrastructure
  ('Storage',                'storage',              'Store and retrieve files or objects'),
  ('Caching',                'caching',              'Cache data for fast repeated retrieval'),
  ('Queue / Messaging',      'queue-messaging',      'Publish and consume async message queues'),
  ('Monitoring & Alerting',  'monitoring-alerting',  'Track uptime, errors, and trigger alerts')

ON CONFLICT (slug) DO NOTHING;
