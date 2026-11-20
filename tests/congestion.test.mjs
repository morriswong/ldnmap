// Tests for congestion.js against the real data/ccz.geojson and data/bank-holidays.json.
// Run with: npm test. congestion.js is a plain browser script that leans on parking-rules.js
// (londonDate, londonDayTime), so both run in one VM context, in the page's order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const ctx = { Intl };
vm.createContext(ctx);
for (const f of ['parking-rules.js', 'congestion.js']) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), ctx, { filename: f });
const zone = JSON.parse(readFileSync(new URL('data/ccz.geojson', root), 'utf8'));
const holidays = JSON.parse(readFileSync(new URL('data/bank-holidays.json', root), 'utf8'));
ctx.ccSetZone(zone);
ctx.ccSetBankHolidays(holidays.dates);
const { ccInZone, ccStatusAt, ccChargeForTrip, ccFreeAlternative, ccStatusText, ccLondonTime,
  ccChristmasBreak, ccChargingHours, CCZ_PRICES } = ctx;

const Z = (s) => new Date(s);                              // an instant, written in UTC
const iso = (d) => d.toISOString().replace('.000', '');
const plus = (d, min) => new Date(d.getTime() + min * 60000);

// --- The zone ------------------------------------------------------------------------------

test('zone: central places are in, the ring around it is out', () => {
  const inside = { 'Trafalgar Square': [-0.1281, 51.5080], 'Covent Garden': [-0.1240, 51.5117],
    'Bank': [-0.0886, 51.5133], 'Mayfair, east of Park Lane': [-0.1510, 51.5080],
    'Waterloo station': [-0.1132, 51.5031], 'Tower of London': [-0.0761, 51.5081] };
  const outside = { 'Camden Town': [-0.1426, 51.5392], 'Vauxhall': [-0.1233, 51.4861],
    'Shoreditch High Street station': [-0.0752, 51.5233], 'Hyde Park, west of Park Lane': [-0.1600, 51.5080],
    'King’s Cross station': [-0.1238, 51.5308], 'Euston': [-0.1337, 51.5282], 'Brixton': [-0.1145, 51.4613] };
  for (const [name, [lng, lat]] of Object.entries(inside)) assert.equal(ccInZone(lng, lat), true, name);
  for (const [name, [lng, lat]] of Object.entries(outside)) assert.equal(ccInZone(lng, lat), false, name);
});

test('zone: the western edge is Park Lane, south of Marble Arch', () => {
  // Along Park Lane (about -0.1530 at Grosvenor House) the zone starts just east of the road.
  assert.equal(ccInZone(-0.1530 + 0.0015, 51.5085), true);
  assert.equal(ccInZone(-0.1530 - 0.0025, 51.5085), false);
});

test('zone: the data file is small, one feature, WGS84 rings that close, anticlockwise outers', () => {
  const raw = readFileSync(new URL('data/ccz.geojson', root), 'utf8');
  assert.ok(raw.length < 20000, raw.length + ' bytes');
  assert.equal(zone.features.length, 1);
  const g = zone.features[0].geometry;
  assert.equal(g.type, 'MultiPolygon');
  for (const poly of g.coordinates) {
    const ring = poly[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    assert.ok(a > 0, 'outer ring is anticlockwise (RFC 7946)');
    for (const [lng, lat] of ring) assert.ok(lng > -0.2 && lng < -0.05 && lat > 51.48 && lat < 51.54);
  }
});

test('zone: a boundary passed in wins; with none set the answer is null, not a guess', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  assert.equal(ccInZone(0.5, 0.5, square), true);
  assert.equal(ccInZone(-0.1281, 51.5080, square), false);
  const c2 = { Intl };
  vm.createContext(c2);
  for (const f of ['parking-rules.js', 'congestion.js']) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), c2);
  assert.equal(c2.ccInZone(-0.1281, 51.5080), null);
});

test('zone: a hole in a polygon is outside', () => {
  const donut = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [
    [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]] } };
  assert.equal(ccInZone(0.5, 0.5, donut), true);
  assert.equal(ccInZone(2, 2, donut), false);
});

