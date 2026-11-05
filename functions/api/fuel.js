// Cloudflare Pages Function: GET /api/fuel
//
// Postcode lookup for the fuel-price panel. The browser sends a location and a
// fuel code; this function calls the uk-fuel-mcp server's cheapest_fuel_near tool
// (one stateless MCP request) and returns the tool's JSON, which the map plots.
// The server key stays here, never in the page.
//
// Secrets live in the Pages project's environment variables, never in code:
//   FUEL_MCP_URL        MCP endpoint, e.g. https://uk-fuel-mcp.<subdomain>.workers.dev/mcp
//   FUEL_MCP_TOKEN      a key from the server's MCP_API_KEYS, sent as the MCP bearer token
//   FUEL_ENABLED        "true" to switch the endpoint on (404 otherwise)

const FUELS = ['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM', 'B10', 'HVO'];
const MAX_LOCATION_CHARS = 60;
const DEFAULT_RADIUS = 5;
const LIMIT = 10;
const TIMEOUT_MS = 60000; // the first lookup after a quiet spell refetches the dataset

const RATE_LIMIT = 30;          // requests...
const RATE_WINDOW_MS = 60000;   // ...per minute, per IP, per isolate
const hits = new Map();

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function isEnabled(env) {
  return env.FUEL_ENABLED === 'true';
}

function missingConfig(env) {
  return ['FUEL_MCP_URL', 'FUEL_MCP_TOKEN'].filter(function (k) { return !env[k]; });
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

// Validate the query string. Returns { args } or { error }.
export function parseQuery(params) {
  var location = (params.get('location') || '').trim();
  if (!location) return { error: 'Enter a UK postcode or place.' };
  if (location.length > MAX_LOCATION_CHARS) return { error: 'That location is too long.' };
  var fuel = (params.get('fuel') || 'E10').toUpperCase();
  if (FUELS.indexOf(fuel) === -1) return { error: 'Unknown fuel type.' };
  var radius = params.has('radius') ? Number(params.get('radius')) : DEFAULT_RADIUS;
  if (!(radius > 0 && radius <= 25)) return { error: 'Radius must be between 0 and 25 miles.' };
  return { args: { location: location, fuel: fuel, radius_miles: radius, limit: LIMIT } };
}

// The server answers a stateless tools/call as JSON or as a one-event SSE stream.
export function parseRpcBody(text) {
  var trimmed = text.trim();
  if (trimmed.charAt(0) === '{') return JSON.parse(trimmed);
  var data = trimmed.split('\n').filter(function (l) { return l.indexOf('data:') === 0; });
  if (!data.length) throw new Error('Empty response');
  return JSON.parse(data[data.length - 1].slice(5));
}

export async function handleFuel(request, env, deps) {
  if (!isEnabled(env)) return json({ error: 'Not found' }, 404);
  var params = new URL(request.url).searchParams;
  var missing = missingConfig(env);
  if (!params.has('location')) return json({ enabled: true, configured: missing.length === 0 });
  if (missing.length) return json({ error: 'Fuel prices are not configured (missing ' + missing.join(', ') + ').' }, 503);

  var ip = request.headers.get('cf-connecting-ip') || 'local';
  if (rateLimited(ip, Date.now())) return json({ error: 'Too many lookups. Try again in a minute.' }, 429);

  var parsed = parseQuery(params);
  if (parsed.error) return json({ error: parsed.error }, 400);

  var doFetch = (deps && deps.fetch) || fetch;
  var rpc;
  try {
    var r = await doFetch(env.FUEL_MCP_URL, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + env.FUEL_MCP_TOKEN,
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cheapest_fuel_near', arguments: parsed.args }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) {
      console.error('Fuel server HTTP', r.status);
      return json({ error: 'The fuel price service is unavailable (' + r.status + ').' }, 502);
    }
    rpc = parseRpcBody(await r.text());
  } catch (error) {
    console.error('Fuel server request failed', error && error.name);
    return json({ error: error && error.name === 'TimeoutError' ? 'The fuel price service timed out. Try again.' : 'Couldn’t reach the fuel price service.' }, 502);
  }

  var result = rpc && rpc.result;
  var text = result && result.content && result.content[0] && result.content[0].text;
  if (!result || typeof text !== 'string') {
    console.error('Fuel server bad response', rpc && rpc.error);
    return json({ error: 'The fuel price service sent an unexpected reply.' }, 502);
  }
  // Tool errors (unknown place, data source down) are written for people; pass them on.
  if (result.isError) return json({ error: text }, 400);
  try {
    return json(JSON.parse(text));
  } catch (e) {
    return json({ error: 'The fuel price service sent an unexpected reply.' }, 502);
  }
}

export function onRequestGet(context) {
  return handleFuel(context.request, context.env);
}
