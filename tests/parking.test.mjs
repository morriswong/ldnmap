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

// ---- Park near here: planStay / maxStayMinutes ----

const { planStay, maxStayMinutes, ruleTariff } = ctx;
const THU = 4;
const plain = (x) => JSON.parse(JSON.stringify(x));   // VM-context objects → this realm, for deepEqual
const seg = (start, end, status) => ({ start, end, status });

test('maxStayMinutes reads one length and never guesses', () => {
  assert.equal(maxStayMinutes('4 hours'), 240);
  assert.equal(maxStayMinutes('1 hour'), 60);
  assert.equal(maxStayMinutes('90 minutes'), 90);
  assert.equal(maxStayMinutes('12 hours'), 720);
  assert.equal(maxStayMinutes('1.5 hours'), 90);
  assert.equal(maxStayMinutes('1 hour 30 minutes'), 90);
  assert.equal(maxStayMinutes('2 hours (pay and display bays)'), 120);
  assert.equal(maxStayMinutes('2 hours (visitors)'), 120);
  assert.equal(maxStayMinutes(' 4 Hours '), 240);
  for (const bad of [undefined, null, '', 'See signs', '2 or 4 hours', '1, 2 or 4 hours', '0 hours',
    '6 hours in the new pay and display bays on parts of these roads; 2 hours in other bays', 'hours', 42]) {
    assert.equal(maxStayMinutes(bad), null, String(bad));
  }
});

test('every maxStay in the data is either read or deliberately null', () => {
  for (const [key, r] of Object.entries(rules.rules)) {
    if (!r.maxStay) continue;
    const m = maxStayMinutes(r.maxStay);
    assert.ok(m === null || (Number.isInteger(m) && m > 0 && m <= 1440), key + ': ' + r.maxStay);
    if (/^\d+ (hours?|minutes)$/.test(r.maxStay)) assert.ok(m > 0, key + ' should read ' + r.maxStay);
  }
});

test('planStay: Lewisham E Thursday 17:00 for 3 hours pays until 19:00', () => {
  const p = planStay('lewisham:E', THU, at(17), 180, false, false);
  assert.equal(p.ok, true);
  assert.equal(p.status, 'ok');
  assert.deepEqual(plain(p.segments), [seg(0, 120, 'ctrl'), seg(120, 180, 'free')]);
  assert.equal(p.paidMin, 120);
  // Lewisham prices by emissions band: E's £2.32 is its cheapest band, so a 'from' price.
  assert.equal(p.cost, null);
  assert.equal(p.costMin, 4.64);
  assert.equal(p.costMax, null);
  assert.equal(p.perHour, null);
  assert.equal(p.tariff.basis, 'from');
  assert.equal(p.tariff.min, 2.32);
  assert.equal(p.maxStayMin, 240);
  assert.equal(p.longestPaidMin, 120);
  assert.equal(p.freeAll, false);
  assert.equal(planStay('lewisham:L', THU, at(17), 180, false, false).costMin, 6.72);
});

test('planStay: Saturday in Lewisham E is free all stay', () => {
  const p = planStay('lewisham:E', SAT, at(10), 300, false, false);
  assert.equal(p.status, 'ok');
  assert.equal(p.freeAll, true);
  assert.equal(p.paidMin, 0);
  assert.equal(p.cost, 0);
  assert.equal(p.costMin, 0);
  assert.equal(p.costMax, 0, 'nothing to pay is exact, whatever the tariff');
  assert.deepEqual(plain(p.segments), [seg(0, 300, 'free')]);
});

test('planStay: a paid stretch over the max stay is excluded, exactly the max stay is fine', () => {
  const p = planStay('lewisham:E', THU, at(10), 300, false, false);
  assert.equal(p.status, 'maxstay');
  assert.equal(p.ok, false);
  assert.equal(p.longestPaidMin, 300);
  assert.equal(p.costMin, 11.6);   // still priced, so the UI can say why
  assert.equal(planStay('lewisham:E', THU, at(10), 240, false, false).status, 'ok');
  // 16:00 + 5h: only 3h of it is paid, so within the 4h max
  assert.equal(planStay('lewisham:E', THU, at(16), 300, false, false).status, 'ok');
});

