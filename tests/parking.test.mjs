// Tests for parking-rules.js against the real data/parking/rules.json. Run with: npm test
// parking-rules.js is a plain browser script, so it runs in a VM context here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const ctx = { Intl };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('parking-rules.js', root), 'utf8'), ctx);
const rules = JSON.parse(readFileSync(new URL('data/parking/rules.json', root), 'utf8'));
ctx.setParkingRules(rules);
const { isControlled, londonDayTime, parkingCost, nextChange, bankHolidayOn, londonDate } = ctx;

const SUN = 0, SAT = 6;
const at = (h, m = 0) => h * 60 + m;

test('H&F zone E: Sunday 10:00 is controlled, 23:00 is free', () => {
  assert.equal(isControlled('hf:E', SUN, at(10), false), 'ctrl');
  assert.equal(isControlled('hf:E', SUN, at(23), false), 'free');
});

test('H&F zone H (extended 11 Nov 2026): controlled Mon–Sun 8:30am–10pm', () => {
  assert.equal(isControlled('hf:H', SAT, at(10), false), 'ctrl');
  assert.equal(isControlled('hf:H', SUN, at(21, 59), false), 'ctrl');
  assert.equal(isControlled('hf:H', SUN, at(22), false), 'free');
  assert.equal(isControlled('hf:H', SAT, at(8, 29), false), 'free');
  assert.equal(isControlled('hf:H-long', SUN, at(12), false), 'ctrl');
});

test('H&F zone R roads extended 18 Nov 2026 (hf:R-ext): Sunday 12:00 is controlled, rest of R free', () => {
  assert.equal(isControlled('hf:R-ext', SUN, at(12), false), 'ctrl');
  assert.equal(isControlled('hf:R', SUN, at(12), false), 'free');
});

test('H&F zone T: Sunday 15:00 is free normally and controlled on an event day', () => {
  assert.equal(isControlled('hf:T', SUN, at(15), false), 'free');
  assert.equal(isControlled('hf:T', SUN, at(15), true), 'ctrl');
});

test('H&F zone G: 19:00 is permit holders only every day', () => {
  for (let day = 0; day < 7; day++) assert.equal(isControlled('hf:G', day, at(19), false), 'permit');
});

test('Richford Street (hf:K-Richford): Sunday 19:00 is controlled', () => {
  assert.equal(isControlled('hf:K-Richford', SUN, at(19), false), 'ctrl');
  assert.equal(isControlled('hf:K', SUN, at(19), false), 'free');
});

test('an event-day-only zone (Hounslow R) is free on other days', () => {
  assert.equal(isControlled('hounslow:R', SAT, at(15), false), 'free');
  assert.equal(isControlled('hounslow:R', SAT, at(15), true), 'ctrl');
});

test('from is inclusive, to is exclusive', () => {
  assert.equal(isControlled('hf:E', SUN, at(8, 29), false), 'free');
  assert.equal(isControlled('hf:E', SUN, at(8, 30), false), 'ctrl');
  assert.equal(isControlled('hf:E', SUN, at(22, 59), false), 'ctrl');
  assert.equal(isControlled('hf:G', SUN, at(18, 30), false), 'permit');
  assert.equal(isControlled('hf:G', SUN, at(20), false), 'ctrl');
});

test('permit-only zones and streets', () => {
  assert.equal(isControlled('hf:QQ', SAT, at(10), false), 'permit');
  assert.equal(isControlled('hf:QQ', SUN, at(10), false), 'free');
  assert.equal(isControlled('hf:VV', SAT, at(10), false), 'free');
  assert.equal(isControlled('hf:G-permit', SUN, at(10), false), 'permit');
  assert.equal(isControlled('hf:G-permit', SUN, at(22), false), 'free');
});

test('missing rules and rules without readable hours are unknown, never free', () => {
  assert.equal(isControlled('nope:Z', SUN, at(10), false), 'unknown');
  ctx.setParkingRules({ rules: { 'x:A': { hours: 'See signs', periods: null } } });
  assert.equal(isControlled('x:A', SUN, at(10), false), 'unknown');
  ctx.setParkingRules(rules);
});

test('every rule in the data is well formed', () => {
  const keys = Object.keys(rules.rules);
  assert.ok(keys.length > 31, 'expected zones from more than one borough');
  for (const key of keys) {
    const r = rules.rules[key];
    assert.match(key, /^[a-z]+:.+$/, key);
    assert.ok(rules.boroughs[r.borough], key + ' names an unknown borough');
    assert.equal(typeof r.hours, 'string', key + ' has no hours text');
    for (const p of (r.periods || []).concat(r.permit || [], r.unsure || [], r.event ? r.event.periods : [])) {
      assert.ok(p.days.every((d) => d >= 0 && d <= 6), key);
      assert.match(p.from, /^\d\d:\d\d$/, key);
      assert.match(p.to, /^\d\d:\d\d$/, key);
      assert.ok(ctx.hhmmToMinutes(p.from) < ctx.hhmmToMinutes(p.to), key + ' period ends before it starts');
    }
  }
});

