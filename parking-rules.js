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

// A rule's bank holiday policy: its own `bankHolidays`, else its borough's ('free' | 'charged'),
// or null when the council's bank holiday rules aren't in the data.
function bankHolidayPolicy(rule) {
  if (rule.bankHolidays) return rule.bankHolidays;
  var b = parkingRules && parkingRules.boroughs[rule.borough];
  return (b && b.bankHolidays) || null;
}

// Status of a rule at a London day and time: 'ctrl' (pay or permit), 'free', 'permit'
// (permit holders only), or 'unknown' when the council's hours could not be read into
// periods (the card then shows the council's own text instead) or the time falls in the
// rule's `unsure` periods. Unknown keys are 'unknown'.
// `bankHoliday` is false, true, or the holiday's 'MM-DD' (needed for `bankHolidayExcept`).
// On a bank holiday: event-day hours win when it's also an event day; otherwise a 'free'
// policy is free, 'charged' keeps the normal hours (except on `bankHolidayExcept` dates), and
// with no policy in the data anything that would be controlled is 'unknown', never a guess.
function isControlled(ruleKey, day, minutes, eventDay, bankHoliday) {
  var rule = parkingRule(ruleKey);
  if (!rule) return 'unknown';
  var periods = eventDay && rule.event ? rule.event.periods : rule.periods;
  if (!periods) return 'unknown';
  var holidayRules = bankHoliday && !(eventDay && rule.event);
  if (holidayRules) {
    var policy = bankHolidayPolicy(rule);
    if (policy === 'free') return 'free';
    if (policy === 'charged' && typeof bankHoliday === 'string' &&
        (rule.bankHolidayExcept || []).indexOf(bankHoliday) !== -1) return 'free';
  }
  if (inPeriods(rule.unsure, day, minutes)) return 'unknown';   // e.g. two zones drawn as one that differ here
  var status;
  if (inPeriods(rule.permit, day, minutes)) status = 'permit';
  else if (!inPeriods(periods, day, minutes)) status = 'free';
  else status = rule.permitOnly ? 'permit' : 'ctrl';
  // No policy, or 'unknown' (a council that varies by zone or day): never guess.
  if (holidayRules && bankHolidayPolicy(rule) !== 'charged' && status !== 'free') return 'unknown';
  return status;
}

// When a rule's status next changes after `day`/`minutes`, within a week: { day, minutes, status,
// inDays (0 = the same day) },
// or null if it never changes. Only the starting day is treated as an event day or bank holiday.
function nextChange(ruleKey, day, minutes, eventDay, bankHoliday) {
  var now = isControlled(ruleKey, day, minutes, eventDay, bankHoliday);
  for (var step = 1; step <= 7 * 1440; step++) {
    var t = minutes + step;
    var d = (day + Math.floor(t / 1440)) % 7, m = t % 1440;
    var sameDay = t < 1440;
    var s = isControlled(ruleKey, d, m, sameDay && eventDay, sameDay && bankHoliday);
    if (s !== now) return { day: d, minutes: m, status: s, inDays: Math.floor(t / 1440) };
  }
  return null;
}

// A London date as 'YYYY-MM-DD'.
function londonDate(date) {
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  var get = function(type) { return parts.filter(function(p) { return p.type === type; })[0].value; };
  return get('year') + '-' + get('month') + '-' + get('day');
}