test('planStay: permit-holders-only time excludes the stay', () => {
  const qq = planStay('hf:QQ', SAT, at(10), 60, false, false);
  assert.equal(qq.status, 'permit');
  assert.equal(qq.ok, false);
  assert.deepEqual(plain(qq.segments), [seg(0, 60, 'permit')]);
  // hf:G: permit only 18:30–20:00, then pay again until 22:00
  const g = planStay('hf:G', SUN, at(18), 180, false, false);
  assert.deepEqual(plain(g.segments), [seg(0, 30, 'ctrl'), seg(30, 120, 'permit'), seg(120, 180, 'ctrl')]);
  assert.equal(g.status, 'permit');
  // permit beats maxstay (G's max stay is 2 hours; 15:00–18:30 is 3.5h paid)
  assert.equal(planStay('hf:G', SUN, at(15), 240, false, false).status, 'permit');
});

test('planStay: unreadable hours and unknown keys are unknown, never ok', () => {
  const nope = planStay('nope:Z', SUN, at(10), 60, false, false);
  assert.equal(nope.status, 'unknown');
  assert.equal(nope.ok, false);
  assert.deepEqual(plain(nope.segments), [seg(0, 60, 'unknown')]);
  assert.equal(nope.perHour, null);
  assert.equal(nope.maxStayMin, null);
  ctx.setParkingRules({ boroughs: {}, rules: {
    'x:A': { hours: 'See signs', periods: null, maxStay: '1 hour' },
    'x:B': { hours: 'Mon-Sat 9am-7pm', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '09:00', to: '19:00' }],
      unsure: [{ days: [0], from: '09:00', to: '13:30' }], maxStay: '1 hour', price: { perHour: 2 } },
    'x:C': { hours: 'Permit holders 9-5', periods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '17:00' }],
      unsure: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '17:00', to: '18:00' }], permitOnly: true },
  } });
  try {
    assert.equal(planStay('x:A', SUN, at(10), 60, false, false).status, 'unknown');
    // unknown beats maxstay: Sat 16:00 → Sun 11:00 has 3h paid (> 1h max) and Sunday-morning unknown
    const b = planStay('x:B', SAT, at(16), 19 * 60, false, false);
    assert.equal(b.status, 'unknown');
    assert.equal(b.longestPaidMin, 180);
    assert.deepEqual(plain(b.segments), [seg(0, 180, 'ctrl'), seg(180, 1020, 'free'), seg(1020, 1140, 'unknown')]);
    // permit beats unknown
    assert.equal(planStay('x:C', MON, at(16), 120, false, false).status, 'permit');
  } finally {
    ctx.setParkingRules(rules);
  }
});

test('planStay: a borough priced by emissions band gives a range for the paid time', () => {
  // hf:H: every day 8:30am–10pm, max stay 2 hours, no price of its own; H&F bands £2.80–£7.00.
  // Saturday 21:00 for 12 hours crosses midnight.
  const p = planStay('hf:H', SAT, at(21), 720, false, false);
  assert.equal(p.status, 'ok');
  assert.deepEqual(plain(p.segments), [seg(0, 60, 'ctrl'), seg(60, 690, 'free'), seg(690, 720, 'ctrl')]);
  assert.equal(p.paidMin, 90);
  assert.equal(p.longestPaidMin, 60);
  assert.equal(p.perHour, null);
  assert.equal(p.cost, null, 'not exact: it depends on the car');
  assert.equal(p.costMin, 4.2);
  assert.equal(p.costMax, 10.5);
  assert.equal(p.tariff.basis, 'bands');
});

test('planStay: paid time with no price in the data has null costs but is still ok', () => {
  // Islington sets prices street by street: only a note and a link.
  const p = planStay('islington:A', THU, at(10), 60, false, false);
  assert.equal(p.status, 'ok');
  assert.equal(p.paidMin, 60);
  assert.equal(p.tariff, null);
  assert.equal(p.perHour, null);
  assert.equal(p.cost, null);
  assert.equal(p.costMin, null);
  assert.equal(p.costMax, null);
  // Hours that can't be read: no cost at all, never £0
  const u = planStay('nope:Z', SUN, at(10), 60, false, false);
  assert.equal(u.costMin, null);
  assert.equal(u.costMax, null);
});