test('the map files agree with the rules', () => {
  const zones = JSON.parse(readFileSync(new URL('data/parking/zones.geojson', root), 'utf8')).features;
  const drawn = new Set();
  for (const f of zones) {
    const p = f.properties;
    assert.ok(rules.boroughs[p.b], 'zone in unknown borough ' + p.b);
    if (p.outline) continue;
    assert.ok(rules.rules[p.rule], 'zone without a rule: ' + p.rule);
    assert.ok(isFinite(p.lx) && isFinite(p.ly), p.rule + ' has no label point');
    drawn.add(p.b);
  }
  for (const [id, b] of Object.entries(rules.boroughs)) {
    assert.equal(b.bbox.length, 4, id);
    assert.equal(drawn.has(id), !b.listOnly, id + ': listOnly means no zones are drawn');
    for (const name of ['streets', 'kerb', 'machines']) {
      assert.equal(existsSync(new URL('data/parking/' + id + '/' + name + '.geojson', root)), !!b.detail, id + '/' + name);
    }
  }
});

test('a start time with no am/pm shares the end time’s when that runs forwards', () => {
  // "1 - 2pm" and "2 - 4pm" are afternoon hours, not controls from 1am or 2am.
  const MON = 1;
  for (const key of ['enfield:Bush Hill Park', 'enfield:Oakwood', 'haringey:Bruce Grove West', 'harrow:BG', 'harrow:HA']) {
    assert.equal(isControlled(key, MON, at(9), false), 'free', key + ' at 9am');
    assert.equal(isControlled(key, MON, at(14, 30), false), key === 'enfield:Bush Hill Park' ? 'free' : 'ctrl', key + ' at 2:30pm');
  }
  assert.equal(isControlled('enfield:Bush Hill Park', MON, at(13, 30), false), 'ctrl');
  assert.equal(isControlled('enfield:Enfield College (Part time)', MON, at(11), false), 'ctrl');
  assert.equal(isControlled('enfield:Enfield College (Part time)', MON, at(13), false), 'free');
});

test('unsure periods are unknown, the rest of the week keeps its status', () => {
  ctx.setParkingRules({ rules: { 'x:B': { hours: 'Mon-Sat 9am-7pm', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '09:00', to: '19:00' }],
    unsure: [{ days: [0], from: '09:00', to: '13:30' }] } } });
  assert.equal(isControlled('x:B', SAT, at(10), false), 'ctrl');
  assert.equal(isControlled('x:B', SUN, at(10), false), 'unknown');
  assert.equal(isControlled('x:B', SUN, at(15), false), 'free');
  ctx.setParkingRules(rules);
});

test('London time follows British Summer Time', () => {
  assert.deepEqual({ ...londonDayTime(new Date('2026-07-05T09:30:00Z')) }, { day: SUN, minutes: at(10, 30) });
  assert.deepEqual({ ...londonDayTime(new Date('2026-12-05T23:59:00Z')) }, { day: SAT, minutes: at(23, 59) });
});

test('cost adds the surcharge per hour', () => {
  assert.equal(parkingCost(4.5, 90, false, 1), 6.75);
  assert.equal(parkingCost(4.5, 90, true, 1), 8.25);
});

const MON = 1, FRI = 5;

test('bank holiday list covers this year and next', () => {
  assert.ok(rules.bankHolidays.includes('2026-12-25'));
  assert.ok(rules.bankHolidays.some((d) => d.startsWith('2027-')));
  assert.equal(bankHolidayOn(new Date('2026-12-25T12:00:00Z')), '12-25');
  assert.equal(bankHolidayOn(new Date('2026-12-23T12:00:00Z')), false);
  assert.equal(londonDate(new Date('2026-06-30T23:30:00Z')), '2026-07-01');   // BST
});

test('H&F bank holidays: most zones free, zone G charged except Christmas Day', () => {
  // 2026-12-25 is a Friday; 2026-12-28 (Monday) is the Boxing Day substitute.
  assert.equal(isControlled('hf:H', FRI, at(12), false, '12-25'), 'free');
  assert.equal(isControlled('hf:H', FRI, at(12), false, false), 'ctrl');
  assert.equal(isControlled('hf:G', MON, at(12), false, '12-28'), 'ctrl');
  assert.equal(isControlled('hf:G', FRI, at(12), false, '12-25'), 'free');
  assert.equal(isControlled('hf:G', FRI, at(19), false, '12-28'), 'permit');
  assert.equal(isControlled('hf:G-permit', MON, at(12), false, true), 'permit');
});

test('bank holiday on an event day uses event hours (hf:T)', () => {
  assert.equal(isControlled('hf:T', MON, at(15), true, '12-28'), 'ctrl');
  assert.equal(isControlled('hf:T', MON, at(15), false, '12-28'), 'free');
});

