// Parking rules for the parking layer: pure functions, no DOM or map.
// Loaded with a plain <script> before app.js, and by tests/parking.test.mjs in Node.
// Rules come from data/parking/rules.json; see data/parking/README.md for the format.
// Rule keys are "<borough id>:<zone>" (e.g. "hf:E") or "<borough id>:<street rule>" ("hf:K-Richford").

var parkingRules = null;

function setParkingRules(rules) { parkingRules = rules; }

// The rule for a key, or null.
function parkingRule(key) {
  return (parkingRules && parkingRules.rules[key]) || null;
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

// Status of a rule at a London day and time: 'ctrl' (pay or permit), 'free', 'permit'
// (permit holders only), or 'unknown' when the council's hours could not be read into
// periods (the card then shows the council's own text instead). Unknown keys are 'unknown'.
function isControlled(ruleKey, day, minutes, eventDay) {
  var rule = parkingRule(ruleKey);
  if (!rule) return 'unknown';
  var periods = eventDay && rule.event ? rule.event.periods : rule.periods;
  if (!periods) return 'unknown';
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

// Pay-to-park cost in pounds for a stay, at an hourly rate plus any per-hour surcharge.
function parkingCost(perHour, minutes, surcharge, surchargePerHour) {
  var rate = perHour + (surcharge ? surchargePerHour : 0);
  return Math.round(rate * minutes / 60 * 100) / 100;
}
