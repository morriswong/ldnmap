// Tests for parking-rules.js against the real data/parking/rules.json. Run with: npm test
// parking-rules.js is a plain browser script, so it runs in a VM context here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const ctx = { Intl };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('parking-rules.js', root), 'utf8'), ctx);
const rules = JSON.parse(readFileSync(new URL('data/parking/rules.json', root), 'utf8'));
ctx.setParkingRules(rules);
const { isControlled, londonDayTime, parkingCost } = ctx;

const SUN = 0, SAT = 6;
const at = (h, m = 0) => h * 60 + m;

test('H&F zone E: Sunday 10:00 is controlled, 23:00 is free', () => {
  assert.equal(isControlled('hf:E', SUN, at(10), false), 'ctrl');
  assert.equal(isControlled('hf:E', SUN, at(23), false), 'free');
});

test('H&F zone H: Saturday 10:00 is free', () => {
  assert.equal(isControlled('hf:H', SAT, at(10), false), 'free');
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
    for (const p of (r.periods || []).concat(r.permit || [], r.event ? r.event.periods : [])) {
      assert.ok(p.days.every((d) => d >= 0 && d <= 6), key);
      assert.match(p.from, /^\d\d:\d\d$/, key);
      assert.match(p.to, /^\d\d:\d\d$/, key);
      assert.ok(ctx.hhmmToMinutes(p.from) < ctx.hhmmToMinutes(p.to), key + ' period ends before it starts');
    }
  }
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