test('planStay: crossing midnight continues into the next day, and Saturday wraps to Sunday', () => {
  // Lewisham E Friday 18:00 for 24h: 1h paid Friday, Saturday free
  const p = planStay('lewisham:E', FRI, at(18), 1440, false, false);
  assert.deepEqual(plain(p.segments), [seg(0, 60, 'ctrl'), seg(60, 1440, 'free')]);
  assert.equal(p.costMin, 2.32);
  // Sunday 22:00 for 12h: Monday 09:00–10:00 is paid
  const q = planStay('lewisham:E', SUN, at(22), 720, false, false);
  assert.deepEqual(plain(q.segments), [seg(0, 660, 'free'), seg(660, 720, 'ctrl')]);
  // A 24-hour zone merges across midnight into one paid run
  ctx.setParkingRules({ boroughs: {}, rules: { 'x:D': { hours: '24h', maxStay: '4 hours',
    periods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }] } } });
  try {
    const d = planStay('x:D', SAT, at(22), 240, false, false);
    assert.deepEqual(plain(d.segments), [seg(0, 240, 'ctrl')]);
    assert.equal(d.longestPaidMin, 240);
    assert.equal(d.status, 'ok');
    assert.equal(planStay('x:D', SAT, at(22), 241, false, false).status, 'maxstay');
  } finally {
    ctx.setParkingRules(rules);
  }
});

test('planStay: bank holiday and event day apply to the starting day only', () => {
  // hf:H on Christmas Day (Friday) is free; Saturday 08:30 is paid again
  const p = planStay('hf:H', FRI, at(21), 720, false, '12-25');
  assert.deepEqual(plain(p.segments), [seg(0, 690, 'free'), seg(690, 720, 'ctrl')]);
  // hf:T: Sunday 15:00 is paid on an event day only
  assert.equal(planStay('hf:T', SUN, at(15), 60, true, false).paidMin, 60);
  assert.equal(planStay('hf:T', SUN, at(15), 60, false, false).paidMin, 0);
});

// ---- Prices: ruleTariff and planStay's costs ----

test('ruleTariff: each way the data prices a rule', () => {
  // model 'zone': the rule's own price is exact
  assert.deepEqual(plain(ruleTariff('hackney:A')), { min: 5.7, max: 5.7, exact: true, basis: 'zone', by: null,
    bands: null, note: rules.boroughs.hackney.charges.note, url: rules.boroughs.hackney.charges.url || null });
  // model 'flat': the borough's one rate, in every zone
  const w = plain(ruleTariff('wandsworth:A1'));
  assert.equal(w.basis, 'flat');
  assert.equal(w.exact, true);
  assert.equal(w.min, 3.7);
  assert.equal(w.max, 3.7);
  // emissions bands: the range of the borough's bands, labelled for a table
  const c = plain(ruleTariff('croydon:Centre'));
  assert.equal(c.basis, 'bands');
  assert.equal(c.by, 'emissions');
  assert.equal(c.exact, false);
  assert.equal(c.min, 1.57);
  assert.equal(c.max, 2.1);
  assert.deepEqual(c.bands, [{ label: 'Band 1 (0 g/km)', perHour: 1.57 }, { label: 'Band 2 (1–138 g/km)', perHour: 1.78 },
    { label: 'Band 3 (>138 g/km)', perHour: 2.1 }]);
  assert.equal(c.url, rules.boroughs.croydon.charges.url);
  // by fuel type
  const city = plain(ruleTariff('city:City'));
  assert.equal(city.basis, 'fuel');
  assert.equal(city.by, 'fuel');
  assert.equal(city.min, 5);
  assert.equal(city.max, 10);
  assert.deepEqual(city.bands.map((b) => b.label), ['Electric', 'Petrol', 'Diesel', 'Other']);
  assert.deepEqual(plain(ruleTariff('rbkc:1')).bands.map((b) => b.label), ['Electric', 'Petrol', 'Diesel']);
  // model 'note' (prices street by street) and unknown keys: none
  assert.equal(ruleTariff('islington:A'), null);
  assert.equal(ruleTariff('nope:Z'), null);
});

test('ruleTariff: a rule price in a borough priced by band is a "from" price (Lambeth, Lewisham)', () => {
  for (const [key, min] of [['lambeth:A', 5.68], ['lewisham:E', 2.32]]) {
    const t = plain(ruleTariff(key));
    assert.equal(t.basis, 'from', key);
    assert.equal(t.min, min, key);
    assert.equal(t.max, null, key);
    assert.equal(t.exact, false, key);
    assert.equal(t.by, 'emissions', key);
    assert.equal(t.bands, null, key);
  }
  const p = planStay('lambeth:A', THU, at(10), 120, false, false);
  assert.equal(p.costMin, 11.36);
  assert.equal(p.costMax, null);
  assert.equal(p.cost, null);
});