// --- Calendar ------------------------------------------------------------------------------

test('London times: the clocks going forward and back', () => {
  assert.equal(iso(ccLondonTime('2026-03-28', 12 * 60)), '2026-03-28T12:00:00Z');   // GMT
  assert.equal(iso(ccLondonTime('2026-03-29', 12 * 60)), '2026-03-29T11:00:00Z');   // BST from 01:00 UTC
  assert.equal(iso(ccLondonTime('2026-10-24', 18 * 60)), '2026-10-24T17:00:00Z');   // still BST
  assert.equal(iso(ccLondonTime('2026-10-25', 12 * 60)), '2026-10-25T12:00:00Z');   // GMT again
  assert.equal(iso(ccLondonTime('2026-11-20', 24 * 60)), '2026-11-21T00:00:00Z');   // past midnight
});

test('Christmas break: Christmas Day to the New Year’s Day bank holiday, inclusive', () => {
  assert.equal(ccChristmasBreak('2026-12-24'), false);
  assert.equal(ccChristmasBreak('2026-12-25'), true);
  assert.equal(ccChristmasBreak('2026-12-31'), true);
  assert.equal(ccChristmasBreak('2027-01-01'), true);     // a Friday: the holiday itself
  assert.equal(ccChristmasBreak('2027-01-02'), false);
  // 1 Jan 2028 is a Saturday, so the bank holiday is Monday 3 Jan.
  assert.equal(ccChristmasBreak('2028-01-01'), true);
  assert.equal(ccChristmasBreak('2028-01-03'), true);
  assert.equal(ccChristmasBreak('2028-01-04'), false);
  // 1 Jan 2034 is a Sunday: Monday 2 Jan, worked out without the list.
  assert.equal(ccChristmasBreak('2034-01-02'), true);
  assert.equal(ccChristmasBreak('2034-01-03'), false);
});

test('charging hours: weekdays 7am–6pm, weekends and bank holidays 12pm–6pm, none at Christmas', () => {
  const h = (d) => { const x = ccChargingHours(d); return x && [x.start, x.end]; };
  assert.deepEqual(h('2026-11-20'), [420, 1080]);          // Friday
  assert.deepEqual(h('2026-11-21'), [720, 1080]);          // Saturday
  assert.deepEqual(h('2026-11-22'), [720, 1080]);          // Sunday
  assert.deepEqual(h('2026-08-31'), [720, 1080]);          // summer bank holiday (Monday)
  assert.deepEqual(h('2026-04-03'), [720, 1080]);          // Good Friday
  assert.deepEqual(h('2026-12-24'), [420, 1080]);
  assert.equal(h('2026-12-25'), null);
});

test('bank holidays: data/bank-holidays.json matches the parking list', () => {
  const rules = JSON.parse(readFileSync(new URL('data/parking/rules.json', root), 'utf8'));
  assert.deepEqual(holidays.dates, rules.bankHolidays);
});

test('bank holidays: without its own list it uses the parking layer’s once that has loaded', () => {
  const c2 = { Intl };
  vm.createContext(c2);
  for (const f of ['parking-rules.js', 'congestion.js']) vm.runInContext(readFileSync(new URL(f, root), 'utf8'), c2);
  const at10 = Z('2026-08-31T09:00:00Z');                   // 10am BST, summer bank holiday
  assert.equal(c2.ccStatusAt(at10).charging, true, 'no list: an ordinary Monday');
  c2.setParkingRules({ bankHolidays: ['2026-08-31'], boroughs: {}, rules: {} });
  assert.equal(c2.ccStatusAt(at10).charging, false);
});

// --- Status --------------------------------------------------------------------------------

test('status: weekday edges (GMT)', () => {
  const s = (t) => { const x = ccStatusAt(Z(t)); return [x.charging, x.until && iso(x.until), x.next && iso(x.next)]; };
  assert.deepEqual(s('2026-11-20T06:59:00Z'), [false, null, '2026-11-20T07:00:00Z']);
  assert.deepEqual(s('2026-11-20T07:00:00Z'), [true, '2026-11-20T18:00:00Z', '2026-11-21T12:00:00Z']);
  assert.deepEqual(s('2026-11-20T17:59:59Z'), [true, '2026-11-20T18:00:00Z', '2026-11-21T12:00:00Z']);
  assert.deepEqual(s('2026-11-20T18:00:00Z'), [false, null, '2026-11-21T12:00:00Z']);
});

