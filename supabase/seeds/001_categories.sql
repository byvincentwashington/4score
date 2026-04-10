-- AgentDir — Category Seed Data
-- Edit slugs carefully — they are the stable public API identifier.

INSERT INTO categories (name, slug, description, icon) VALUES
  ('AI & Machine Learning',     'ai-ml',            'Models, inference APIs, embeddings, fine-tuning, and AI infrastructure', '🤖'),
  ('Data & Analytics',          'data-analytics',   'Databases, data pipelines, BI tools, warehouses, and analytics APIs',   '📊'),
  ('Search & Discovery',        'search-discovery', 'Web search, semantic search, knowledge graphs, and indexing services',  '🔍'),
  ('Communication & Messaging', 'communication',    'Email, SMS, push notifications, chat, and messaging platforms',         '💬'),
  ('Payments & Finance',        'payments-finance', 'Payment processing, invoicing, banking APIs, and financial data',       '💳'),
  ('Storage & Files',           'storage-files',    'Object storage, CDN, file conversion, and document management',         '🗄️'),
  ('Productivity & Automation', 'productivity',     'Task automation, workflow tools, calendar, and scheduling services',    '⚙️'),
  ('Security & Authentication', 'security-auth',    'Identity verification, OAuth, fraud detection, and access control',     '🔒'),
  ('Infrastructure & DevOps',   'infrastructure',   'Cloud compute, monitoring, logging, CI/CD, and deployment tools',       '🏗️'),
  ('E-commerce & Retail',       'ecommerce',        'Product catalogs, inventory, shipping, and retail APIs',               '🛒'),
  ('Healthcare & Medical',      'healthcare',       'Medical records, telemedicine, health data, and clinical APIs',         '🏥'),
  ('Legal & Compliance',        'legal-compliance', 'Contract analysis, regulatory data, KYC, and compliance tools',         '⚖️'),
  ('Travel & Transportation',   'travel',           'Flights, hotels, maps, routing, and logistics APIs',                   '✈️'),
  ('Media & Entertainment',     'media',            'Video, audio, images, streaming, and content delivery',                '🎬'),
  ('Education & Learning',      'education',        'Courses, tutoring, assessments, and educational content APIs',          '📚'),
  ('Weather & Environment',     'weather',          'Weather forecasts, environmental data, geospatial, and sensor feeds',  '🌤️'),
  ('News & Research',           'news-research',    'News aggregation, academic papers, market research, and data feeds',   '📰'),
  ('Developer Tools',           'developer-tools',  'Code execution, testing, documentation, and developer utilities',      '🛠️')
ON CONFLICT (slug) DO NOTHING;