// The bank holiday's 'MM-DD' if the London date of `date` is an England and Wales bank holiday
// (rules.json `bankHolidays`), else false.
function bankHolidayOn(date) {
  var iso = londonDate(date);
  var list = (parkingRules && parkingRules.bankHolidays) || [];
  return list.indexOf(iso) !== -1 ? iso.slice(5) : false;
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

// Minutes for a rule's maxStay text ('4 hours', '90 minutes', '1 hour', '1.5 hours',
// '1 hour 30 minutes', '2 hours (pay and display bays)'), or null when there is none or it can't
// be read as one length. Texts with a choice ('2 or 4 hours') or several clauses
// ('6 hours in …; 2 hours in other bays') are null: never guess which applies.
function maxStayMinutes(text) {
  if (typeof text !== 'string') return null;
  var s = text.replace(/\([^()]*\)/g, ' ').trim().toLowerCase();   // drop '(pay and display bays)'
  var m = /^(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)(?:\s+(\d+)\s*(?:minutes?|mins?|m))?$/.exec(s);
  if (m) {
    var total = Number(m[1]) * 60 + (m[3] ? Number(m[3]) : 0);
    return total > 0 && total === Math.round(total) ? total : null;
  }
  m = /^(\d+)\s*(?:minutes?|mins?|m)$/.exec(s);
  if (m && Number(m[1]) > 0) return Number(m[1]);
  return null;
}

// Minutes after midnight where a rule's status can change: every period edge (normal, event,
// permit, unsure), plus 0. Between two of these the status is constant for a given day.
function ruleChangePoints(rule) {
  var all = (rule.periods || []).concat(rule.permit || [], rule.unsure || [],
    rule.event && rule.event.periods ? rule.event.periods : []);
  var pts = [0];
  all.forEach(function(p) { pts.push(hhmmToMinutes(p.from), hhmmToMinutes(p.to)); });
  pts.sort(function(a, b) { return a - b; });
  return pts.filter(function(v, i) { return v < 1440 && (i === 0 || v !== pts[i - 1]); });
}

// Plan a stay of `stayMin` minutes (1..1440) from London `day` (0 = Sun … 6 = Sat) at `minutes`
// after midnight under rule `ruleKey`. eventDay/bankHoliday apply to the starting day only (as in
// nextChange); a stay past midnight carries on into the next day as a normal day.
// Returns { ok, status: 'ok'|'permit'|'unknown'|'maxstay', segments: [{start, end, status}] (merged,
// minutes from arrival, covering 0..stayMin), paidMin, cost, perHour, maxStayMin, longestPaidMin,
// freeAll }. Precedence: permit > unknown > maxstay > ok. `cost` is 0 with no paid time, null when
// there is paid time but no known price. A paid stretch equal to the max stay is allowed.
function planStay(ruleKey, day, minutes, stayMin, eventDay, bankHoliday) {
  var rule = parkingRule(ruleKey);
  stayMin = Math.max(1, Math.min(1440, Math.round(stayMin)));
  var points = rule ? ruleChangePoints(rule) : [0];
  var segments = [];
  var t = 0;
  while (t < stayMin) {
    var abs = minutes + t;
    var dayOffset = Math.floor(abs / 1440);
    var d = (day + dayOffset) % 7, m = abs % 1440;
    var first = dayOffset === 0;
    var s = isControlled(ruleKey, d, m, first && eventDay, first && bankHoliday);
    var next = 1440;   // next change point after m on this day
    for (var i = 0; i < points.length; i++) {
      if (points[i] > m) { next = points[i]; break; }
    }
    var end = Math.min(stayMin, t + (next - m));
    var last = segments[segments.length - 1];
    if (last && last.status === s) last.end = end;
    else segments.push({ start: t, end: end, status: s });
    t = end;
  }

  var paidMin = 0, longestPaidMin = 0, hasPermit = false, hasUnknown = false, freeAll = true;
  segments.forEach(function(seg) {
    var len = seg.end - seg.start;
    if (seg.status === 'ctrl') {
      paidMin += len;
      if (len > longestPaidMin) longestPaidMin = len;   // segments are merged, so one run = one segment
    }
    if (seg.status === 'permit') hasPermit = true;
    if (seg.status === 'unknown') hasUnknown = true;
    if (seg.status !== 'free') freeAll = false;
  });

  var perHour = rule && rule.price && typeof rule.price.perHour === 'number' ? rule.price.perHour : null;
  var maxStayMin = rule ? maxStayMinutes(rule.maxStay) : null;
  // Unknown minutes could be paid, so the cost of such a stay is unknown too, never £0.
  var cost = hasUnknown ? null : paidMin === 0 ? 0 : perHour !== null ? parkingCost(perHour, paidMin) : null;
  var status = hasPermit ? 'permit' : hasUnknown ? 'unknown'
    : maxStayMin !== null && longestPaidMin > maxStayMin ? 'maxstay' : 'ok';
  return {
    ok: status === 'ok', status: status, segments: segments, paidMin: paidMin, cost: cost,
    perHour: perHour, maxStayMin: maxStayMin, longestPaidMin: longestPaidMin, freeAll: freeAll
  };
}
