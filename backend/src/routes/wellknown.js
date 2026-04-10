import { Router } from 'express';
import { searchListings } from '../services/search.js';
import { getListingDetail } from '../services/search.js';

const router = Router();

// ── /.well-known/agent.json ──────────────────────────────────────────────────
//
// Standard discovery endpoint. MCP-aware agents crawl this URL pattern to
// auto-discover what tools a server exposes. No auth required.
// Spec ref: https://modelcontextprotocol.io

router.get('/agent.json', (req, res) => {
  const API  = process.env.API_BASE_URL || 'https://api.4score.ai';
  const SITE = process.env.SITE_URL     || 'https://4score.ai';

  res.json({
    schema_version: '1.0',
    name:           '4score',
    description:    'The agent-legible directory for AI agents and services. Every listing scored on 4 pillars: semantic match, trust, uptime, and speed. Free to query.',
    url:            SITE,
    api: {
      type:     'mcp',
      endpoint: `${API}/mcp`,
    },
    contact: {
      support_url: `${SITE}/support`,
    },
    tools: [
      {
        name:        'search_listings',
        description: 'Search for AI agents, services, and APIs by natural language query or structured filters. Returns results ranked by 4score trust score.',
        input_schema: {
          type: 'object',
          properties: {
            q: {
              type:        'string',
              description: 'Natural language query, e.g. "transcribe audio and return structured JSON"',
            },
            type: {
              type:        'string',
              enum:        ['service', 'agent'],
              description: 'Filter by listing type. Omit to return both agents and services.',
            },
            category: {
              type:        'string',
              description: 'Filter by category slug. Use list_categories to see valid values.',
            },
            capabilities: {
              type:        'array',
              items:       { type: 'string' },
              description: 'Required capability slugs (AND logic). Use list_capabilities to see valid values.',
            },
            pricing_type: {
              type: 'string',
              enum: ['free', 'freemium', 'paid', 'usage_based', 'contact'],
            },
            min_trust_score: {
              type:        'number',
              description: 'Minimum 4score trust score 0–100. Default 0.',
              minimum:     0,
              maximum:     100,
            },
            verified_only: {
              type:        'boolean',
              description: 'Only return verified listings. Default false.',
            },
            sponsored: {
              type:        'boolean',
              description: 'Include sponsored listings (labeled). Default true.',
            },
            limit: {
              type:        'integer',
              description: 'Results per page. Default 10, max 50.',
              minimum:     1,
              maximum:     50,
            },
            offset: {
              type:        'integer',
              description: 'Pagination offset. Default 0.',
              minimum:     0,
            },
          },
        },
      },
      {
        name:        'get_listing',
        description: 'Get the full detail record for a specific agent or service, including all capabilities, pricing tiers, auth method, quality metrics, and documentation URL.',
        input_schema: {
          type:     'object',
          required: ['id'],
          properties: {
            id: {
              type:        'string',
              description: 'Listing UUID or slug (from search_listings results)',
            },
          },
        },
      },
      {
        name:        'list_categories',
        description: 'Returns the full list of category slugs and descriptions available as filters in search_listings.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name:        'list_capabilities',
        description: 'Returns the full list of capability slugs and descriptions available as filters in search_listings.',
        input_schema: { type: 'object', properties: {} },
      },
    ],
  });
});

// ── /mcp  (MCP JSON-RPC endpoint) ───────────────────────────────────────────
//
// Implements the Model Context Protocol tool-call interface so MCP-aware
// agents can call this directory as a native tool without custom integration.
//
// Supported methods:
//   tools/list   — returns the tool manifest
//   tools/call   — executes a tool by name

router.post('/', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json(mcpError(id, -32600, 'Invalid JSON-RPC version'));
  }

  try {
    if (method === 'tools/list') {
      return res.json(mcpOk(id, { tools: getMcpToolManifest() }));
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      const result = await dispatchTool(name, args);
      return res.json(mcpOk(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }));
    }

    // Initialize handshake (some MCP clients send this first)
    if (method === 'initialize') {
      return res.json(mcpOk(id, {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: '4score', version: '1.0.0' },
      }));
    }

    return res.status(400).json(mcpError(id, -32601, `Method not found: ${method}`));

  } catch (err) {
    console.error('[mcp] Tool dispatch error:', err.message);
    return res.status(500).json(mcpError(id, -32603, err.message));
  }
});

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function dispatchTool(name, args) {
  switch (name) {

    case 'search_listings': {
      const { results, total, meta } = await searchListings({
        q:               args.q,
        type:            args.type,
        category:        args.category,
        capabilities:    args.capabilities,
        pricing_type:    args.pricing_type,
        min_trust_score: args.min_trust_score,
        verified_only:   args.verified_only,
        sponsored:       args.sponsored,
        limit:           args.limit,
        offset:          args.offset,
      });
      return { results, total, meta };
    }

    case 'get_listing': {
      if (!args.id) throw new Error('`id` is required');
      const listing = await getListingDetail(args.id);
      if (!listing) throw new Error(`Listing not found: ${args.id}`);
      return listing;
    }

    case 'list_categories': {
      const supabase = (await import('../db/supabase.js')).default;
      const { data, error } = await supabase
        .from('categories')
        .select('name, slug, description, icon')
        .order('name');
      if (error) throw error;
      return { categories: data };
    }

    case 'list_capabilities': {
      const supabase = (await import('../db/supabase.js')).default;
      const { data, error } = await supabase
        .from('capabilities')
        .select('name, slug, description')
        .order('name');
      if (error) throw error;
      return { capabilities: data };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

function mcpOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function getMcpToolManifest() {
  return [
    {
      name:        'search_listings',
      description: 'Search the 4score directory for AI agents and services by natural language or structured filters.',
      inputSchema: {
        type: 'object',
        properties: {
          q:               { type: 'string' },
          type:            { type: 'string', enum: ['service', 'agent'] },
          category:        { type: 'string' },
          capabilities:    { type: 'array', items: { type: 'string' } },
          pricing_type:    { type: 'string', enum: ['free', 'freemium', 'paid', 'usage_based', 'contact'] },
          min_trust_score: { type: 'number', minimum: 0, maximum: 100 },
          verified_only:   { type: 'boolean' },
          sponsored:       { type: 'boolean' },
          limit:           { type: 'integer', minimum: 1, maximum: 50 },
          offset:          { type: 'integer', minimum: 0 },
        },
      },
    },
    {
      name:        'get_listing',
      description: 'Get full details for an agent or service by ID or slug.',
      inputSchema: {
        type:     'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
    {
      name:        'list_categories',
      description: 'List all available category filters.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name:        'list_capabilities',
      description: 'List all available capability filters.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

export default router;