test('a borough with no bank holiday rules is unknown on a bank holiday, never a guess', () => {
  const key = Object.keys(rules.rules).find((k) => {
    const r = rules.rules[k];
    return !rules.boroughs[r.borough].bankHolidays && !r.bankHolidays && r.periods &&
      r.periods.some((p) => p.days.includes(MON) && p.from <= '12:00' && p.to > '12:00');
  });
  assert.ok(key, 'found a rule controlled on Monday noon');
  assert.equal(isControlled(key, MON, at(12), false, false), 'ctrl');
  assert.equal(isControlled(key, MON, at(12), false, '12-28'), 'unknown');
  assert.equal(isControlled(key, MON, at(3), false, '12-28'), 'free');   // outside its hours anyway
});

test('nextChange: zone H is free from 10pm, then pay to park from 8:30am', () => {
  assert.deepEqual({ ...nextChange('hf:H', SAT, at(15), false, false) }, { day: SAT, minutes: at(22), status: 'free', inDays: 0 });
  assert.deepEqual({ ...nextChange('hf:H', SAT, at(23), false, false) }, { day: SUN, minutes: at(8, 30), status: 'ctrl', inDays: 1 });
  // zone I (Mon–Fri 9–5) on Saturday: next paid time is Monday 9am
  assert.deepEqual({ ...nextChange('hf:I', SAT, at(10), false, false) }, { day: MON, minutes: at(9), status: 'ctrl', inDays: 2 });
  // a bank holiday only counts for the starting day
  assert.deepEqual({ ...nextChange('hf:H', FRI, at(12), false, '12-25') }, { day: SAT, minutes: at(8, 30), status: 'ctrl', inDays: 1 });
});

test('bank holidays: unknown policy never guesses, exceptions are free', () => {
  // Brent varies by zone and has no borough policy: a controlled time is unknown, but a charged zone keeps its hours.
  assert.equal(isControlled('brent:E', 1, at(12), false, '05-25'), isControlled('brent:E', 1, at(12), false, false));
  // Greenwich's charged zones are free on Christmas Day, Boxing Day and New Year's Day only.
  const g = Object.keys(rules.rules).find(k => k.startsWith('greenwich:') && rules.rules[k].bankHolidays === 'charged');
  assert.ok(g);
  assert.equal(isControlled(g, 5, at(12), false, '12-26'), 'free');
  // Havering is charged on bank holidays except Christmas Day.
  const h = Object.keys(rules.rules).find(k => k.startsWith('havering:') && rules.rules[k].periods && rules.rules[k].periods.length);
  assert.equal(isControlled(h, 4, at(12), false, '12-25'), 'free');
});

test('H&F zone D (East) streets are Mon–Fri 9am–5pm, the rest of zone D every day', () => {
  assert.equal(isControlled('hf:D-east', SAT, at(12), false), 'free');
  assert.equal(isControlled('hf:D', SAT, at(12), false), 'ctrl');
});

test('event-day-only zones: free normally, controlled on event days', () => {
  assert.equal(isControlled('richmond:R', SAT, at(15), false), 'free');
  assert.equal(isControlled('richmond:R', SAT, at(15), true), 'ctrl');
});

test('Croydon N2 and West Thornton charge on Sundays 8am–8pm; other zones stay Mon–Sat', () => {
  assert.equal(isControlled('croydon:N2', SUN, at(12), false), 'ctrl');
  assert.equal(isControlled('croydon:West Thornton', SUN, at(19, 59), false), 'ctrl');
  assert.equal(isControlled('croydon:West Thornton', SUN, at(20), false), 'free');
  assert.equal(isControlled('croydon:N1', SUN, at(12), false), 'free');
});

test('Haringey: free on a bank holiday that is not an event day, event hours on event days', () => {
  for (const z of ['Bruce Castle', 'Tower Gardens', 'Finsbury Park', 'White Hart Lane']) {
    assert.equal(isControlled('haringey:' + z, 1, at(12), false, '05-25'), 'free', z);
  }
  // Bruce Castle: Mon–Sat 8am–6.30pm normally, until 8pm on a Saturday event day
  assert.equal(isControlled('haringey:Bruce Castle', SAT, at(19), false), 'free');
  assert.equal(isControlled('haringey:Bruce Castle', SAT, at(19), true), 'ctrl');
  // Walpole Road sub-zone of Tower Gardens: Sunday 1pm–10pm
  assert.equal(isControlled('haringey:TG-walpole', SUN, at(21), false), 'ctrl');
  assert.equal(isControlled('haringey:Tower Gardens', SUN, at(21), false), 'free');
  assert.equal(isControlled('haringey:TG-walpole', 1, at(14), false, '05-25'), 'unknown');
});

test('Richmond prices follow the July 2026 rise', () => {
  assert.equal(rules.rules['richmond:A1'].price.perHour, 4.7);
  assert.equal(rules.rules['richmond:D'].price.perHour, 2.8);
  assert.equal(rules.rules['richmond:N'].price.perHour, 1.95);
});
