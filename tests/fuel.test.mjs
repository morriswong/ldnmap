// Tests for functions/api/fuel.js. Run with: npm test
// Uses a fake fetch, so no network or server key is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFuel, parseQuery, parseRpcBody } from '../functions/api/fuel.js';

const ENV = { FUEL_ENABLED: 'true', FUEL_MCP_URL: 'https://example.test/mcp', FUEL_MCP_TOKEN: 'key_test' };

let ipCounter = 0;
function get(query, ip) {
  return new Request('https://ldnmap.test/api/fuel' + query, {
    headers: { 'cf-connecting-ip': ip || ('10.0.0.' + (++ipCounter)) }
  });
}

const CHEAPEST = {
  location: { query: 'E8 4QN', label: 'E8 4QN', latitude: 51.5355, longitude: -0.0602 },
  fuel: 'E10', radius_miles: 5, data_fetched_at: '2026-11-05T13:00:00Z', warning: null,
  stations: [{ node_id: 'a1', name: 'Test Fuel', brand: 'TESTCO', address: '1 Road', postcode: 'E8 1AA',
    latitude: 51.54, longitude: -0.06, distance_miles: 0.4, fuel: 'E10', price_ppl: 132.9,
    price_updated: '2026-11-05T09:00:00Z' }]
};

function sse(result) {
  return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result }) + '\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const ok = async () => sse({ content: [{ type: 'text', text: JSON.stringify(CHEAPEST) }] });

test('404 unless enabled; probe reports configuration', async () => {
  assert.equal((await handleFuel(get(''), {})).status, 404);
  assert.deepEqual(await (await handleFuel(get(''), ENV)).json(), { enabled: true, configured: true });
  assert.deepEqual(await (await handleFuel(get(''), { FUEL_ENABLED: 'true' })).json(), { enabled: true, configured: false });
});

test('validates the query', () => {
  assert.ok(parseQuery(new URLSearchParams('location=')).error);
  assert.ok(parseQuery(new URLSearchParams('location=' + 'x'.repeat(61))).error);
  assert.ok(parseQuery(new URLSearchParams('location=E8&fuel=kerosene')).error);
  assert.ok(parseQuery(new URLSearchParams('location=E8&radius=99')).error);
  assert.deepEqual(parseQuery(new URLSearchParams('location=%20E8%204QN%20&fuel=b7_standard')).args,
    { location: 'E8 4QN', fuel: 'B7_STANDARD', radius_miles: 5, limit: 10 });
});

test('parses JSON and SSE replies', () => {
  assert.deepEqual(parseRpcBody('{"id":1}'), { id: 1 });
  assert.deepEqual(parseRpcBody('event: message\ndata: {"id":2}\n\n'), { id: 2 });
});

test('calls cheapest_fuel_near with the server key and returns its data', async () => {
  let call;
  const fetch = async (url, init) => { call = { url, init, body: JSON.parse(init.body) }; return ok(); };
  const r = await handleFuel(get('?location=E8%204QN&fuel=E10'), ENV, { fetch });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), CHEAPEST);
  assert.equal(call.url, ENV.FUEL_MCP_URL);
  assert.equal(call.init.headers.authorization, 'Bearer key_test');
  assert.equal(call.body.method, 'tools/call');
  assert.deepEqual(call.body.params,
    { name: 'cheapest_fuel_near', arguments: { location: 'E8 4QN', fuel: 'E10', radius_miles: 5, limit: 10 } });
});

test('passes tool errors through and hides server failures', async () => {
  const toolError = async () => sse({ isError: true, content: [{ type: 'text', text: 'Postcode ZZ1 1ZZ was not found.' }] });
  let r = await handleFuel(get('?location=ZZ1%201ZZ'), ENV, { fetch: toolError });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'Postcode ZZ1 1ZZ was not found.');

  r = await handleFuel(get('?location=E8'), ENV, { fetch: async () => new Response('Unauthorized', { status: 401 }) });
  assert.equal(r.status, 502);
  assert.doesNotMatch((await r.json()).error, /key_test/);

  r = await handleFuel(get('?location=E8'), ENV, { fetch: async () => { throw new TypeError('network'); } });
  assert.equal(r.status, 502);
});

test('rate limits bursts per IP', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await handleFuel(get('?location=E8', '10.9.9.9'), ENV, { fetch: ok });
  assert.equal(last.status, 429);
});

test('validates points', () => {
  assert.ok(parseQuery(new URLSearchParams('lat=48.8&lon=2.35')).error);       // Paris
  assert.ok(parseQuery(new URLSearchParams('lat=abc&lon=0')).error);
  // Half a point is an error, not a point on the Greenwich meridian or the equator.
  assert.match(parseQuery(new URLSearchParams('lat=51.5')).error, /both lat and lon/);
  assert.match(parseQuery(new URLSearchParams('lon=-0.14')).error, /both lat and lon/);
  assert.match(parseQuery(new URLSearchParams('lat=51.5&lon=')).error, /both lat and lon/);
  assert.match(parseQuery(new URLSearchParams('lat=%20&lon=-0.14')).error, /both lat and lon/);
  assert.deepEqual(parseQuery(new URLSearchParams('lat=51.5&lon=0')).point, { lat: 51.5, lon: 0 });
  assert.deepEqual(parseQuery(new URLSearchParams('lat=51.5&lon=-0.14')).point, { lat: 51.5, lon: -0.14 });
});

test('a point is looked up as its nearest postcode', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://api.postcodes.io/')) {
      return new Response(JSON.stringify({ status: 200, result: [{ postcode: 'SW1A 1AA' }] }), { status: 200 });
    }
    return ok();
  };
  const r = await handleFuel(get('?lat=51.501&lon=-0.1416&fuel=E10'), ENV, { fetch });
  assert.equal(r.status, 200);
  assert.match(calls[0], /lon=-0\.1416&lat=51\.501&radius=2000&limit=1/);
  assert.equal(calls[1], ENV.FUEL_MCP_URL);
});

test('half a point never reaches postcodes.io or the fuel server', async () => {
  let calls = 0;
  const r = await handleFuel(get('?lat=51.5&fuel=E10'), ENV, { fetch: async () => { calls++; return ok(); } });
  assert.equal(r.status, 400);
  assert.equal(calls, 0);
});

test('a point with no postcode nearby is a clear error', async () => {
  const fetch = async () => new Response(JSON.stringify({ status: 200, result: null }), { status: 200 });
  const r = await handleFuel(get('?lat=50&lon=-5'), ENV, { fetch });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no UK postcode near/);
});
