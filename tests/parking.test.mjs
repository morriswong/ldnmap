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
ctx.setParkingRules(JSON.parse(readFileSync(new URL('data/parking/rules.json', root), 'utf8')));
const { isControlled, londonDayTime, parkingCost } = ctx;

const SUN = 0, SAT = 6;
const at = (h, m = 0) => h * 60 + m;

test('zone E: Sunday 10:00 is controlled, 23:00 is free', () => {
  assert.equal(isControlled('E', SUN, at(10), false), 'ctrl');
  assert.equal(isControlled('E', SUN, at(23), false), 'free');
});

test('zone H: Saturday 10:00 is free', () => {
  assert.equal(isControlled('H', SAT, at(10), false), 'free');
});

test('zone T: Sunday 15:00 is free normally and controlled on an event day', () => {
  assert.equal(isControlled('T', SUN, at(15), false), 'free');
  assert.equal(isControlled('T', SUN, at(15), true), 'ctrl');
});

test('zone G: 19:00 is permit holders only every day', () => {
  for (let day = 0; day < 7; day++) assert.equal(isControlled('G', day, at(19), false), 'permit');
});

test('Richford Street (K-Richford): Sunday 19:00 is controlled', () => {
  assert.equal(isControlled('K-Richford', SUN, at(19), false), 'ctrl');
  assert.equal(isControlled('K', SUN, at(19), false), 'free');
});

test('from is inclusive, to is exclusive', () => {
  assert.equal(isControlled('E', SUN, at(8, 29), false), 'free');
  assert.equal(isControlled('E', SUN, at(8, 30), false), 'ctrl');
  assert.equal(isControlled('E', SUN, at(22, 59), false), 'ctrl');
  assert.equal(isControlled('G', SUN, at(18, 30), false), 'permit');
  assert.equal(isControlled('G', SUN, at(20), false), 'ctrl');
});

test('permit-only zones and streets', () => {
  assert.equal(isControlled('QQ', SAT, at(10), false), 'permit');
  assert.equal(isControlled('QQ', SUN, at(10), false), 'free');
  assert.equal(isControlled('VV', SAT, at(10), false), 'free');
  assert.equal(isControlled('G-permit', SUN, at(10), false), 'permit');
  assert.equal(isControlled('G-permit', SUN, at(22), false), 'free');
});

test('unknown rules count as free', () => {
  assert.equal(isControlled('nope', SUN, at(10), false), 'free');
});

test('London time follows British Summer Time', () => {
  assert.deepEqual({ ...londonDayTime(new Date('2026-07-05T09:30:00Z')) }, { day: SUN, minutes: at(10, 30) });
  assert.deepEqual({ ...londonDayTime(new Date('2026-12-05T23:59:00Z')) }, { day: SAT, minutes: at(23, 59) });
});

test('cost adds the diesel surcharge per hour', () => {
  assert.equal(parkingCost(4.5, 90, false, 1), 6.75);
  assert.equal(parkingCost(4.5, 90, true, 1), 8.25);
});
