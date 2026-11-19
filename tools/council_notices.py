#!/usr/bin/env python3
"""Traffic order notices from the councils' own websites, for boroughs that don't publish to the
DfT's D-TRO service yet. No dependencies.

This replaces reading the London Gazette, which refuses scripted requests. Each source below is a
council page or API that answers a plain request with an honest User-Agent and whose robots.txt
allows it. Sites that refuse such requests (a WAF or bot challenge) are listed in BLOCKED; nothing
here tries to get past one. The Public Notice Portal (newspaper notices) would cover most of them,
but its terms forbid automated access.

Usage:
  python3 tools/council_notices.py            every notice found, newest first
  python3 tools/council_notices.py --parking  only the ones that look like parking zone changes
"""
import datetime as dt
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request

UA = 'ldnmap-parking-check/1.0 (+https://ldnmap.pages.dev)'
DELAY = 1.5   # seconds between requests to one site
RBKC_DELAY = 5  # consult.rbkc.gov.uk asks for Crawl-delay: 5

# Borough id (parking_sources.json) -> why there is no scripted source.
BLOCKED = {
    'hf': 'lbhf.gov.uk answers scripts with an AWS WAF challenge',
    'camden': 'camden.gov.uk answers scripts with a Cloudflare challenge',
    'southwark': 'its order list is an AppyWay app whose API needs a key',
    'bd': 'lbbd.gov.uk refuses scripted requests (HTTP 403)',
    'bromley': 'bromley.gov.uk refuses scripted requests (HTTP 403)',
    'harrow': 'harrow.gov.uk refuses scripted requests (HTTP 403)',
    'havering': 'havering.gov.uk refuses scripted requests (HTTP 403)',
    'hillingdon': 'hillingdon.gov.uk refuses scripted requests (HTTP 403)',
}

# Titles that may change zone hours, days, max stays or prices.
PARKING = re.compile(r'parking|\bcpz\b|controlled|\bzones?\b|pay (?:and|&|by) (?:display|phone)|charges?\b|'
                     r'tariff|permits?\b|max(?:imum)? stay', re.I)
# Titles that don't: temporary orders, events, off-street and estate car parks, single-purpose bays.
NOT_PARKING = re.compile(r'\b(?:temporary|closures?|suspensions?|events?|fireworks|remembrance|street part(?:y|ies)|'
                         r'fete|festival|pedestrian zones?|cycle|cycling|bikes?|e-scooters?|school streets?|disabled|'
                         r'housing|estates?|off[- ]street|car club|ev|electric vehicles?|anti[- ]terror(?:ism)?|'
                         r'micromobility|trees?|social care|budget)\b', re.I)


class SourceError(Exception):
    pass


_last = {}


def fetch(url, delay=DELAY):
    host = url.split('/')[2]
    wait = _last.get(host, 0) + delay - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last[host] = time.monotonic()
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        raise SourceError(f'HTTP {e.code} from {url}') from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise SourceError(f'{url}: {e}') from e


def text(fragment):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', fragment))).strip()


def notice(borough, id, title, date, url, kind=''):
    """date: a datetime.date, or None when the source gives none (the notice is listed while current)."""
    return {'borough': borough, 'id': str(id), 'title': title, 'date': date, 'url': url, 'kind': kind}


def dmy(s, fmt):
    return dt.datetime.strptime(s.strip(), fmt).date()


def loose_date(s):
    """The last date in s ('7/8 November 2026', '03/02/2022', '19/11/26'), or None."""
    m = re.search(r'(\d{1,2}) ([A-Za-z]+) (\d{4})\s*$', s)
    try:
        if m:
            return dmy(' '.join(m.groups()), '%d %B %Y')
        m = re.search(r'(\d{1,2}/\d{1,2}/\d{2,4})\s*$', s)
        if m:
            return dmy(m.group(1), '%d/%m/%Y' if len(m.group(1).split('/')[2]) == 4 else '%d/%m/%y')
    except ValueError:
        pass
    return None


def rows(raw, table_re):
    m = re.search(table_re, raw, re.S)
    if not m:
        raise SourceError('notice table not found (page layout changed?)')
    for r in re.findall(r'<tr[^>]*>(.*?)</tr>', m.group(0), re.S):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', r, re.S)
        if cells:
            yield cells, re.findall(r'href="([^"]+)"', r)


# --- one parser per source: raw page -> [notice] -------------------------------------------------

RICHMOND = 'https://www.richmond.gov.uk/public_notices'