test('every rule in a borough with prices gets a tariff', () => {
  for (const [key, r] of Object.entries(rules.rules)) {
    const c = (rules.boroughs[r.borough] || {}).charges || {};
    const priced = c.model === 'flat' || (c.bands && c.bands.length) || c.byFuel || (r.price && (r.price.perHour != null || (r.price.bands || []).length));
    const t = ruleTariff(key);
    if (!priced) continue;
    assert.ok(t, key + ' has prices but no tariff');
    assert.ok(t.min > 0 && (t.max === null || t.max >= t.min), key);
    assert.equal(t.exact, t.max === t.min, key);
  }
});

test('ruleTariff and planStay: a rule with its own emission bands (Westminster-style)', () => {
  const band = (b, perHour) => ({ band: b, co2: b === 1 ? '0–50 g/km' : 'over ' + b * 50 + ' g/km', perHour });
  ctx.setParkingRules({ boroughs: {
    w: { name: 'W', maxStayDefault: '4 hours', charges: { model: 'zone', note: 'By parent zone and CO2 band.', url: 'https://w.example/tariffs' } },
    v: { name: 'V', charges: { bands: [band(1, 1), band(2, 2)], url: 'https://v.example' } } },
  rules: {
    'w:G': { borough: 'w', zone: 'G', hours: 'Mon-Sat 8:30am-6:30pm', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '08:30', to: '18:30' }],
      price: { bands: [band(1, 4.78), band(2, 6.2), band(3, 8.1), band(4, 9.5), band(5, 10.58)], note: 'Zone G', url: 'https://w.example/g.pdf' } },
    'w:D': { borough: 'w', zone: 'D', hours: 'Mon-Sat 8:30am-6:30pm', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '08:30', to: '18:30' }],
      maxStay: '2 or 4 hours', price: { bands: [band(1, 2.2), band(2, 4.88)] } },
    'w:Z': { borough: 'w', zone: 'Z', hours: 'Mon-Sat 8:30am-6:30pm', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '08:30', to: '18:30' }] },
    // the rule's own bands win over the borough's
    'v:A': { borough: 'v', zone: 'A', hours: 'x', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '08:30', to: '18:30' }],
      price: { bands: [band(1, 3), band(2, 5)] } },
    'v:B': { borough: 'v', zone: 'B', hours: 'x', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '08:30', to: '18:30' }] } } });
  try {
    const g = plain(ruleTariff('w:G'));
    assert.equal(g.basis, 'bands');
    assert.equal(g.min, 4.78);
    assert.equal(g.max, 10.58);
    assert.equal(g.exact, false);
    assert.equal(g.note, 'Zone G');
    assert.equal(g.url, 'https://w.example/g.pdf');
    assert.deepEqual(g.bands[0], { label: 'Band 1 (0–50 g/km)', perHour: 4.78 });
    assert.equal(g.bands.length, 5);
    assert.equal(plain(ruleTariff('w:D')).url, 'https://w.example/tariffs', 'the borough link when the rule has none');
    assert.equal(ruleTariff('w:Z'), null, "a 'zone' borough's rule with no price of its own");
    assert.deepEqual(plain(ruleTariff('v:A')).bands.map((b) => b.perHour), [3, 5]);
    assert.deepEqual(plain(ruleTariff('v:B')).bands.map((b) => b.perHour), [1, 2]);

    // 2 hours from Thursday 10:00 in zone G
    const p = planStay('w:G', THU, at(10), 120, false, false);
    assert.equal(p.status, 'ok');
    assert.equal(p.costMin, 9.56);
    assert.equal(p.costMax, 21.16);
    assert.equal(p.cost, null);
    assert.equal(p.perHour, null);
    // No maxStay of its own: the borough's 4 hour default applies
    assert.equal(p.maxStayMin, 240);
    assert.equal(planStay('w:G', THU, at(10), 300, false, false).status, 'maxstay');
    assert.equal(planStay('w:Z', THU, at(10), 300, false, false).status, 'maxstay');
    // A maxStay it can't read stays unknown, never the borough default
    assert.equal(planStay('w:D', THU, at(10), 300, false, false).maxStayMin, null);
    assert.equal(planStay('w:D', THU, at(10), 300, false, false).status, 'ok');
    // A borough with no default and a rule with no maxStay: no limit
    assert.equal(planStay('v:A', THU, at(10), 120, false, false).maxStayMin, null);
    // Nothing paid: exact £0 whatever the bands
    const sun = planStay('w:G', SUN, at(10), 120, false, false);
    assert.deepEqual([sun.cost, sun.costMin, sun.costMax], [0, 0, 0]);
  } finally {
    ctx.setParkingRules(rules);
  }
});

