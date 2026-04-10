import { VoyageAIClient as VoyageAI } from 'voyageai';

// voyage-3 produces 1024-dimensional embeddings.
// This matches the vector(1024) column in the listings table.
const MODEL = 'voyage-3';

let client;

function getClient() {
  if (!client) {
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error('VOYAGE_API_KEY must be set in environment');
    }
    client = new VoyageAI({ apiKey: process.env.VOYAGE_API_KEY });
  }
  return client;
}

/**
 * Embed a single string.
 * @param {string} text
 * @returns {Promise<number[]>}  1024-dimensional vector
 */
export async function embedText(text) {
  const result = await getClient().embed({
    input: [text],
    model: MODEL,
    inputType: 'query', // 'query' for search queries; 'document' when indexing listings
  });
  return result.data[0].embedding;
}

/**
 * Embed a listing description for indexing.
 * Uses inputType 'document' — Voyage optimises differently from queries.
 *
 * @param {string} text  Concatenated name + short_description + description
 * @returns {Promise<number[]>}
 */
export async function embedDocument(text) {
  const result = await getClient().embed({
    input: [text],
    model: MODEL,
    inputType: 'document',
  });
  return result.data[0].embedding;
}

/**
 * Embed multiple documents in one API call (max 128 per request).
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedDocuments(texts) {
  const result = await getClient().embed({
    input: texts,
    model: MODEL,
    inputType: 'document',
  });
  return result.data.map((d) => d.embedding);
}

/**
 * Build the text blob used for embedding a listing.
 * Includes name, short description, description, and capability slugs
 * so that semantic search can match on capability concepts.
 *
 * @param {object} listing
 * @returns {string}
 */
export function buildListingEmbedText(listing) {
  const parts = [
    listing.name,
    listing.short_description,
    listing.description,
    listing.capabilities?.join(' ') ?? '',
    listing.tags?.join(' ') ?? '',
  ];
  return parts.filter(Boolean).join(' ');
}