def parse_richmond(raw):
    out = []
    for c, links in rows(raw, r'<table[^>]*id="results".*?</table>'):
        date, ref, subject, kind, status, area = (text(x) for x in c[:6])
        out.append(notice('richmond', ref, f'{subject}: {area} ({kind}, {status.lower()})', dmy(date, '%d/%m/%y'),
                          html.unescape(links[0]) if links else RICHMOND, kind))
    return out


WESTMINSTER = 'https://www.westminstertransportationservices.co.uk/tmo/'
WESTMINSTER_LISTS = {'1': 'proposed', '2': 'made', '3': 'experimental', '6': 'variation'}


def parse_westminster(raw, stage):
    out = []
    for id, cid, title in re.findall(r'tmo_details\.php\?tt=2&(?:amp;)?id=(\d+)&(?:amp;)?cid=(\d+)"[^>]*>(.*?)</a>', raw, re.S):
        out.append(notice('westminster', id, f'{text(title)} ({stage})', None,
                          f'{WESTMINSTER}tmo_details.php?tt=2&id={id}&cid={cid}', stage))
    return out


RBKC = 'https://consult.rbkc.gov.uk/api/2.4/json_search_results'


def parse_rbkc(raw):
    return [notice('rbkc', x['id'], x['title'].strip(), dmy(x['startdate'], '%Y/%m/%d'), x['url'])
            for x in json.loads(raw) if x.get('startdate')]


CITY = 'https://www.cityoflondon.gov.uk/services/streets/traffic-order-consultations'


def parse_city(raw):
    out = []
    for href, title, date in re.findall(r'card"><a [^>]*href="([^"]+)"><h2[^>]*>(.*?)</h2></a><span class="info">'
                                        r'<span>Date created:(?:<!-- -->|\s)*([\d/]+)', raw):
        out.append(notice('city', href.rstrip('/').split('/')[-1], text(title), dmy(date, '%d/%m/%Y'),
                          'https://www.cityoflondon.gov.uk' + href))
    return out


ISLINGTON = 'https://www.islington.gov.uk/parking/traffic-management-orders'


def parse_islington(raw):
    """Experimental orders (dated), plus the consolidated charged-for parking places order: its link's
    `hash=` changes whenever the order is amended, which is reported as a notice with that hash."""
    body = re.sub(r'<script.*?</script>', ' ', raw, flags=re.S)
    out = []
    for block in re.split(r'<h3[^>]*>', body)[1:]:
        title = text(block.split('</h3>')[0])
        m = re.search(r'Start date:\s*(?:</?\w+[^>]*>\s*)*(\d{1,2} \w+ \d{4})', block)
        if m:
            orders = ' '.join(text(t) for t in re.findall(r'>(The Islington \([^<]*)<', block))
            out.append(notice('islington', 'eto-' + re.sub(r'\W+', '-', title.lower()).strip('-')[:60],
                              f'{title} (experimental order; {orders})' if orders else f'{title} (experimental order)',
                              dmy(m.group(1), '%d %B %Y'), ISLINGTON, 'experimental'))
    m = re.search(r'href="([^"]*charged-pps-as-amended\.pdf[^"]*hash=([0-9A-F]+)[^"]*)"', raw)
    if not m:
        raise SourceError('charged-for parking places order link not found (page layout changed?)')
    out.append(notice('islington', 'charged-pps-' + m.group(2)[:8], 'Charged-for parking places order amended',
                      None, html.unescape(m.group(1)), 'consolidation'))
    return out


BRENT = 'https://brent.traffweb.app/traffweb/2/Haveyoursay'


def parse_brent(raw):
    out, seen = [], set()
    for sid, block in re.findall(r'id="schemehead_(\d+)"(.*?)(?=id="schemehead_|\Z)', raw, re.S):
        if sid in seen:
            continue
        seen.add(sid)
        name = re.search(r'data-schemename="([^"]*)"', block)
        m = re.search(r'Advertised from\s*(?:<[^>]+>\s*)*(\d{2}/\d{2}/\d{4})', block)
        doc = re.search(r'href="(https://store\.traffweb\.app/brent/[^"]+)"', block)
        out.append(notice('brent', sid, html.unescape(name.group(1)) if name else f'Scheme {sid}',
                          dmy(m.group(1), '%d/%m/%Y') if m else None, doc.group(1) if doc else BRENT))
    return out


