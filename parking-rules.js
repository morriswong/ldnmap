// Parking rules for the parking layer: pure functions, no DOM or map.
// Loaded with a plain <script> before app.js, and by tests/parking.test.mjs in Node.
// Rules come from data/parking/rules.json; see data/parking/README.md for the format.

var parkingRules = null;

function setParkingRules(rules) { parkingRules = rules; }

// A zone (e.g. 'E') or a special street rule (e.g. 'K-Richford'), or null.
function parkingRule(key) {
  if (!parkingRules) return null;
  return parkingRules.zones[key] || parkingRules.specialStreets[key] || null;
}

function hhmmToMinutes(s) {
  var p = s.split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

// True when `day` (0 = Sun … 6 = Sat) and `minutes` after midnight fall in any period.
// `from` is inclusive and `to` exclusive.
function inPeriods(periods, day, minutes) {
  return (periods || []).some(function(p) {
    return p.days.indexOf(day) !== -1 &&
      minutes >= hhmmToMinutes(p.from) && minutes < hhmmToMinutes(p.to);
  });
}

// Status of a rule at a London day and time: 'ctrl' (pay or permit), 'free', or
// 'permit' (permit holders only). Unknown rules count as free.
function isControlled(ruleKey, day, minutes, eventDay) {
  var rule = parkingRule(ruleKey);
  if (!rule) return 'free';
  var periods = eventDay && rule.event ? rule.event.periods : rule.periods;
  if (inPeriods(rule.permit, day, minutes)) return 'permit';
  if (!inPeriods(periods, day, minutes)) return 'free';
  return rule.permitOnly ? 'permit' : 'ctrl';
}

// The day and minutes after midnight in London for a Date.
function londonDayTime(date) {
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  var get = function(type) { return parts.filter(function(p) { return p.type === type; })[0].value; };
  var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day: day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// Pay-to-park cost in pounds for a stay, at a band's hourly rate plus the diesel surcharge.
function parkingCost(perHour, minutes, diesel, dieselPerHour) {
  var rate = perHour + (diesel ? dieselPerHour : 0);
  return Math.round(rate * minutes / 60 * 100) / 100;
}