test('planStay: max stay falls back to the borough default (Lewisham)', () => {
  const noOwn = Object.keys(rules.rules).filter((k) => k.startsWith('lewisham:') && !rules.rules[k].maxStay && rules.rules[k].periods);
  assert.ok(noOwn.length > 0);
  for (const key of noOwn) assert.equal(planStay(key, THU, at(10), 60, false, false).maxStayMin, 240, key);
});

test('planStay agrees with isControlled minute by minute', () => {
  const keys = Object.keys(rules.rules);
  const starts = [[MON, at(0)], [THU, at(8, 45)], [FRI, at(17, 59)], [SAT, at(23, 30)], [SUN, at(12, 1)]];
  for (let i = 0; i < keys.length; i += 20) {
    const key = keys[i];
    for (const [day, minutes] of starts) {
      const p = planStay(key, day, minutes, 1440, false, false);
      const segs = plain(p.segments);
      assert.equal(segs[0].start, 0);
      assert.equal(segs[segs.length - 1].end, 1440);
      for (const s of segs) {
        for (let t = s.start; t < s.end; t += 1) {
          const abs = minutes + t;
          const want = isControlled(key, (day + Math.floor(abs / 1440)) % 7, abs % 1440, false, false);
          if (want !== s.status) assert.fail(`${key} day ${day} ${minutes}+${t}: ${s.status} ≠ ${want}`);
        }
      }
      for (let j = 1; j < segs.length; j++) {
        assert.equal(segs[j].start, segs[j - 1].end, key);
        assert.notEqual(segs[j].status, segs[j - 1].status, key + ' segments are merged');
      }
    }
  }
});

test('planStay is fast enough to plan hundreds of streets', () => {
  const keys = Object.keys(rules.rules).slice(0, 500);
  const t0 = performance.now();
  for (const key of keys) planStay(key, THU, at(8), 1440, false, false);
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `500 × 24h plans took ${ms.toFixed(1)}ms`);
});

// ---- Park near here with no stay chosen: stayFromNow ----

test('stayFromNow: paid now, then free, then a paid stretch that hits the max stay', () => {
  const { stayFromNow } = ctx;
  // Lewisham E (Mon–Fri 9am–7pm, 4 hours max): Thursday 17:00 pays until 19:00, is free overnight,
  // and from Friday 9:00 can stay 4 more hours: leave by Friday 13:00.
  const p = stayFromNow('lewisham:E', THU, at(17), false, false);
  assert.equal(p.ok, true);
  assert.equal(p.now, 'ctrl');
  assert.deepEqual(plain(p.segments), [seg(0, 120, 'ctrl'), seg(120, 960, 'free'), seg(960, 1200, 'ctrl')]);
  assert.equal(p.untilMin, 1200);
  assert.equal(p.limit, 'maxstay');
  assert.equal(p.maxStayMin, 240);
  assert.equal(p.tariff.basis, 'from');
  assert.equal(p.tariff.min, 2.32);
  assert.equal(p.perHour, null);
  // Thursday 10:00: 9 hours of paid time left today, so the max stay ends it.
  const q = stayFromNow('lewisham:E', THU, at(10), false, false);
  assert.deepEqual(plain(q.segments), [seg(0, 240, 'ctrl')]);
  assert.equal(q.untilMin, 240);
  assert.equal(q.limit, 'maxstay');
});

test('stayFromNow: free now until the controls start, over the weekend', () => {
  const { stayFromNow } = ctx;
  // Saturday 10:00 in Lewisham E: free until Monday 9:00 (47 hours), then 4 hours paid.
  const p = stayFromNow('lewisham:E', SAT, at(10), false, false);
  assert.equal(p.now, 'free');
  assert.deepEqual(plain(p.segments), [seg(0, 2820, 'free'), seg(2820, 3060, 'ctrl')]);
  assert.equal(p.untilMin, 3060);
  // A shorter horizon sees only the free part, and nothing that ends it.
  const day = stayFromNow('lewisham:E', SAT, at(10), false, false, 1440);
  assert.deepEqual(plain(day.segments), [seg(0, 1440, 'free')]);
  assert.equal(day.untilMin, null);
  assert.equal(day.limit, null);
});

