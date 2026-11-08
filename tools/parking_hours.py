"""Turn a council's controlled-hours text into periods for data/parking/rules.json.

parse_hours("Mon-Fri 8.30am-6.30pm and Sat 9am-1pm")
  -> [{"days": [1,2,3,4,5], "from": "08:30", "to": "18:30"}, {"days": [6], "from": "09:00", "to": "13:00"}]

Returns None whenever any part of the text is not understood, so a zone is shown as
"hours unknown" rather than wrongly coloured. Run this file to self-test it.
"""
import re

DAYS = {'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 0}
DAY_RE = r'(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?\.?'
ALL_WEEK = re.compile(r'\b(every ?day|all week|7 days(?: a week)?|daily|all days|monday ?(?:to|-|–)? ?sunday|mon ?(?:to|-|–) ?sun)\b', re.I)
TIME_RE = r'(\d{1,2})(?:[.:]?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|noon|midnight|midday|hrs|hours)?'
RANGE_RE = re.compile(r'(?<![\d.])' + TIME_RE + r'\s*(?:-|–|—|to|until|till)\s*' + TIME_RE + r'(?![\d.])', re.I)
SPLIT_RE = re.compile(r'\s*(?:;|,|\band\b|&|\bplus\b|\n)\s*', re.I)
NOISE_RE = re.compile(r'\b(from|between|operates?|operational|hours|controlled|times?|of operation|except bank holidays|'
                      r'excluding bank holidays|including bank holidays|inc(?:luding)? bank hols?|only|the|in|on)\b', re.I)


def _minutes(h, m, ampm, other_ampm):
    h, m = int(h), int(m or 0)
    a = (ampm or '').lower().replace('.', '')
    if a in ('noon', 'midday'):
        return 12 * 60 + m
    if a == 'midnight':
        return 24 * 60 if h in (0, 12) else None
    if a in ('am', 'pm'):
        if not 1 <= h <= 12:
            return None
        if a == 'pm' and h != 12:
            h += 12
        if a == 'am' and h == 12:
            h = 0
        return h * 60 + m
    if a in ('hrs', 'hours', '') and (m is not None or h > 12 or other_ampm is None):
        # 24-hour clock, e.g. "08:30-18:30" or "0830"
        return h * 60 + m if h <= 24 else None
    return None


def _hhmm(mins):
    return f'{mins // 60:02d}:{mins % 60:02d}'


def _days(text):
    """Day numbers named by text like 'Mon-Fri', 'Monday to Saturday', 'Sat', 'every day'."""
    t = text.strip().lower()
    if not t:
        return None
    if ALL_WEEK.search(t):
        return [0, 1, 2, 3, 4, 5, 6]
    out = []
    rng = re.match(r'^\s*' + DAY_RE + r'\s*(?:-|–|—|to|through)\s*' + DAY_RE + r'\s*$', t, re.I)
    if rng:
        a, b = DAYS[rng.group(1)[:3]], DAYS[rng.group(2)[:3]]
        order = [1, 2, 3, 4, 5, 6, 0]
        i, j = order.index(a), order.index(b)
        return order[i:j + 1] if i <= j else None
    parts = re.split(r'\s*(?:,|&|and|/)\s*', t)
    for p in parts:
        m = re.fullmatch(DAY_RE, p.strip(), re.I)
        if not m:
            return None
        out.append(DAYS[m.group(1)[:3]])
    return out or None


def parse_hours(text):
    """Periods for the text, or None if any part is not understood."""
    if not text:
        return None
    t = text.replace(' ', ' ').replace('–', '-').replace('—', '-')
    t = re.sub(r'\(.*?\)', ' ', t)          # drop asides like "(except bank holidays)"
    t = re.sub(r'(?<!\d)(?<!\d\s)\b(midnight|noon|midday)\b', r'12 \1', t, flags=re.I)   # bare "midnight"
    t = NOISE_RE.sub(' ', t)
    t = re.sub(r'\s+', ' ', t).strip(' .')
    periods = []
    # Each chunk is "<days> <time range>" or just "<time range>" (days carry over).
    days = None
    pos = 0
    for m in RANGE_RE.finditer(t):
        before = t[pos:m.start()].strip(' ,;&-')
        before = re.sub(r'^(and|plus)(\s+|$)', '', before, flags=re.I)
        if before:
            d = _days(before)
            if d is None:
                return None
            days = d
        if days is None:
            return None
        start = _minutes(m.group(1), m.group(2), m.group(3), m.group(6))
        end = _minutes(m.group(4), m.group(5), m.group(6), m.group(3))
        if start is None or end is None:
            return None
        if m.group(3) is None and m.group(6) and m.group(6).lower().replace('.', '') in ('am', 'pm'):
            # "8.30-6.30pm": the first time takes am/pm so that the range runs forwards.
            h = int(m.group(1))
            start = h * 60 + int(m.group(2) or 0)
            if start >= end:
                start += 12 * 60
        if not 0 <= start < end <= 24 * 60:
            return None
        periods.append({'days': sorted(days), 'from': _hhmm(start), 'to': _hhmm(end)})
        pos = m.end()
    tail = t[pos:].strip(' ,;&-.')
    if not periods or (tail and not re.fullmatch(r'(and|plus)?', tail, re.I)):
        return None
    return periods


if __name__ == '__main__':
    WK = [1, 2, 3, 4, 5]
    ALL = [0, 1, 2, 3, 4, 5, 6]
    cases = {
        'Mon-Fri 8.30am-6.30pm': [{'days': WK, 'from': '08:30', 'to': '18:30'}],
        'Monday to Friday 9am to 5pm': [{'days': WK, 'from': '09:00', 'to': '17:00'}],
        'Monday to Saturday 8:30am – 6:30pm': [{'days': [1, 2, 3, 4, 5, 6], 'from': '08:30', 'to': '18:30'}],
        'Mon-Fri 8.30am-6.30pm and Sat 9am-1pm': [{'days': WK, 'from': '08:30', 'to': '18:30'}, {'days': [6], 'from': '09:00', 'to': '13:00'}],
        'Monday to Sunday 8.30am to 10pm': [{'days': ALL, 'from': '08:30', 'to': '22:00'}],
        'Every day 8am-midnight': [{'days': ALL, 'from': '08:00', 'to': '24:00'}],
        'Mon - Fri 10am - 12 noon': [{'days': WK, 'from': '10:00', 'to': '12:00'}],
        'Monday to Friday 8.30 - 6.30pm': [{'days': WK, 'from': '08:30', 'to': '18:30'}],
        'Mon-Fri 0830-1830': [{'days': WK, 'from': '08:30', 'to': '18:30'}],
        'Mon-Fri 08:30-18:30, Sat 08:30-13:30': [{'days': WK, 'from': '08:30', 'to': '18:30'}, {'days': [6], 'from': '08:30', 'to': '13:30'}],
        'Monday to Friday 11am-12 noon and 3pm-4pm': [{'days': WK, 'from': '11:00', 'to': '12:00'}, {'days': WK, 'from': '15:00', 'to': '16:00'}],
        'Mon–Sat 9am–5pm (except bank holidays)': [{'days': [1, 2, 3, 4, 5, 6], 'from': '09:00', 'to': '17:00'}],
        'See signs': None,
        'Mon-Fri 2 hours': None,
        'Monday to Friday 8.30am to 6.30pm, match days 8.30am to 9.30pm': None,   # ambiguous: left for a person
        '': None,
    }
    bad = 0
    for text, want in cases.items():
        got = parse_hours(text)
        if got != want:
            bad += 1
            print('FAIL', repr(text), '->', got, 'wanted', want)
    print('parse_hours:', len(cases) - bad, 'of', len(cases), 'cases pass')
    raise SystemExit(1 if bad else 0)
