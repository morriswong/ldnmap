// Cloudflare Pages Function: GET /api/fuel
//
// Postcode lookup for the fuel-price panel. The browser sends a location (or map
// coordinates, which are turned into the nearest postcode via postcodes.io) and a
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
const POSTCODES_URL = 'https://api.postcodes.io/postcodes';
const NEAREST_POSTCODE_METRES = 2000; // postcodes.io's maximum search radius

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

// A lookup names a place (?location=) or a point (?lat=&lon=).
function isLookup(params) {
  return params.has('location') || params.has('lat') || params.has('lon');
}

// A coordinate from the query string, or NaN when it is missing, empty or not a number.
function coordinate(value) {
  return value === null || value.trim() === '' ? NaN : Number(value);
}

// Validate the query string. Returns { args } (location filled in), { args, point }
// (location still to be found from the point) or { error }.
export function parseQuery(params) {
  var fuel = (params.get('fuel') || 'E10').toUpperCase();
  if (FUELS.indexOf(fuel) === -1) return { error: 'Unknown fuel type.' };
  var radius = params.has('radius') ? Number(params.get('radius')) : DEFAULT_RADIUS;
  if (!(radius > 0 && radius <= 25)) return { error: 'Radius must be between 0 and 25 miles.' };
  var args = { location: '', fuel: fuel, radius_miles: radius, limit: LIMIT };

  if (params.has('lat') || params.has('lon')) {
    // Number() reads a missing or empty value as 0, and 0° east runs through London.
    var lat = coordinate(params.get('lat')), lon = coordinate(params.get('lon'));
    if (isNaN(lat) || isNaN(lon)) return { error: 'A point needs both lat and lon.' };
    // Rough bounding box of the UK, so obviously wrong points fail fast.
    if (!(lat >= 49 && lat <= 61.5 && lon >= -9 && lon <= 2.5)) return { error: 'That point is outside the UK.' };
    return { args: args, point: { lat: lat, lon: lon } };
  }
  var location = (params.get('location') || '').trim();
  if (!location) return { error: 'Enter a UK postcode or place.' };
  if (location.length > MAX_LOCATION_CHARS) return { error: 'That location is too long.' };
  args.location = location;
  return { args: args };
}

// The nearest postcode to a point, or null when there is none within 2 km.
export async function nearestPostcode(point, doFetch) {
  var url = POSTCODES_URL + '?lon=' + point.lon + '&lat=' + point.lat + '&radius=' + NEAREST_POSTCODE_METRES + '&limit=1';
  var r = await doFetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('postcodes.io HTTP ' + r.status);
  var d = await r.json();
  return d && d.result && d.result[0] ? d.result[0].postcode : null;
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
  if (!isLookup(params)) return json({ enabled: true, configured: missing.length === 0 });
  if (missing.length) return json({ error: 'Fuel prices are not configured (missing ' + missing.join(', ') + ').' }, 503);

  var ip = request.headers.get('cf-connecting-ip') || 'local';
  if (rateLimited(ip, Date.now())) return json({ error: 'Too many lookups. Try again in a minute.' }, 429);

  var parsed = parseQuery(params);
  if (parsed.error) return json({ error: parsed.error }, 400);

  var doFetch = (deps && deps.fetch) || fetch;
  if (parsed.point) {
    try {
      parsed.args.location = await nearestPostcode(parsed.point, doFetch);
    } catch (error) {
      console.error('Nearest postcode lookup failed', error && error.message);
      return json({ error: 'Couldn’t look up that point. Try a postcode instead.' }, 502);
    }
    if (!parsed.args.location) return json({ error: 'There’s no UK postcode near that point.' }, 400);
  }

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
