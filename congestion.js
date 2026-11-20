// London Congestion Charge (CCZ): pure functions, no DOM or map.
// Loaded with a plain <script> after parking-rules.js (whose londonDate() and londonDayTime() it
// uses) and before app.js, and by tests/congestion.test.mjs in Node.
//
// The rules, as checked on tfl.gov.uk on 20 Nov 2026:
// - £18 a day paid on the day or in advance, £21 if paid by midnight of the third day after.
//   Electric cars registered on Auto Pay pay £13.50 (25% off).
// - Charging hours 07:00–18:00 Monday–Friday, 12:00–18:00 Saturday, Sunday and bank holidays.
// - No charge from Christmas Day to the New Year's Day bank holiday, inclusive.
// - You pay if you drive within the zone during charging hours. A car parked inside the whole
//   time doesn't trigger it; driving in or out during charging hours does.
// All times are London local time. Charging hours include their start and exclude their end
// (07:00 is charged, 18:00 is free), as parking's periods do.
//
// The zone (data/ccz.geojson) is handed over once with ccSetZone(); the bank holiday list
// (data/bank-holidays.json, England and Wales) with ccSetBankHolidays(). Without its own list
// it falls back to the parking layer's (rules.json `bankHolidays`) when that has loaded.

var CCZ_PRICES = {
  standard: { key: 'standard', label: 'Standard', daily: 18, late: 21 },
  ev:       { key: 'ev', label: 'Electric car on Auto Pay', daily: 13.5, late: null }   // Auto Pay bills itself: never late
};
var CCZ_HOURS = {
  weekday: { start: 7 * 60, end: 18 * 60 },
  weekend: { start: 12 * 60, end: 18 * 60 }     // Saturday, Sunday and bank holidays
};
var CCZ_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var CCZ_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var CCZ_EARLIER_MAX = 3 * 60;     // ccFreeAlternative: how much earlier is "a little earlier"
var CCZ_BEFORE_GAP = 5;           // ...and how long before charging starts to be out of the zone

var cczZone = null;               // { polygons: [[ring, hole…]…], bbox: [w, s, e, n] }
var cczBankHolidays = null;       // ['YYYY-MM-DD', …]

// The zone, as a GeoJSON FeatureCollection, Feature, Polygon or MultiPolygon.
function ccSetZone(geojson) { cczZone = geojson ? cczPrepare(geojson) : null; }
function ccSetBankHolidays(list) { cczBankHolidays = list ? list.slice() : null; }

function cczPrepare(g) {
  var polys = [];
  (function walk(x) {
    if (!x) return;
    if (x.type === 'FeatureCollection') x.features.forEach(function(f) { walk(f.geometry); });
    else if (x.type === 'Feature') walk(x.geometry);
    else if (x.type === 'Polygon') polys.push(x.coordinates);
    else if (x.type === 'MultiPolygon') x.coordinates.forEach(function(p) { polys.push(p); });
  })(g);
  var bbox = [Infinity, Infinity, -Infinity, -Infinity];
  polys.forEach(function(p) {
    p[0].forEach(function(c) {
      bbox[0] = Math.min(bbox[0], c[0]); bbox[1] = Math.min(bbox[1], c[1]);
      bbox[2] = Math.max(bbox[2], c[0]); bbox[3] = Math.max(bbox[3], c[1]);
    });
  });
  return { polygons: polys, bbox: bbox };
}

function cczInRing(x, y, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// True when the point is inside the zone. `geojson` is optional and overrides the zone set with
// ccSetZone(); with neither, null (not known), never a guess.
function ccInZone(lng, lat, geojson) {
  var z = geojson ? cczPrepare(geojson) : cczZone;
  if (!z) return null;
  var b = z.bbox;
  if (!(lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3])) return false;
  return z.polygons.some(function(p) {
    if (!cczInRing(lng, lat, p[0])) return false;
    for (var h = 1; h < p.length; h++) if (cczInRing(lng, lat, p[h])) return false;
    return true;
  });
}

// --- London calendar -----------------------------------------------------------------------