test('status: weekend edges', () => {
  const s = (t) => { const x = ccStatusAt(Z(t)); return [x.charging, x.until && iso(x.until), x.next && iso(x.next)]; };
  assert.deepEqual(s('2026-11-21T11:59:00Z'), [false, null, '2026-11-21T12:00:00Z']);
  assert.deepEqual(s('2026-11-21T12:00:00Z'), [true, '2026-11-21T18:00:00Z', '2026-11-22T12:00:00Z']);
  assert.deepEqual(s('2026-11-22T17:00:00Z'), [true, '2026-11-22T18:00:00Z', '2026-11-23T07:00:00Z']);
  assert.deepEqual(s('2026-11-22T18:30:00Z'), [false, null, '2026-11-23T07:00:00Z']);
});

test('status: bank holiday Monday keeps weekend hours (BST)', () => {
  const s = ccStatusAt(Z('2026-08-31T09:00:00Z'));          // 10am BST
  assert.equal(s.charging, false);
  assert.equal(iso(s.next), '2026-08-31T11:00:00Z');        // 12pm BST
  assert.equal(ccStatusAt(Z('2026-08-31T11:00:00Z')).charging, true);
  assert.equal(iso(ccStatusAt(Z('2026-08-31T11:00:00Z')).next), '2026-09-01T06:00:00Z');   // Tue 7am BST
});

test('status: clocks change over a weekend', () => {
  // Saturday evening in GMT; charging starts at Sunday noon, which is BST.
  assert.equal(iso(ccStatusAt(Z('2026-03-28T20:00:00Z')).next), '2026-03-29T11:00:00Z');
  assert.equal(ccStatusAt(Z('2026-03-29T10:59:00Z')).charging, false);
  assert.equal(ccStatusAt(Z('2026-03-29T11:00:00Z')).charging, true);
  assert.equal(iso(ccStatusAt(Z('2026-03-29T11:00:00Z')).until), '2026-03-29T17:00:00Z');
  // Back to GMT: Saturday 6pm BST is 17:00 UTC, Sunday noon is 12:00 UTC.
  assert.equal(ccStatusAt(Z('2026-10-24T16:59:00Z')).charging, true);
  assert.equal(ccStatusAt(Z('2026-10-24T17:00:00Z')).charging, false);
  assert.equal(iso(ccStatusAt(Z('2026-10-24T17:00:00Z')).next), '2026-10-25T12:00:00Z');
  assert.equal(ccStatusAt(Z('2026-10-25T11:30:00Z')).charging, false);
  assert.equal(ccStatusAt(Z('2026-10-25T12:00:00Z')).charging, true);
});

test('status: across Christmas, charging next starts after the New Year’s Day bank holiday', () => {
  const eve = ccStatusAt(Z('2026-12-24T17:59:00Z'));
  assert.equal(eve.charging, true);
  assert.equal(iso(eve.next), '2027-01-02T12:00:00Z');      // Saturday 2 Jan, weekend hours
  const day = ccStatusAt(Z('2026-12-25T10:00:00Z'));
  assert.deepEqual([day.charging, day.until, iso(day.next)], [false, null, '2027-01-02T12:00:00Z']);
  assert.equal(ccStatusAt(Z('2027-01-01T10:00:00Z')).charging, false);
  assert.equal(iso(ccStatusAt(Z('2027-12-31T12:00:00Z')).next), '2028-01-04T07:00:00Z');   // after Mon 3 Jan
});

