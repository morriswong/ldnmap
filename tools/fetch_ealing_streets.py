#!/usr/bin/env python3
"""Fetch Ealing's CPZ street lists into tools/parking_lists/ealing.json ({zone code: [street entries]}).

Each zone page on ealing.gov.uk lists the streets in the zone under "List of streets affected" (or
"Street affected"); pages covering two zones split the list under "Zone C" / "Zone D" headings.
"""
import html, json, os, re, subprocess

UA = 'Mozilla/5.0 (ldnmap parking data build)'
INDEX = 'https://www.ealing.gov.uk/info/201333/controlled_parking_zone_cpz'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parking_lists', 'ealing.json')


def get(url):
    return subprocess.run(['curl', '-s', '-L', '-m', '60', '-A', UA, url], capture_output=True).stdout.decode('utf-8', 'replace')


def lines(page):
    body = re.search(r'<main.*?</main>', page, re.S) or re.search(r'<body.*', page, re.S)
    text = html.unescape(re.sub(r'<[^>]+>', '\n', body.group(0))).replace('\xa0', ' ')
    return [re.sub(r'\s+', ' ', l).strip() for l in text.split('\n') if l.strip()]


def main():
    idx = get(INDEX)
    links = sorted(set(re.findall(r'href="((?:https://www\.ealing\.gov\.uk)?/info/201333/controlled_parking_zone_cpz/\d+/[^"]+)"', idx)))
    zones = {}
    for link in links:
        url = link if link.startswith('http') else 'https://www.ealing.gov.uk' + link
        ls = lines(get(url))
        title = next(l for l in ls if re.match(r'Zones? ', l))
        codes = re.findall(r'\b([A-Z]{1,3}\d?(?:-I)?)\b', re.sub(r'^Zones?\s+', '', title).split(' ')[0] + ' ' + ' '.join(re.findall(r'\b(?:and)\s+([A-Z]{1,3}\d?)\b', title)))
        start = next((i for i, l in enumerate(ls) if re.match(r'(List of )?streets? affected', l, re.I)), None)
        if start is None:
            continue
        current = codes[0]
        for l in ls[start + 1:]:
            if l.startswith('Council Services'):
                break
            m = re.fullmatch(r'Zone ([A-Z]{1,3}\d?)', l)
            if m:
                current = m.group(1)
                continue
            zones.setdefault(current, []).append(l)
        for c in codes:
            zones.setdefault(c, [])
    json.dump(zones, open(OUT, 'w'), indent=1, ensure_ascii=False)
    print(f'{len(zones)} zones, {sum(len(v) for v in zones.values())} street entries -> {OUT}')
    print('empty:', [z for z, v in zones.items() if not v])


if __name__ == '__main__':
    main()