function cczParse(iso) {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}
function cczIso(y, m, d) {
  var t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() + '-' + (t.getUTCMonth() < 9 ? '0' : '') + (t.getUTCMonth() + 1) + '-' +
    (t.getUTCDate() < 10 ? '0' : '') + t.getUTCDate();
}
function cczAddDays(iso, n) { var p = cczParse(iso); return cczIso(p.y, p.m, p.d + n); }
function cczWeekday(iso) { var p = cczParse(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }

function ccBankHoliday(iso) {
  var list = cczBankHolidays ||
    (typeof parkingRules !== 'undefined' && parkingRules && parkingRules.bankHolidays) || [];
  return list.indexOf(iso) !== -1;
}

// The New Year's Day bank holiday for `year`: 1 January, or the Monday after when it falls at a
// weekend. Worked out rather than looked up, so the Christmas break never depends on the list.
function cczNewYearHoliday(year) {
  var wd = cczWeekday(cczIso(year, 1, 1));
  return cczIso(year, 1, wd === 6 ? 3 : wd === 0 ? 2 : 1);
}

// True from Christmas Day to the New Year's Day bank holiday, inclusive.
function ccChristmasBreak(iso) {
  var p = cczParse(iso);
  if (p.m === 12) return p.d >= 25;
  return p.m === 1 && iso <= cczNewYearHoliday(p.y);
}

// A London date's charging hours as { start, end } minutes after midnight, or null when it has
// none (the Christmas break).
function ccChargingHours(iso) {
  if (ccChristmasBreak(iso)) return null;
  var wd = cczWeekday(iso);
  return (wd === 0 || wd === 6 || ccBankHoliday(iso)) ? CCZ_HOURS.weekend : CCZ_HOURS.weekday;
}

// The instant of a London wall-clock time: `iso` date, `minutes` after midnight (may run past
// 1440 or below 0). For the hour that happens twice in October, the first.
function ccLondonTime(iso, minutes) {
  var p = cczParse(iso);
  var wall = Date.UTC(p.y, p.m - 1, p.d) + minutes * 60000;
  var t = wall - cczOffset(new Date(wall));
  t = wall - cczOffset(new Date(t));
  return new Date(t);
}
// London time minus UTC at `date`, in ms (0 in winter, an hour in summer).
function cczOffset(date) {
  var q = cczParse(londonDate(date));
  var wall = Date.UTC(q.y, q.m - 1, q.d) + londonDayTime(date).minutes * 60000;
  return wall - Math.floor(date.getTime() / 60000) * 60000;
}

// --- Status and trips ----------------------------------------------------------------------

function cczCharging(date) {
  var iso = londonDate(date), h = ccChargingHours(iso);
  var m = londonDayTime(date).minutes;
  return !!h && m >= h.start && m < h.end;
}

// The first charging period starting after `date` (within three weeks): { start, end } Dates.
function cczNextPeriod(date) {
  var iso = londonDate(date);
  for (var i = 0; i < 21; i++) {
    var d = cczAddDays(iso, i), h = ccChargingHours(d);
    if (!h) continue;
    var s = ccLondonTime(d, h.start);
    if (s > date) return { start: s, end: ccLondonTime(d, h.end) };
  }
  return null;
}

// Whether the charge applies at `date`: { charging, until, next }.
// Charging: `until` is when this period ends (18:00), `next` when the following one starts.
// Not charging: `until` is null and `next` is when charging next starts.
function ccStatusAt(date) {
  if (cczCharging(date)) {
    var iso = londonDate(date), until = ccLondonTime(iso, ccChargingHours(iso).end);
    var after = cczNextPeriod(until);
    return { charging: true, until: until, next: after ? after.start : null };
  }
  var n = cczNextPeriod(date);
  return { charging: false, until: null, next: n ? n.start : null };
}

// The charge for driving into the zone at `arrival` and out at `leave` (Dates), parked inside
// in between. Each London day whose charging hours the arrival or the departure falls in is one
// charge. `price` is a CCZ_PRICES key (default 'standard').
// → { charged, days, dates: ['YYYY-MM-DD'…], amount (pounds, paid on the day), late (pounds if
//     paid by the third day after, or null), reason }
function ccChargeForTrip(arrival, leave, price) {
  var p = CCZ_PRICES[price] || CCZ_PRICES.standard;
  var inA = cczCharging(arrival), inL = cczCharging(leave);
  var dates = [];
  if (inA) dates.push(londonDate(arrival));
  if (inL && dates.indexOf(londonDate(leave)) === -1) dates.push(londonDate(leave));
  var reason;
  if (inA && inL) reason = dates.length > 1 ? 'Arriving and leaving in charging hours, on different days'
    : 'Arriving and leaving in charging hours';
  else if (inA) reason = 'Arriving in charging hours';
  else if (inL) reason = 'Leaving in charging hours';
  else reason = 'Arriving and leaving outside charging hours';
  return {
    charged: dates.length > 0,
    days: dates.length,
    dates: dates,
    amount: dates.length * p.daily,
    late: p.late === null ? null : dates.length * p.late,
    reason: reason
  };
}

// '7am', '6pm', '12pm', '6:55am', 'midnight'.
function ccClock(date) {
  var m = londonDayTime(date).minutes;
  if (m === 0) return 'midnight';
  var h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + (mm ? ':' + (mm < 10 ? '0' : '') + mm : '') + (h < 12 ? 'am' : 'pm');
}

// When `date` is, seen from `from`: '' (the same London day), 'tomorrow', 'Mon', or 'Sat 2 Jan'
// a week or more away.
function ccDayWord(date, from) {
  var a = londonDate(from), b = londonDate(date);
  if (a === b) return '';
  if (cczAddDays(a, 1) === b) return 'tomorrow';
  var p = cczParse(b);
  var wd = CCZ_DAYS[cczWeekday(b)];
  return b < cczAddDays(a, 7) ? wd : wd + ' ' + p.d + ' ' + CCZ_MONTHS[p.m - 1];
}

// The nearest shift of `arrival` that makes a stay of `stayMin` minutes free: later the same
// London day, or up to CCZ_EARLIER_MAX earlier. Ties go to later. `opts.now` (a Date) rules out
// arrivals before it.
// → { arrival, leave (Dates), shiftMin (+ later, − earlier), label: 'Arrive after 6pm' } or null
//   when the trip is already free or nothing nearby is.
function ccFreeAlternative(arrival, stayMin, opts) {
  var now = opts && opts.now;
  var stay = stayMin * 60000;
  if (!ccChargeForTrip(arrival, new Date(arrival.getTime() + stay)).charged) return null;
  var day = londonDate(arrival);
  var dayEnd = ccLondonTime(cczAddDays(day, 1), 0).getTime();
  var cands = [];
  // Every charging period that the trip could touch: from two days back to two days on.
  for (var i = -2; i <= 2; i++) {
    var d = cczAddDays(day, i), h = ccChargingHours(d);
    if (!h) continue;
    var s = ccLondonTime(d, h.start).getTime(), e = ccLondonTime(d, h.end).getTime();
    var before = s - CCZ_BEFORE_GAP * 60000;
    cands.push({ t: e, kind: 'arrive-after', at: e });
    cands.push({ t: e - stay, kind: 'leave-after', at: e });
    cands.push({ t: before, kind: 'arrive-before', at: s });
    cands.push({ t: before - stay, kind: 'leave-before', at: s });
  }
  var best = null;
  cands.forEach(function(c) {
    var shift = c.t - arrival.getTime();
    if (shift === 0) return;
    if (shift > 0 && c.t >= dayEnd) return;                        // later: the same day only
    if (shift < 0 && -shift > CCZ_EARLIER_MAX * 60000) return;     // earlier: only a little
    if (now && c.t < now.getTime()) return;
    var a = new Date(c.t);
    if (ccChargeForTrip(a, new Date(c.t + stay)).charged) return;
    if (!best || Math.abs(shift) < Math.abs(best.shift) ||
        (Math.abs(shift) === Math.abs(best.shift) && shift > best.shift)) best = { c: c, shift: shift };
  });
  if (!best) return null;
  var c = best.c, at = new Date(c.at), word = ccDayWord(at, arrival);
  var when = ccClock(at) + (word ? ' ' + word : '');
  var label = {
    'arrive-after': 'Arrive after ' + when,
    'leave-after': 'Leave after ' + when,
    'arrive-before': 'Arrive before ' + when,
    'leave-before': 'Leave before ' + when
  }[c.kind];
  return { arrival: new Date(c.t), leave: new Date(c.t + stay), shiftMin: Math.round(best.shift / 60000), label: label };
}

// The status line for the map chip: 'Charging now · until 6pm', 'Free now · starts 7am Mon',
// 'Free now · starts 12pm', 'Free now · starts 12pm Sat 2 Jan'.
function ccStatusText(date) {
  var s = ccStatusAt(date);
  if (s.charging) return 'Charging now · until ' + ccClock(s.until);
  if (!s.next) return 'Free now';
  var word = ccDayWord(s.next, date);
  return 'Free now · starts ' + ccClock(s.next) + (word ? ' ' + word : '');
}