test('status text for the map chip', () => {
  assert.equal(ccStatusText(Z('2026-11-20T15:00:00Z')), 'Charging now · until 6pm');
  assert.equal(ccStatusText(Z('2026-11-20T05:00:00Z')), 'Free now · starts 7am');
  assert.equal(ccStatusText(Z('2026-11-20T19:00:00Z')), 'Free now · starts 12pm tomorrow');
  assert.equal(ccStatusText(Z('2026-11-21T09:00:00Z')), 'Free now · starts 12pm');
  assert.equal(ccStatusText(Z('2026-11-22T19:00:00Z')), 'Free now · starts 7am tomorrow');
  assert.equal(ccStatusText(Z('2026-12-31T12:00:00Z')), 'Free now · starts 12pm Sat');
  assert.equal(ccStatusText(Z('2026-12-24T19:00:00Z')), 'Free now · starts 12pm Sat 2 Jan');
});

// --- Trips ---------------------------------------------------------------------------------

test('trip: arriving or leaving in charging hours is one charge for that day', () => {
  const t = (a, l) => { const r = ccChargeForTrip(Z(a), Z(l)); return [r.charged, r.days, r.amount, r.reason]; };
  assert.deepEqual(t('2026-11-20T09:00:00Z', '2026-11-20T11:00:00Z'), [true, 1, 18, 'Arriving and leaving in charging hours']);
  assert.deepEqual(t('2026-11-20T06:00:00Z', '2026-11-20T09:00:00Z'), [true, 1, 18, 'Leaving in charging hours']);
  assert.deepEqual(t('2026-11-20T17:00:00Z', '2026-11-20T20:00:00Z'), [true, 1, 18, 'Arriving in charging hours']);
  assert.deepEqual(t('2026-11-20T06:00:00Z', '2026-11-20T19:00:00Z'), [false, 0, 0, 'Arriving and leaving outside charging hours']);
  assert.deepEqual(t('2026-11-20T18:00:00Z', '2026-11-20T21:00:00Z'), [false, 0, 0, 'Arriving and leaving outside charging hours']);
  assert.deepEqual(t('2026-11-21T10:00:00Z', '2026-11-21T11:59:00Z'), [false, 0, 0, 'Arriving and leaving outside charging hours']);
});

test('trip: across midnight, a day each end, or none', () => {
  const r = ccChargeForTrip(Z('2026-11-20T17:00:00Z'), Z('2026-11-21T13:00:00Z'));   // Fri 5pm → Sat 1pm
  assert.deepEqual([r.charged, r.days, [...r.dates], r.amount, r.late], [true, 2, ['2026-11-20', '2026-11-21'], 36, 42]);
  assert.equal(r.reason, 'Arriving and leaving in charging hours, on different days');
  assert.equal(ccChargeForTrip(Z('2026-11-20T22:00:00Z'), Z('2026-11-21T09:00:00Z')).charged, false);
  const weekend = ccChargeForTrip(Z('2026-11-20T17:30:00Z'), Z('2026-11-23T06:00:00Z'));   // parked Fri → Mon
  assert.deepEqual([weekend.days, [...weekend.dates]], [1, ['2026-11-20']]);
});

test('trip: prices, standard and electric on Auto Pay', () => {
  assert.equal(CCZ_PRICES.standard.daily, 18);
  assert.equal(CCZ_PRICES.standard.late, 21);
  assert.equal(CCZ_PRICES.ev.daily, 13.5);
  const r = ccChargeForTrip(Z('2026-11-20T17:00:00Z'), Z('2026-11-21T13:00:00Z'), 'ev');
  assert.deepEqual([r.amount, r.late], [27, null]);
  assert.equal(ccChargeForTrip(Z('2026-11-20T09:00:00Z'), Z('2026-11-20T10:00:00Z'), 'nonsense').amount, 18);
});

test('trip: Christmas Eve is charged, Christmas to New Year isn’t', () => {
  assert.equal(ccChargeForTrip(Z('2026-12-24T10:00:00Z'), Z('2026-12-24T12:00:00Z')).charged, true);
  assert.equal(ccChargeForTrip(Z('2026-12-25T10:00:00Z'), Z('2027-01-01T15:00:00Z')).charged, false);
  const r = ccChargeForTrip(Z('2026-12-24T17:00:00Z'), Z('2027-01-02T13:00:00Z'));
  assert.deepEqual([...r.dates], ['2026-12-24', '2027-01-02']);
});

