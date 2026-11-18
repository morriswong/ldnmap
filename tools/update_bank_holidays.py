#!/usr/bin/env python3
"""Refresh the England and Wales bank holiday list in data/parking/rules.json.

The parking layer uses it to tell when "now" is a bank holiday, when many councils don't charge.
Source: https://www.gov.uk/bank-holidays.json (Open Government Licence). No dependencies.

    python3 tools/update_bank_holidays.py
"""
import json
import os
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RULES = os.path.join(ROOT, 'data', 'parking', 'rules.json')
URL = 'https://www.gov.uk/bank-holidays.json'
UA = 'ldnmap-parking-check/1.0 (+https://ldnmap.pages.dev)'


def fetch_dates():
    req = urllib.request.Request(URL, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    return sorted({e['date'] for e in data['england-and-wales']['events']})


def main():
    dates = fetch_dates()
    with open(RULES) as f:
        rules = json.load(f)
    old = rules.get('bankHolidays', [])
    # Keep the key near the top, after "checked", so the file stays easy to read.
    out = {}
    for k, v in rules.items():
        out[k] = v
        if k == 'checked':
            out['bankHolidays'] = dates
    out.setdefault('bankHolidays', dates)
    with open(RULES, 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    added = sorted(set(dates) - set(old))
    print(f'{len(dates)} bank holidays, {dates[0]} to {dates[-1]}; {len(added)} new')


if __name__ == '__main__':
    main()