test('stayFromNow: permit-holders-only time ends the stay, or stops it starting', () => {
  const { stayFromNow } = ctx;
  // hf:G: paid 9am–10pm with 2 hours max, permit holders only 6:30–8pm. Sunday 17:00: 90 min paid.
  const g = stayFromNow('hf:G', SUN, at(17), false, false);
  assert.equal(g.ok, true);
  assert.deepEqual(plain(g.segments), [seg(0, 90, 'ctrl')]);
  assert.equal(g.untilMin, 90);
  assert.equal(g.limit, 'permit');
  const now = stayFromNow('hf:G', SUN, at(19), false, false);
  assert.equal(now.ok, false);
  assert.equal(now.now, 'permit');
  assert.deepEqual(plain(now.segments), []);
  assert.equal(now.untilMin, null);
  // hf:QQ is permit holders only Mon–Sat 9am–5pm: Saturday 18:00 is free until Monday 9:00.
  const qq = stayFromNow('hf:QQ', SAT, at(18), false, false);
  assert.deepEqual(plain(qq.segments), [seg(0, 2340, 'free')]);
  assert.equal(qq.untilMin, 2340);
  assert.equal(qq.limit, 'permit');
  assert.equal(stayFromNow('hf:QQ', SAT, at(10), false, false).ok, false);
});

test('stayFromNow: unclear hours stop it starting or end it; no controls have no limit', () => {
  const { stayFromNow } = ctx;
  const nope = stayFromNow('nope:Z', SUN, at(10), false, false);
  assert.equal(nope.ok, false);
  assert.equal(nope.now, 'unknown');
  assert.deepEqual(plain(nope.segments), []);
  ctx.setParkingRules({ boroughs: {}, rules: {
    'x:B': { hours: 'Mon-Sat 9am-7pm', periods: [{ days: [1, 2, 3, 4, 5, 6], from: '09:00', to: '19:00' }],
      unsure: [{ days: [0], from: '09:00', to: '13:30' }], maxStay: '1 hour', price: { perHour: 2 } },
    'x:D': { hours: '24h', maxStay: '4 hours', periods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }] },
    'x:E': { hours: '24h', periods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }], price: { perHour: 3 } },
    'x:F': { hours: 'No controls', periods: [] } } });
  try {
    // Saturday 18:30: 30 min paid, free from 7pm, then Sunday morning's hours are unclear.
    const b = stayFromNow('x:B', SAT, at(18, 30), false, false);
    assert.deepEqual(plain(b.segments), [seg(0, 30, 'ctrl'), seg(30, 870, 'free')]);
    assert.equal(b.untilMin, 870);
    assert.equal(b.limit, 'unknown');
    assert.equal(b.perHour, 2);
    // Paid round the clock: the max stay across midnight, or no limit without one.
    const d = stayFromNow('x:D', SAT, at(22), false, false);
    assert.deepEqual(plain(d.segments), [seg(0, 240, 'ctrl')]);
    assert.equal(d.limit, 'maxstay');
    const e = stayFromNow('x:E', SAT, at(22), false, false);
    assert.deepEqual(plain(e.segments), [seg(0, 7 * 1440, 'ctrl')]);
    assert.equal(e.untilMin, null);
    assert.equal(e.limit, null);
    const f = stayFromNow('x:F', SAT, at(22), false, false);
    assert.equal(f.now, 'free');
    assert.deepEqual(plain(f.segments), [seg(0, 7 * 1440, 'free')]);
    assert.equal(f.untilMin, null);
  } finally {
    ctx.setParkingRules(rules);
  }
});

test('stayFromNow: a bank holiday applies to the starting day only', () => {
  const { stayFromNow } = ctx;
  // hf:H on Christmas Day (a Friday) is free; Saturday 8:30am is paid again, 2 hours max.
  const p = stayFromNow('hf:H', FRI, at(21), false, '12-25');
  assert.deepEqual(plain(p.segments), [seg(0, 690, 'free'), seg(690, 810, 'ctrl')]);
  assert.equal(p.untilMin, 810);
  assert.equal(p.limit, 'maxstay');
});