test('trip: the hour the clocks change is still London time', () => {
  // Sunday 29 Mar 2026: 11:30 UTC is 12:30 BST, charged; 10:30 UTC is 11:30 BST, free.
  assert.equal(ccChargeForTrip(Z('2026-03-29T08:00:00Z'), Z('2026-03-29T10:30:00Z')).charged, false);
  assert.equal(ccChargeForTrip(Z('2026-03-29T08:00:00Z'), Z('2026-03-29T11:30:00Z')).charged, true);
  // Sunday 25 Oct 2026: 11:30 UTC is 11:30 GMT, free.
  assert.equal(ccChargeForTrip(Z('2026-10-25T08:00:00Z'), Z('2026-10-25T11:30:00Z')).charged, false);
});

// --- Free alternatives ---------------------------------------------------------------------

const alt = (a, stay, opts) => {
  const r = ccFreeAlternative(Z(a), stay, opts);
  return r && [iso(r.arrival), iso(r.leave), r.shiftMin, r.label];
};

test('free alternative: already free, nothing to suggest', () => {
  assert.equal(alt('2026-11-20T20:00:00Z', 60), null);
  assert.equal(alt('2026-11-21T09:00:00Z', 120), null);
});

test('free alternative: late afternoon → arrive after 6pm', () => {
  assert.deepEqual(alt('2026-11-20T16:00:00Z', 180),
    ['2026-11-20T18:00:00Z', '2026-11-20T21:00:00Z', 120, 'Arrive after 6pm']);
});

test('free alternative: just after 7am → a little earlier, leave before 7am', () => {
  assert.deepEqual(alt('2026-11-20T08:00:00Z', 60),
    ['2026-11-20T05:55:00Z', '2026-11-20T06:55:00Z', -125, 'Leave before 7am']);
});

test('free alternative: never in the past', () => {
  assert.deepEqual(alt('2026-11-20T08:00:00Z', 60, { now: Z('2026-11-20T07:30:00Z') }),
    ['2026-11-20T18:00:00Z', '2026-11-20T19:00:00Z', 600, 'Arrive after 6pm']);
});

test('free alternative: weekends shift around noon', () => {
  assert.deepEqual(alt('2026-11-21T12:30:00Z', 60),
    ['2026-11-21T10:55:00Z', '2026-11-21T11:55:00Z', -95, 'Leave before 12pm']);
  // Three hours earlier is the limit, so a 2h stay from 1pm waits for the evening.
  assert.deepEqual(alt('2026-11-21T13:00:00Z', 120),
    ['2026-11-21T18:00:00Z', '2026-11-21T20:00:00Z', 300, 'Arrive after 6pm']);
});

test('free alternative: a long stay can mean leaving after 6pm the next day', () => {
  // Fri 10am for 20h ends Sat 6am; arriving Fri 10pm and leaving Sat 6pm is free.
  assert.deepEqual(alt('2026-11-20T10:00:00Z', 20 * 60),
    ['2026-11-20T22:00:00Z', '2026-11-21T18:00:00Z', 720, 'Leave after 6pm tomorrow']);
});

test('free alternative: none when no nearby shift works', () => {
  // Mon 10am for 14h: arriving later still means leaving in Tuesday's charging hours.
  assert.equal(alt('2026-11-23T10:00:00Z', 14 * 60), null);
});

test('free alternative: in summer time, and on Christmas Eve', () => {
  assert.deepEqual(alt('2026-07-15T15:00:00Z', 60),           // 4pm BST
    ['2026-07-15T17:00:00Z', '2026-07-15T18:00:00Z', 120, 'Arrive after 6pm']);
  // Christmas Eve 5pm for 10h: arriving at 6pm is free, and so is leaving on Christmas Day.
  assert.deepEqual(alt('2026-12-24T17:00:00Z', 600),
    ['2026-12-24T18:00:00Z', '2026-12-25T04:00:00Z', 60, 'Arrive after 6pm']);
});

test('helpers keep their Date results usable across the module', () => {
  const r = ccFreeAlternative(Z('2026-11-20T16:00:00Z'), 30);
  assert.equal(ccChargeForTrip(r.arrival, plus(r.arrival, 30)).charged, false);
});
