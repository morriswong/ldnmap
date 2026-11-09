#!/usr/bin/env python3
"""Fetch Bexley's CPZ road table into tools/parking_lists/bexley.json ({zone code: [street entries]}).

The council's controlled parking zones page lists every road with its area and the properties
affected; areas map to the zone codes on its residents' permit page.
"""
import html, json, os, re, subprocess

UA = 'Mozilla/5.0 (ldnmap parking data build)'
URL = 'https://www.bexley.gov.uk/services/parking-transport-and-streets/parking-restrictions-bexley/controlled-parking-zones-cpz'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parking_lists', 'bexley.json')
AREA_CODE = {
    'Bexleyheath Town Centre': 'A', 'Sidcup Station': 'B', 'Welling Station': 'D', 'Crayford Station': 'E',
    'Erith Station': 'ER', 'Falconwood Station': 'F', 'Bexleyheath Station': 'G', 'Bexley Station': 'H',
    'Albany Park Station': 'J', 'Barnehurst Station': 'K', 'New Eltham Station': 'N', 'Pinnacle Hill': 'P',
    'Sidcup Town Centre': 'S', 'Welling Town Centre': 'W', 'West Sidcup': 'WS', 'Abbey Wood Station': 'AW',
}


def main(path=None):
    page = open(path, errors='ignore').read() if path else \
        subprocess.run(['curl', '-s', '-L', '-m', '60', '-A', UA, URL], capture_output=True).stdout.decode('utf-8', 'replace')
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', page, re.S)
    cells = [[re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', c))).strip()
              for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, re.S)] for r in rows]
    zones, unknown = {}, set()
    for c in cells:
        if len(c) < 3 or c[0] == 'Road':
            continue
        road, area, props = c[0], c[1], c[2]
        code = AREA_CODE.get(area)
        if not code:
            unknown.add(area)
            continue
        zones.setdefault(code, []).append(road if props.lower() == 'all' else f'{road} (part: {props})')
    json.dump(zones, open(OUT, 'w'), indent=1, ensure_ascii=False)
    print(f'{len(zones)} zones, {sum(len(v) for v in zones.values())} roads -> {OUT}; unknown areas: {sorted(unknown)}')


if __name__ == '__main__':
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else None)