MERTON = ['https://www.merton.gov.uk/streets-parking-transport/traffic-management/consultations',
          'https://www.merton.gov.uk/streets-parking-transport/parking/consultations/cpz']


def parse_merton(raw):
    out = []
    for c, links in rows(raw, r'<table.*?</table>'):
        if len(c) < 2:
            continue
        title, when = text(c[0]), text(c[1])
        try:
            first = dmy('1 ' + when, '%d %B %Y')
        except ValueError:
            continue
        last = (first.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
        url = links[0] if links else MERTON[0]
        out.append(notice('merton', hashlib.sha1(url.encode()).hexdigest()[:10], title, last, url))  # month only
    return out


EALING = 'https://haveyoursay.ealing.gov.uk/web_api/v1/projects?page%5Bsize%5D=50'


def parse_ealing(raw):
    out = []
    for x in json.loads(raw)['data']:
        a = x['attributes']
        title = (a.get('title_multiloc') or {}).get('en-GB') or a.get('slug')
        out.append(notice('ealing', a['slug'], f'{title} (consultation)', dt.date.fromisoformat(a['created_at'][:10]),
                          f'https://haveyoursay.ealing.gov.uk/en-GB/projects/{a["slug"]}', 'consultation'))
    return out


WANDSWORTH = 'https://www.wandsworth.gov.uk/roads-and-transport/road-safety/traffic-management-orders-tmos/'


def parse_wandsworth(raw):
    out = []
    for c, links in rows(raw, r'<table.*?</table>'):
        if len(c) < 5:
            continue
        date, ref, subject, kind, status = (text(x) for x in c[:5])
        d = loose_date(date)
        if not d:
            continue
        url = links[0] if links else WANDSWORTH
        out.append(notice('wandsworth', ref, f'{subject} ({kind}, {status.lower()})', d,
                          url if url.startswith('http') else 'https://www.wandsworth.gov.uk' + url, kind))
    return out


def sources():
    """[(borough id, label, callable returning [notice])]"""
    return [
        ('richmond', 'public notices', lambda: parse_richmond(fetch(RICHMOND))),
        ('westminster', 'TMO notices', lambda: [n for cid, stage in WESTMINSTER_LISTS.items()
                                                for n in parse_westminster(fetch(f'{WESTMINSTER}tmo_list.php?tt=2&cid={cid}'), stage)]),
        ('rbkc', 'consultations', lambda: parse_rbkc(fetch(RBKC, RBKC_DELAY))),
        ('city', 'traffic order consultations', lambda: parse_city(fetch(CITY))),
        ('islington', 'traffic management orders', lambda: parse_islington(fetch(ISLINGTON))),
        ('brent', 'Traffweb consultations', lambda: parse_brent(fetch(BRENT))),
        ('merton', 'consultations', lambda: [n for u in MERTON for n in parse_merton(fetch(u))]),
        ('ealing', 'consultations', lambda: parse_ealing(fetch(EALING))),
        ('wandsworth', 'TMO list', lambda: parse_wandsworth(fetch(WANDSWORTH))),
    ]


def is_parking(n):
    if n['kind'].lower() == 'temporary':
        return False
    if n['kind'] == 'consolidation':
        return True
    return bool(PARKING.search(n['title'])) and not NOT_PARKING.search(n['title'])


def collect(log=lambda s: print(s, file=sys.stderr)):
    """(notices, failures): every source's notices, and [(borough, error)] for sources that failed
    or returned nothing (a layout change looks like an empty list)."""
    found, failures = [], []
    for bid, label, run in sources():
        try:
            got = run()
        except (SourceError, ValueError, KeyError) as e:
            failures.append((bid, f'{label}: {e}'))
            log(f'  councils: {bid} {label}: FAILED: {e}')
            continue
        if not got:
            failures.append((bid, f'{label}: no notices parsed (page layout changed?)'))
        log(f'  councils: {bid} {label}: {len(got)} notices, {sum(map(is_parking, got))} about parking')
        found += got
    return found, failures


def main(argv):
    found, failures = collect()
    if '--parking' in argv:
        found = [n for n in found if is_parking(n)]
    for n in sorted(found, key=lambda n: (n['date'] or dt.date.max), reverse=True):
        print(f'{str(n["date"] or "current"):10}  {n["borough"]:11} {n["title"][:90]}\n{"":23}{n["url"]}')
    for bid, reason in BLOCKED.items():
        print(f'no source: {bid}: {reason}', file=sys.stderr)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
