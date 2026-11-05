// Tests for functions/api/chat.js. Run with: npm test
// Uses the real Anthropic SDK with a fake fetch, so no network or API key is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, onRequestGet, cleanMessages } from '../functions/api/chat.js';

const ENV = {
  CHAT_ENABLED: 'true',
  ANTHROPIC_API_KEY: 'test-key',
  FUEL_MCP_URL: 'https://example.test/mcp',
  FUEL_MCP_TOKEN: 'fmcp_test'
};

let ipCounter = 0;
function post(body, ip) {
  return new Request('https://ldnmap.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || ('10.0.0.' + (++ipCounter)) },
    body: JSON.stringify(body)
  });
}

const CHEAPEST = {
  location: { query: 'SW1A 1AA', label: 'SW1A 1AA', latitude: 51.501, longitude: -0.1416 },
  fuel: 'E10', radius_miles: 5, data_fetched_at: '2026-11-05T13:00:00Z',
  stations: [{ node_id: 'a1', name: 'Test Fuel', brand: 'TESTCO', address: '1 Road', postcode: 'SW1A 2AA',
    latitude: 51.5, longitude: -0.14, distance_miles: 0.4, fuel: 'E10', price_ppl: 132.9,
    price_updated: '2026-11-05T09:00:00Z' }]
};

function claudeResponse(stopReason, content) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    stop_reason: stopReason, stop_sequence: null, content: content,
    usage: { input_tokens: 10, output_tokens: 10 }
  };
}

const TOOL_TURN = [
  { type: 'thinking', thinking: '', signature: 'sig' },
  { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'cheapest_fuel_near', server_name: 'uk-fuel', input: { location: 'SW1A 1AA' } },
  { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', is_error: false, content: [{ type: 'text', text: JSON.stringify(CHEAPEST) }] },
  { type: 'mcp_tool_use', id: 'mcptoolu_2', name: 'area_summary', server_name: 'uk-fuel', input: { location: 'nowhere' } },
  { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_2', is_error: true, content: [{ type: 'text', text: 'Unknown location' }] },
  { type: 'text', text: 'Cheapest E10 is Test Fuel at 132.9p.' }
];

// Fake fetch that records requests and replays canned Claude responses in order.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  };
  fn.calls = calls;
  return fn;
}

test('404 when CHAT_ENABLED is not "true"', async () => {
  const res = await handleChat(post({ messages: [{ role: 'user', content: 'hi' }] }), { ...ENV, CHAT_ENABLED: undefined });
  assert.equal(res.status, 404);
  const get = await onRequestGet({ env: {} });
  assert.equal(get.status, 404);
});

test('503 with the missing names when unconfigured', async () => {
  const res = await handleChat(post({ messages: [{ role: 'user', content: 'hi' }] }), { CHAT_ENABLED: 'true' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /ANTHROPIC_API_KEY, FUEL_MCP_URL, FUEL_MCP_TOKEN/);
  const get = await onRequestGet({ env: { CHAT_ENABLED: 'true' } });
  assert.deepEqual(await get.json(), { enabled: true, configured: false });
});

test('429 after 10 requests a minute from one IP', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    // Invalid bodies return 400 after the rate check, so no Claude call is made.
    const res = await handleChat(post({ messages: [] }, '192.0.2.1'), ENV);
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

test('rejects bad histories and over-long questions', () => {
  assert.equal(cleanMessages('nope'), null);
  assert.equal(cleanMessages([{ role: 'assistant', content: 'hi' }]), null);
  assert.equal(cleanMessages([{ role: 'system', content: 'x' }]), null);
  assert.equal(cleanMessages([{ role: 'user', content: 'x'.repeat(501) }]), null);
  const long = [];
  for (let i = 0; i < 30; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i });
  const cleaned = cleanMessages(long.concat([{ role: 'user', content: 'last' }]));
  assert.ok(cleaned.length <= 10);
  assert.equal(cleaned[0].role, 'user');
  assert.deepEqual(cleaned.at(-1), { role: 'user', content: 'last' });
  // Consecutive same-role turns are merged rather than rejected.
  assert.deepEqual(cleanMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]), [{ role: 'user', content: 'a\nb' }]);
});

test('sends the MCP connector request and extracts successful tool results', async () => {
  const fetch = fakeFetch([claudeResponse('end_turn', TOOL_TURN)]);
  const res = await handleChat(post({ messages: [{ role: 'user', content: 'Cheapest petrol near SW1A 1AA?' }] }), ENV, { fetch });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, 'Cheapest E10 is Test Fuel at 132.9p.');
  assert.deepEqual(body.results, [{ tool: 'cheapest_fuel_near', data: CHEAPEST }]); // is_error result skipped

  const call = fetch.calls[0];
  assert.match(call.url, /\/v1\/messages$/);
  assert.equal(call.headers.get('anthropic-beta'), 'mcp-client-2025-11-20,server-side-fallback-2026-07-01');
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.deepEqual(call.body.output_config, { effort: 'low' });
  assert.deepEqual(call.body.mcp_servers, [{ type: 'url', url: ENV.FUEL_MCP_URL, name: 'uk-fuel', authorization_token: 'fmcp_test' }]);
  assert.deepEqual(call.body.tools, [{ type: 'mcp_toolset', mcp_server_name: 'uk-fuel' }]);
  assert.equal(call.body.betas, undefined); // betas travel as a header, not in the body
});

test('continues a paused turn by passing the partial content back', async () => {
  const first = TOOL_TURN.slice(0, 3);
  const fetch = fakeFetch([claudeResponse('pause_turn', first), claudeResponse('end_turn', [{ type: 'text', text: 'Done.' }])]);
  const res = await handleChat(post({ messages: [{ role: 'user', content: 'diesel near E8?' }] }), ENV, { fetch });
  const body = await res.json();
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1].body.messages.at(-1), { role: 'assistant', content: first });
  assert.equal(body.reply, 'Done.');
  assert.equal(body.results.length, 1);
});

test('refusal returns a polite reply and no results', async () => {
  const fetch = fakeFetch([claudeResponse('refusal', [])]);
  const res = await handleChat(post({ messages: [{ role: 'user', content: 'x' }] }), ENV, { fetch });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.results, []);
  assert.match(body.reply, /can’t help/);
});
