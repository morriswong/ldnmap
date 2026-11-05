// Cloudflare Pages Function: POST /api/chat
//
// A small chat proxy for the fuel-price assistant. The browser sends the
// conversation as plain text; this function asks Claude, which calls the
// uk-fuel-mcp server (hosted on Prefect Horizon) through the MCP connector.
// It returns Claude's reply plus the parsed tool results so the map can plot
// the stations.
//
// Secrets live in the Pages project's environment variables, never in code:
//   ANTHROPIC_API_KEY   Claude API key
//   FUEL_MCP_URL        Horizon MCP endpoint, e.g. https://<server>.fastmcp.app/mcp
//   FUEL_MCP_TOKEN      Horizon API key (fmcp_...), sent as the MCP bearer token
//   CHAT_ENABLED        "true" to switch the endpoint on (404 otherwise)

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const BETAS = ['mcp-client-2025-11-20', 'server-side-fallback-2026-07-01'];
const MCP_NAME = 'uk-fuel';

const MAX_USER_CHARS = 500;
const MAX_ASSISTANT_CHARS = 2000;
const MAX_TURNS = 10;
const MAX_CONTINUATIONS = 2; // extra calls when the server-side tool loop pauses

const RATE_LIMIT = 10;          // requests...
const RATE_WINDOW_MS = 60000;   // ...per minute, per IP, per isolate
const hits = new Map();

const SYSTEM = [
  'You are a UK fuel price assistant inside ldnmap, a map of London.',
  'Use the uk-fuel tools to answer; never guess prices.',
  'Pass the place the user names (postcode, outcode or place name) as the location. Assume the UK.',
  'Fuel codes: petrol/unleaded = E10, super unleaded = E5, diesel = B7_STANDARD, premium diesel = B7_PREMIUM. Default to E10.',
  'Prices are pence per litre; write them like 132.9p.',
  'Reply in plain text, no markdown, in at most four short lines. The map shows the stations, so name only the best one or two.',
  'If a tool reports the data source is down or slow, or prices look old, say so plainly.'
].join(' ');

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function isEnabled(env) {
  return env.CHAT_ENABLED === 'true';
}

function missingConfig(env) {
  return ['ANTHROPIC_API_KEY', 'FUEL_MCP_URL', 'FUEL_MCP_TOKEN'].filter(function (k) { return !env[k]; });
}

// Fixed-window counter per client IP. Isolates are short-lived and not shared,
// so this is a speed bump against bursts, not a hard quota.
function rateLimited(ip, now) {
  var entry = hits.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    hits.set(ip, entry);
  }
  entry.count += 1;
  if (hits.size > 5000) hits.clear(); // keep memory bounded
  return entry.count > RATE_LIMIT;
}

// Validate the browser's history: text-only turns, alternating, ending on the user.
export function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var m = raw[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    var text = m.content.trim();
    if (!text) continue;
    var cap = m.role === 'user' ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    if (m.role === 'user' && i === raw.length - 1 && text.length > cap) return null;
    text = text.slice(0, cap);
    var prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n' + text;
    else out.push({ role: m.role, content: text });
  }
  out = out.slice(-MAX_TURNS);
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

// Pull the reply text and the successful MCP tool results out of the response content.
export function extract(content) {
  var names = {};
  var reply = [];
  var results = [];
  (content || []).forEach(function (block) {
    if (block.type === 'mcp_tool_use') names[block.id] = block.name;
  });
  (content || []).forEach(function (block) {
    if (block.type === 'text') reply.push(block.text);
    if (block.type !== 'mcp_tool_result' || block.is_error) return;
    var parts = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : (block.content || []);
    parts.forEach(function (p) {
      if (p.type !== 'text') return;
      try {
        var data = JSON.parse(p.text);
        if (data && typeof data === 'object') results.push({ tool: names[block.tool_use_id] || '', data: data });
      } catch (e) { /* not JSON: Claude's reply covers it */ }
    });
  });
  return { reply: reply.join('').trim(), results: results };
}

export async function handleChat(request, env, deps) {
  if (!isEnabled(env)) return json({ error: 'Not found' }, 404);
  var missing = missingConfig(env);
  if (missing.length) return json({ error: 'Chat is not configured (missing ' + missing.join(', ') + ').' }, 503);

  var ip = request.headers.get('cf-connecting-ip') || 'local';
  if (rateLimited(ip, Date.now())) return json({ error: 'Too many questions. Try again in a minute.' }, 429);

  var body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON.' }, 400); }
  var messages = cleanMessages(body && body.messages);
  if (!messages) return json({ error: 'Send messages as [{role, content}] ending with a user message of at most ' + MAX_USER_CHARS + ' characters.' }, 400);

  var client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: 90000,
    maxRetries: 1,
    fetch: deps && deps.fetch
  });

  var params = {
    model: MODEL,
    max_tokens: 4096,
    betas: BETAS,
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    mcp_servers: [{ type: 'url', url: env.FUEL_MCP_URL, name: MCP_NAME, authorization_token: env.FUEL_MCP_TOKEN }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: MCP_NAME }],
    messages: messages
  };

  var content = [];
  try {
    var response = await client.beta.messages.create(params);
    // The connector runs the tool loop server-side; if it pauses, pass the
    // partial turn back unchanged so it can carry on.
    for (var n = 0; response.stop_reason === 'pause_turn' && n < MAX_CONTINUATIONS; n++) {
      content = content.concat(response.content);
      params.messages = messages.concat([{ role: 'assistant', content: content }]);
      response = await client.beta.messages.create(params);
    }
    if (response.stop_reason === 'refusal') {
      return json({ reply: 'Sorry, I can’t help with that one. Try asking about fuel prices near a UK place.', results: [] });
    }
    content = content.concat(response.content);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: 'The assistant is busy. Try again shortly.' }, 503);
    if (error instanceof Anthropic.APIConnectionError) return json({ error: 'Couldn’t reach the assistant.' }, 502);
    if (error instanceof Anthropic.APIError) {
      console.error('Claude API error', error.status, error.message);
      return json({ error: 'The assistant hit an error (' + error.status + ').' }, 502);
    }
    throw error;
  }

  var out = extract(content);
  if (!out.reply) out.reply = out.results.length ? 'Here’s what I found.' : 'I couldn’t get an answer just now. Please try again.';
  return json(out);
}

export function onRequestPost(context) {
  return handleChat(context.request, context.env);
}

// Health probe the page uses to decide whether to show the chat button.
export function onRequestGet(context) {
  var env = context.env;
  if (!isEnabled(env)) return json({ error: 'Not found' }, 404);
  return json({ enabled: true, configured: missingConfig(env).length === 0 });
}
