#!/usr/bin/env python3
"""Build data/parking/ for the parking layer, for every borough in tools/parking_sources.json.

Not part of the site: run it by hand when the data needs refreshing. The page only fetches
the files it writes.

    python3 -m venv /tmp/pv && /tmp/pv/bin/pip install shapely pyproj pyshp
    /tmp/pv/bin/python tools/build_parking.py            # every borough
    /tmp/pv/bin/python tools/build_parking.py hf camden  # some boroughs (others are kept)

Writes:
  data/parking/rules.json          boroughs + one rule per zone/street rule ("<borough>:<zone>")
  data/parking/zones.geojson       every zone polygon (properties: b, zone, rule, lx, ly)
  data/parking/<borough>/streets.geojson, kerb.geojson, machines.geojson  (loaded on demand)

Sources per borough are in tools/parking_sources.json: a polygon service (ArcGIS REST, WFS,
GeoJSON or zipped Shapefile) and the council's hours text per zone, parsed into periods by
tools/parking_hours.py. Streets, kerbs and ticket machines come from OpenStreetMap.
"""
import html
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

from pyproj import Transformer
from shapely.geometry import shape, mapping, Point, LineString, MultiPolygon, Polygon
from shapely.ops import transform, unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parking_hours import parse_hours  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'data', 'parking')
SOURCES = os.path.join(ROOT, 'tools', 'parking_sources.json')
CACHE = os.environ.get('PARKING_CACHE', '/tmp/ldnmap-parking-cache')
UA = 'Mozilla/5.0 (ldnmap parking data build)'
OSM_UA = 'ldnmap-parking-build/1.0 (+https://ldnmap.pages.dev)'   # Overpass refuses browser-like agents
OVERPASS = 'https://overpass-api.de/api/interpreter'

CLS = {'motorway': 1, 'trunk': 1, 'primary': 1, 'secondary': 2, 'tertiary': 3,
       'unclassified': 4, 'residential': 4, 'living_street': 4, 'service': 5}
BAY = {'lane', 'street_side', 'on_kerb', 'half_on_kerb', 'shoulder', 'yes',
       'parallel', 'diagonal', 'perpendicular', 'marked'}
TO_WGS84 = {}


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, name, data=None, ua=UA):
    """GET (or POST `data`) a URL, cached in CACHE under `name`."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        # curl rather than urllib: the system Python's TLS can't talk to some servers (Overpass).
        import subprocess
        cmd = ['curl', '-sS', '-L', '--compressed', '-m', '600', '-A', ua, '-H', 'Accept: */*', '-o', path + '.part', url]
        if data is not None:
            cmd += ['--data-binary', '@-']
        res = subprocess.run(cmd, input=data, capture_output=True)
        if res.returncode != 0:
            raise SystemExit(f'download failed: {url}\n{res.stderr.decode()}')
        os.replace(path + '.part', path)
    with open(path, 'rb') as f:
        return f.read()


def fetch_json(url, name, data=None, ua=UA):
    return json.loads(fetch(url, name, data, ua).decode('utf-8-sig'))


def overpass(query, name):
    """Overpass answers; a busy server returns HTML or an error document, so retry a few times."""
    import time
    data = urllib.parse.urlencode({'data': query}).encode()
    for attempt in range(4):
        try:
            d = fetch_json(OVERPASS, name, data, OSM_UA)
            if 'elements' in d:
                return d['elements']
            msg = str(d)[:200]
        except json.JSONDecodeError:
            msg = open(os.path.join(CACHE, name), 'rb').read(200)
        os.remove(os.path.join(CACHE, name))
        log(f'  Overpass answer for {name} unusable (attempt {attempt + 1}): {msg!r}')
        time.sleep(30 * (attempt + 1))
    raise RuntimeError(f'Overpass kept failing for {name}')


def reproject(geom, epsg):
    if epsg in (4326, None):
        return geom
    if epsg not in TO_WGS84:
        TO_WGS84[epsg] = Transformer.from_crs(f'EPSG:{epsg}', 'EPSG:4326', always_xy=True).transform
    return transform(TO_WGS84[epsg], geom)


def r5(geom):
    """Round coordinates to 5 dp (about 1 m) to keep the files small."""
    def walk(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 5), round(c[1], 5)]
        return [walk(x) for x in c]
    g = mapping(geom)
    return {'type': g['type'], 'coordinates': walk(g['coordinates'])}


def lines(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == 'LineString':
        return [geom]
    if hasattr(geom, 'geoms'):
        return [g for part in geom.geoms for g in lines(part)]
    return []


def polygons_only(geom):
    if geom.geom_type in ('Polygon', 'MultiPolygon'):
        return geom
    if hasattr(geom, 'geoms'):
        parts = [g for g in geom.geoms if g.geom_type in ('Polygon', 'MultiPolygon')]
        return unary_union(parts) if parts else Polygon()
    return Polygon()


def feature(geom, props):
    return {'type': 'Feature', 'properties': props, 'geometry': r5(geom)}


def write(path, features):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    log(f'  {os.path.relpath(path, OUT)}: {len(features)} features, {os.path.getsize(path) // 1024} KB')


# ---------------------------------------------------------------------------
# Zone polygons
# ---------------------------------------------------------------------------

def load_polygons(bid, src):
    """[(zone code, shapely polygon in WGS84, attributes)] from the borough's polygon source."""
    kind = src['type']
    zone_field = src.get('zoneField')
    feats = []
    if kind == 'arcgis':
        # Page through the layer; big layers exceed one request's transfer limit.
        offset = 0
        while True:
            q = (f"{src['url']}/query?where={urllib.parse.quote(src.get('where', '1=1'))}&outFields=*"
                 f"&outSR=4326&resultOffset={offset}&resultRecordCount=1000&f=geojson")
            d = fetch_json(q, f'{bid}-polys-{offset}.geojson')
            feats += d.get('features', [])
            if not d.get('properties', {}).get('exceededTransferLimit') and len(d.get('features', [])) < 1000:
                break
            offset += len(d['features'])
        epsg = None
    elif kind == 'geojson':
        d = fetch_json(src['url'], f'{bid}-polys.geojson')
        feats = d['features']
        epsg = src.get('epsg')
    elif kind == 'wfs':
        sep = '&' if '?' in src['url'] else '?'
        q = (f"{src['url']}{sep}service=WFS&version=2.0.0&request=GetFeature&typeNames={src['layer']}"
             f"&outputFormat={urllib.parse.quote(src.get('format', 'application/json'))}&srsName=EPSG:4326")
        d = fetch_json(q, f'{bid}-polys.geojson')
        feats = d['features']
        epsg = src.get('epsg')
    elif kind == 'file':
        # A file in the cache dir made by hand or by another tool (e.g. the Enfield KML, which sits
        # behind a browser check): GeoJSON.
        with open(os.path.join(CACHE, src['path'])) as f:
            feats = json.load(f)['features']
        epsg = src.get('epsg')
    elif kind == 'drupal-settings':
        # GeoJSON embedded in a Drupal page's settings JSON (Greenwich).
        page = fetch(src['url'], f'{bid}-page.html').decode('utf-8', 'replace')
        m = re.search(r'<script[^>]*data-drupal-selector="drupal-settings-json"[^>]*>(.*?)</script>', page, re.S)
        d = json.loads(html.unescape(m.group(1)))
        for part in src['path'].split('.'):
            d = d[part]
        if isinstance(d, str):
            d = json.loads(d)
        feats = d['features']
        epsg = src.get('epsg')
    elif kind == 'redbridge':
        # The council's own web-map JSON: polygons as lat/lng rings, hours in a description.
        items = fetch_json(src['url'], f'{bid}-polys.json')
        feats = []
        for it in items:
            polys = []
            for poly in (it.get('geometry') or {}).get('polygons') or []:
                rings = [[(pt['lng'], pt['lat']) for pt in poly['outerRing']]]
                for hole in poly.get('holes') or []:
                    rings.append([(pt['lng'], pt['lat']) for pt in hole])
                polys.append(rings)
            if polys:
                feats.append({'properties': {'title': it.get('title'), 'description': it.get('description')},
                              'geometry': {'type': 'MultiPolygon', 'coordinates': polys}})
        epsg = None
    elif kind == 'appyway':
        # AppyWay "Streets" public snapshot (the council's restrictions map): zone polygons plus
        # structured operating hours in the companion sets file.
        return appyway_zones(bid, src)
    elif kind == 'streets':
        # Zones published as lists of streets: draw each zone as its streets (OpenStreetMap).
        return street_zones(bid, src)
    elif kind == 'gml':
        # A WFS GetFeature answer in GML 3.2 (MapServer/iShare), geometry as gml:posList.
        feats, epsg = parse_gml(fetch(src['url'], f'{bid}-polys.gml'))
    elif kind == 'shapefile':
        import shapefile
        raw = fetch(src['url'], f'{bid}-polys.zip')
        zf = zipfile.ZipFile(io.BytesIO(raw))
        base = [n for n in zf.namelist() if n.lower().endswith('.shp')][0][:-4]
        rd = shapefile.Reader(shp=io.BytesIO(zf.read(base + '.shp')), dbf=io.BytesIO(zf.read(base + '.dbf')),
                              shx=io.BytesIO(zf.read(base + '.shx')))
        feats = [{'properties': r.record.as_dict(), 'geometry': r.shape.__geo_interface__} for r in rd.iterShapeRecords()]
        epsg = src.get('epsg', 27700)
    else:
        raise SystemExit(f'{bid}: unknown polygon source type {kind}')

    out = []
    for f in feats:
        if not f.get('geometry'):
            continue
        props = f.get('properties') or {}
        code = str(props.get(zone_field, '') or '').strip() if zone_field else ''
        if src.get('zonePattern'):
            m = re.search(src['zonePattern'], code)
            code = m.group(1) if m else code
        code = src.get('zoneMap', {}).get(code, code)
        if src.get('zoneConst'):
            code = src['zoneConst']
        if not code or code.lower() in ('none', 'null'):
            continue
        g = reproject(shape(f['geometry']), epsg).buffer(0)
        out.append((code, polygons_only(g), props))
    return out


# ---------------------------------------------------------------------------
# Zones from an AppyWay public snapshot
# ---------------------------------------------------------------------------

APPY_DAYS = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0}       # AppyWay Mon=1 … Sun=7 -> ours Sun=0
APPY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


def appyway_zones(bid, src):
    zones = fetch_json(src['zones'], f'{bid}-appyway-zones.geojson')['features']
    sets = {x['setId']: x for x in fetch_json(src['sets'], f'{bid}-appyway-sets.json')['operatingHoursSets']}
    keep = set(src.get('types', [1, 9]))

    def periods_of(set_id):
        rules = (sets.get(set_id) or {}).get('operatingHours', {}).get('standardDays', [])
        per, text, stay = [], [], None
        for r in rules:
            rt = r['ruleTime']
            days = sorted(APPY_DAYS[d] for d in rt['days'])
            for h in rt['hours']:
                a, b = h['start'][:5], h['end'][:5]
                if b == '00:00':
                    b = '24:00'
                if a < b:
                    per.append({'days': days, 'from': a, 'to': b})
            label = _day_span(rt['days'])
            text.append(label + ' ' + ', '.join(f"{_hm(h['start'])}–{_hm(h['end'])}" for h in rt['hours']))
            if r.get('maxStay'):
                stay = r['maxStay']
        return per, '; '.join(text), stay

    out = []
    for f in zones:
        p = f['properties']
        if p.get('type') not in keep or not f.get('geometry'):
            continue
        details = {d['restrictionTypeId']: d for d in p.get('restrictionTypeDetails', [])}
        name = re.sub(r'^(zone)\s+', '', p['name'].strip(), flags=re.I)
        m = re.search(r'\(([A-Z]{1,3}\d?)\)$', name)
        code = m.group(1) if m else name
        props = {'name': p['name'].strip()}
        if p['type'] == 9:                      # permit parking area: permit holders only
            d = details.get(4) or details.get(1)
            props['permitOnly'] = True
        else:                                   # CPZ: the controlled hours (single yellow lines, pay bays)
            d = details.get(1) or details.get(4)
        if not d or not d.get('operatingHoursSet'):
            continue
        per, text, stay = periods_of(d['operatingHoursSet'][0]['setId'])
        props.update({'hours': text, 'periods': per})
        if stay:
            props['maxStay'] = f'{stay // 60} hours' if stay % 60 == 0 and stay >= 120 else (f'{stay} minutes' if stay < 60 else f'{stay // 60} hour' + ('' if stay == 60 else f' {stay % 60} minutes'))
        out.append((code, polygons_only(shape(f['geometry']).buffer(0)), props))
    return out


def _hm(t):
    h, m = int(t[:2]), int(t[3:5])
    suffix = 'am' if h < 12 or h == 24 else 'pm'
    h12 = h % 12 or 12
    return f'{h12}{":%02d" % m if m else ""}{suffix}' if t[:5] not in ('12:00', '00:00') else ('noon' if t[:5] == '12:00' else 'midnight')


def _day_span(days):
    days = sorted(days)
    if days == list(range(days[0], days[-1] + 1)) and len(days) > 2:
        return f'{APPY_NAMES[days[0]]}–{APPY_NAMES[days[-1]]}'
    return ', '.join(APPY_NAMES[d] for d in days)


# ---------------------------------------------------------------------------
# Zones from street lists
# ---------------------------------------------------------------------------

STREET_BUFFER_M = 18          # half-width of a drawn street zone (metres)
PARTIAL_RE = re.compile(r'\b(numbers?|odd|even|between|junction|side|part|from|excluding|only|including flat)\b', re.I)


LOCALITIES = r'(hanwell|acton|greenford|southall|perivale|northolt|ealing|park royal|chiswick|brentford)'


def norm_street(name):
    n = name.lower().replace('’', "'").replace('‘', "'")
    n = re.sub(r"\s+'", "'", n)                          # "Queen Anne 's Grove"
    n = re.sub(r'^[ab]\d+\s+', '', n)                     # "A40 Western Avenue"
    n = re.sub(r'\s+' + LOCALITIES + r'$', '', n)           # "George Street Hanwell"
    n = re.sub(r"\bst\.?\s", 'st ', n)
    n = re.sub(r"[^a-z0-9 ]", '', n)
    return re.sub(r'\s+', ' ', n).strip()


def parse_street_entry(entry):
    """('Mattock Lane', partial?) from 'Mattock Lane, W5 (between … numbers 1 to 36)'."""
    e = entry.strip().rstrip('.')
    detail = ''
    m = re.search(r'\(', e)
    if m:
        detail = e[m.start():]
        e = e[:m.start()]
    name = re.split(r',', e)[0]
    name = re.sub(r'\s+(W\d+|NW\d+|UB\d+|SW\d+|SE\d+|TW\d+|KT\d+|CR\d+|BR\d+|DA\d+|E\d+|N\d+)\b.*$', '', name).strip()
    partial = bool(detail and PARTIAL_RE.search(detail)) or bool(re.search(r'\b(east|west|north|south) to (east|west|north|south)\b', detail, re.I))
    return name, partial


def street_zones(bid, src):
    """[(zone code, polygon, props)] for zones given as {code: [street entries]} in src['lists']."""
    import json as _json
    lists = src['lists'] if isinstance(src['lists'], dict) else _json.load(open(os.path.join(ROOT, src['lists'])))
    to_bng = Transformer.from_crs('EPSG:4326', 'EPSG:27700', always_xy=True).transform
    to_wgs = Transformer.from_crs('EPSG:27700', 'EPSG:4326', always_xy=True).transform
    boundary = transform(to_bng, borough_boundary(src['borough']))
    w, s, e, n = transform(to_wgs, boundary).bounds
    ways = overpass(f'[out:json][timeout:300];way["highway"]["name"]({s},{w},{n},{e});out tags geom;',
                    f'{bid}-named-ways.json')
    by_name = {}
    for w_ in ways:
        if 'geometry' not in w_ or len(w_['geometry']) < 2:
            continue
        line = transform(to_bng, LineString([(p['lon'], p['lat']) for p in w_['geometry']]))
        if not line.intersects(boundary):
            continue
        by_name.setdefault(norm_street(w_['tags']['name']), []).append(line.intersection(boundary))
    # Same-named roads in different places: split each name into clusters 300 m apart.
    clusters = {}
    for nm, ls in by_name.items():
        groups = []
        for l in ls:
            hit = [g for g in groups if g.distance(l) < 300]
            merged = unary_union(hit + [l])
            groups = [g for g in groups if g not in hit] + [merged]
        clusters[nm] = groups
    out, missing = [], []
    parsed = {z: [parse_street_entry(x) for x in entries] for z, entries in lists.items()}

    def anchor_of(z):
        # median position of the zone's short, unambiguous streets (long roads cross many zones)
        a = [clusters[norm_street(nm)][0] for nm, part in parsed.get(z, [])
             if len(clusters.get(norm_street(nm), [])) == 1]
        a = [g for g in a if g.length < 1200]
        if not a:
            return None
        xs = sorted(g.centroid.x for g in a); ys = sorted(g.centroid.y for g in a)
        return Point(xs[len(xs) // 2], ys[len(ys) // 2])

    for z, entries in parsed.items():
        # names with a single place in the borough fix where the zone is; failing that, a parent
        # zone's (MM1 -> MM); failing that, same-named streets are skipped rather than guessed
        centre = anchor_of(z)
        if centre is None:
            parent = re.sub(r'\d+$', '', z)
            centre = anchor_of(parent) if parent != z else None
        full, partial = [], []
        for nm, part in entries:
            cl = clusters.get(norm_street(nm))
            if not cl:
                missing.append(f'{z}: {nm}')
                continue
            if len(cl) > 1 and centre is None:
                missing.append(f'{z}: {nm} (several in the borough, nothing to place it by)')
                continue
            g = cl[0] if len(cl) == 1 else min(cl, key=lambda c: c.distance(centre))
            if centre is not None and g.distance(centre) > 2500:
                missing.append(f'{z}: {nm} (nearest is {g.distance(centre):.0f} m away)')
                continue
            (partial if part else full).append(g)
        if not full and not partial:
            continue
        core = unary_union(full) if full else None
        if core is not None and partial:
            near = core.buffer(150).convex_hull.buffer(50)
            partial = [g.intersection(near) for g in partial]
        lines = unary_union([g for g in full + partial if not g.is_empty])
        area = transform(to_wgs, lines.buffer(STREET_BUFFER_M, cap_style=2))
        out.append((z, area, {'streets': len(entries)}))
    if missing:
        log(f'  {len(missing)} listed streets not matched: ' + '; '.join(missing[:25]) + (' …' if len(missing) > 25 else ''))
    return out


GML = '{http://www.opengis.net/gml/3.2}'


def parse_gml(raw):
    """[GeoJSON-like features] and the EPSG code from a WFS 2.0 GML FeatureCollection."""
    root = ET.fromstring(raw)
    epsg = None
    feats = []
    for member in root.iter():
        if not member.tag.endswith('}member'):
            continue
        el = list(member)[0]
        props, polys = {}, []
        for child in el:
            tag = child.tag.split('}')[-1]
            if tag == 'boundedBy':
                continue
            if any(g.tag in (GML + 'posList',) for g in child.iter()):
                for poly in child.iter(GML + 'Polygon'):
                    rings = []
                    for ring_tag in ('exterior', 'interior'):
                        for ring in poly.iter(GML + ring_tag):
                            nums = ring.find('.//' + GML + 'posList').text.split()
                            rings.append([(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums), 2)])
                    polys.append(rings)
                srs = next((g.get('srsName') for g in child.iter() if g.get('srsName')), None)
                if srs:
                    epsg = int(re.search(r'(\d+)$', srs).group(1))
            else:
                props[tag] = (child.text or '').strip()
        if polys:
            feats.append({'properties': props, 'geometry': {'type': 'MultiPolygon', 'coordinates': polys}})
    return feats, epsg


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

def data_hours(b, props):
    """(hours text, note) read from a polygon's attributes, per the borough's hoursFromData."""
    cfg = b.get('hoursFromData')
    if not cfg:
        return None, None
    if cfg.get('template'):
        # "Mon-Fri {a}; Sat {b}": segments whose field is blank are dropped.
        parts = []
        for seg in cfg['template'].split(';'):
            m = re.search(r'\{(\w+)\}', seg)
            v = str(props.get(m.group(1)) or '').strip() if m else ''
            if v and v.lower() != 'none':
                parts.append(seg.replace(m.group(0), v).strip())
        text = '; '.join(parts)
    else:
        text = cfg.get('join', ' ').join(str(props.get(f) or '').strip() for f in cfg['fields']
                                         if str(props.get(f) or '').strip().lower() != 'none').strip()
    for pat, repl in cfg.get('replace', []):
        text = re.sub(pat, repl, text)
    note = None
    if cfg.get('noteRegex'):
        # Everything from the match on is a note ("…, and on event days: …"), not the normal hours.
        m = re.search(cfg['noteRegex'], text, re.I)
        if m:
            text, note = text[:m.start()], text[m.start():].strip(' ,;.') + '.'
    if cfg.get('noteAfter') and cfg['noteAfter'] in text:
        text, note = text.split(cfg['noteAfter'], 1)
        note = re.sub(r'\s*' + re.escape(cfg['noteAfter']) + r'\s*', '. ', note).strip(' .') + '.'
    text = re.sub(r'\s+', ' ', text).strip()
    extra = [str(props.get(f) or '').strip() for f in cfg.get('noteFields', [])]
    extra = [e for e in extra if e and e.lower() != 'none']
    if extra:
        note = ' '.join(([note] if note else []) + [e if e.endswith('.') else e + '.' for e in extra])
    return (text or None), note


def zones_from_polygons(bid, b, polys):
    """{zone code: {'geom', 'name', 'hours', 'note', 'url'}} from the polygon features. Polygons with the
    same code are merged; if they carry different hours the code gets a suffix, so no polygon is
    shown with another one's hours."""
    src = b['polygons']
    groups = {}
    for code, g, props in polys:
        hours, note = data_hours(b, props)
        if props.get('hours') and not hours:
            hours = props['hours']
        name = str(props.get(src['nameField']) or '').strip() if src.get('nameField') else None
        if name and name.lower() == 'none':
            name = None
        for pat, repl in src.get('nameReplace', []):
            name = re.sub(pat, repl, name) if name else name
        url = str(props.get(src['urlField']) or '').strip() if src.get('urlField') else None
        extra = {k: props[k] for k in ('periods', 'permitOnly', 'maxStay') if k in props}
        groups.setdefault(code, []).append((hours, note, name, url, g, extra))
    zones = {}
    for code, items in groups.items():
        variants = []
        for hours, note, name, url, g, extra in items:
            key = (hours or '').lower()
            v = next((v for v in variants if v['key'] == key), None)
            if not v:
                v = {'key': key, 'hours': hours, 'note': note, 'name': name, 'url': url, 'geoms': [], 'extra': extra}
                variants.append(v)
            v['geoms'].append(g)
            if name and v['name'] and name != v['name'] and name not in v['name']:
                v['name'] = v['name'] + ' / ' + name
        for i, v in enumerate(variants):
            zcode = code if len(variants) == 1 else f'{code} ({i + 1})'
            zones[zcode] = {'geom': unary_union(v['geoms']), 'name': v['name'], 'hours': v['hours'],
                            'note': v['note'], 'url': v['url'], 'extra': v.get('extra', {})}
    return zones


def build_rules(bid, b, zone_info):
    """Rules for a borough: one per zone (hours from the sources file, else from the polygon data),
    plus street rules."""
    rules = {}
    zones = dict(b.get('zones', {}))
    for code, info in zone_info.items():
        z = dict(zones.get(code, {}))
        if z.get('hours') is None and info.get('hours'):
            z['hours'] = info['hours']
        for k in ('name', 'note', 'url'):
            if info.get(k) and not z.get(k):
                z[k] = info[k]
        for k, v in info.get('extra', {}).items():
            z.setdefault(k, v)
        zones[code] = z
    for code, z in zones.items():
        hours = z.get('hours')
        if hours is None:
            hours = 'Hours not published in a form this map can read. Check the signs or the council page.'
            periods = None
        elif 'periods' in z:
            periods = z['periods']
        else:
            periods = parse_hours(hours)
            if periods is None:
                log(f'  {bid}:{code}: could not read hours {hours!r}; shown as unknown')
        rule = {'borough': bid, 'zone': code, 'hours': hours, 'periods': periods}
        for k in ('maxStay', 'pdf', 'note', 'permit', 'permitOnly', 'event', 'url', 'name', 'unsure'):
            if z.get(k) not in (None, ''):
                rule[k] = z[k]
        if rule.get('event') and 'periods' not in rule['event']:
            rule['event'] = dict(rule['event'], periods=parse_hours(rule['event'].get('hours')))
        rules[f'{bid}:{code}'] = rule
    for key, s in b.get('specialStreets', {}).items():
        periods = s['periods'] if 'periods' in s else parse_hours(s['hours'])
        rule = {'borough': bid, 'zone': s['zone'], 'name': s['name'], 'streets': s['streets'],
                'hours': s['hours'], 'periods': periods}
        for k in ('maxStay', 'note', 'permit', 'permitOnly', 'pdf'):
            if s.get(k) not in (None, ''):
                rule[k] = s[k]
        rules[f'{bid}:{key}'] = rule
    return rules


# ---------------------------------------------------------------------------
# OpenStreetMap: streets, kerbs, machines
# ---------------------------------------------------------------------------

def kerb_kinds(t):
    """(side, kind) pairs from OSM street parking tags. side is 'left', 'right' or 'both'."""
    out = []
    for side in ('both', 'left', 'right'):
        v = t.get(f'parking:{side}') or t.get(f'parking:lane:{side}')
        restr = (t.get(f'parking:{side}:restriction') or t.get(f'parking:condition:{side}')
                 or (v if v in ('no_parking', 'no_stopping') else None))
        timed = any(k.startswith((f'parking:{side}:restriction:conditional',
                                  f'parking:condition:{side}:time_interval',
                                  f'parking:{side}:restriction:time')) for k in t)
        if restr in ('no_parking', 'no_stopping', 'no_standing'):
            out.append((side, 'single_yellow' if timed else 'double_yellow'))
        elif v in BAY:
            out.append((side, 'bay'))
    return out


def build_osm(bid, b, zones, rules):
    """streets/kerb/machines features for a borough from OpenStreetMap, clipped to its zones."""
    special = {}   # (zone, street name) -> rule key
    for key, r in rules.items():
        for name in r.get('streets', []):
            special[(r['zone'], name)] = key
    cover = unary_union(list(zones.values()))
    w, s, e, n = cover.bounds
    bbox = f'{s - 0.001},{w - 0.001},{n + 0.001},{e + 0.001}'
    ways = overpass(f'[out:json][timeout:300];way["highway"~"^({"|".join(CLS)})$"]({bbox});out tags geom;',
                    f'{bid}-streets.json')
    nodes = overpass(f'[out:json][timeout:120];nwr["vending"~"parking_tickets"]({bbox});out center tags;',
                     f'{bid}-machines.json')
    streets, kerb, machines = [], [], []
    for w_ in ways:
        t = w_['tags']
        hw = t['highway']
        if hw == 'service' and t.get('service') not in (None, 'alley'):
            continue  # driveways, car park aisles
        if t.get('area') == 'yes' or 'geometry' not in w_ or len(w_['geometry']) < 2:
            continue
        line = LineString([(p['lon'], p['lat']) for p in w_['geometry']])
        if not line.intersects(cover):
            continue
        tfl = t.get('operator') == 'Transport for London'
        name = t.get('name') or t.get('ref') or ''
        for z, zg in zones.items():
            if not line.intersects(zg):
                continue
            for piece in lines(line.intersection(zg)):
                if piece.length < 1e-5:
                    continue
                rule = special.get((z, name), f'{bid}:{z}')
                hook = b.get('streetHook')
                if hook:
                    rule = STREET_HOOKS[hook](bid, z, name, piece, rule, ways)
                props = {'name': name, 'zone': z, 'rule': rule, 'cls': CLS[hw]}
                if tfl:
                    props['tfl'] = 1
                streets.append(feature(piece, props))
                if not tfl:
                    for side, kind in kerb_kinds(t):
                        kerb.append(feature(piece, {'kind': kind, 'side': side, 'zone': z}))
    for m in nodes:
        lon, lat = (m['lon'], m['lat']) if 'lon' in m else (m['center']['lon'], m['center']['lat'])
        t = m.get('tags', {})
        if 'disused:amenity' in t:
            continue
        p = Point(lon, lat)
        z = next((z for z, zg in zones.items() if zg.contains(p)), None)
        if not z:
            continue
        cash = t.get('payment:coins') == 'yes' or t.get('payment:cash') == 'yes'
        cards = any(t.get(k) == 'yes' for k in ('payment:cards', 'payment:credit_cards',
                                                 'payment:debit_cards', 'payment:contactless'))
        mtype = 'Card & cash' if cash else ('Card only' if cards or t.get('payment:coins') == 'no' else 'Unknown')
        machines.append(feature(p, {'id': t.get('ref') or f'OSM {m["type"][0]}{m["id"]}', 'zone': z, 'type': mtype,
                                    'pdf': rules.get(f'{bid}:{z}', {}).get('pdf', '')}))
    named = {f['properties']['name'] for f in streets}
    for key, r in rules.items():
        gone = [n for n in r.get('streets', []) if n not in named]
        if gone:
            log(f'  {key}: not found in OpenStreetMap: {", ".join(gone)}')
    return streets, kerb, machines


def hf_river_hook(bid, z, name, piece, rule, ways):
    """H&F: only the parts of Rivercourt Road and Weltje Road north of the Great West Road are in
    the M special area."""
    if rule != 'hf:M-river' or name == 'Cromwell Avenue':
        return rule
    gwr = unary_union([LineString([(p['lon'], p['lat']) for p in w_['geometry']])
                       for w_ in ways if w_['tags'].get('name') == 'Great West Road' and 'geometry' in w_])
    c = piece.interpolate(0.5, normalized=True)
    near = [p for g in lines(gwr) for p in g.coords if c.x - 0.002 <= p[0] <= c.x + 0.002]
    return rule if not near or c.y > sum(p[1] for p in near) / len(near) else f'{bid}:{z}'


STREET_HOOKS = {'hf_river': hf_river_hook}


def borough_boundary(name):
    """A borough's outline from the London Datastore boundary shapefile (OGL; cached as
    London_Borough_Excluding_MHW.* in CACHE), in WGS84."""
    import shapefile
    rd = shapefile.Reader(os.path.join(CACHE, 'London_Borough_Excluding_MHW.shp'))
    for sr in rd.iterShapeRecords():
        if sr.record['NAME'] == name:
            return reproject(shape(sr.shape.__geo_interface__), 27700).buffer(0)
    raise SystemExit(f'no borough boundary called {name!r}')


# ---------------------------------------------------------------------------

def main(argv):
    src = json.load(open(SOURCES))
    boroughs = src['boroughs']
    wanted = argv or list(boroughs)
    unknown = [w for w in wanted if w not in boroughs]
    if unknown:
        raise SystemExit(f'not in parking_sources.json: {", ".join(unknown)}')

    # Keep the rules and zones of boroughs not being rebuilt.
    rules_path = os.path.join(OUT, 'rules.json')
    zones_path = os.path.join(OUT, 'zones.geojson')
    old_rules = json.load(open(rules_path)) if os.path.exists(rules_path) and argv else {'boroughs': {}, 'rules': {}}
    old_zones = json.load(open(zones_path))['features'] if os.path.exists(zones_path) and argv else []
    all_rules = {k: v for k, v in old_rules.get('rules', {}).items() if v['borough'] not in wanted}
    all_boroughs = {k: v for k, v in old_rules.get('boroughs', {}).items() if k not in wanted}
    all_zones = [f for f in old_zones if f['properties']['b'] not in wanted]

    for bid in wanted:
        b = boroughs[bid]
        log(f'{bid} ({b["name"]})')
        if b.get('boundaryOnly'):
            # No zone polygons published: the borough outline plus its listed zones (no geometry).
            outline = borough_boundary(b['boundaryOnly'])
            rules = build_rules(bid, b, {})
            all_zones.append(feature(outline.simplify(0.0002), {'b': bid, 'zone': '', 'rule': f'{bid}:', 'outline': 1}))
            w, s, e, n = outline.bounds
            entry = {k: b[k] for k in ('name', 'short', 'hoursUrl', 'checked', 'eventDaysUrl', 'bankHolidayUrl',
                                       'mapPdf', 'yellowLines', 'charges', 'notes', 'licence') if k in b}
            entry.update({'bbox': [round(w, 4), round(s, 4), round(e, 4), round(n, 4)], 'listOnly': True,
                          'zoneCount': len(rules), 'knownHours': sum(1 for r in rules.values() if r['periods'] is not None)})
            all_boroughs[bid] = entry
            all_rules.update(rules)
            continue
        polys = load_polygons(bid, b['polygons'])
        zone_info = zones_from_polygons(bid, b, polys)
        zones = {code: info['geom'] for code, info in zone_info.items()}
        if not zones:
            raise SystemExit(f'{bid}: no zone polygons')
        rules = build_rules(bid, b, zone_info)
        missing = sorted(set(b.get('zones', {})) - set(zones))
        if missing:
            log(f'  zones with hours but no polygon: {", ".join(missing)}')
        if b.get('partial'):
            # Some zones couldn't be drawn: the borough outline too, so a tap outside the drawn zones lists them all.
            outline = borough_boundary(b['partial'])
            all_zones.append(feature(outline.simplify(0.0002), {'b': bid, 'zone': '', 'rule': f'{bid}:', 'outline': 1}))
        for code, g in sorted(zones.items()):
            pt = g.representative_point()
            all_zones.append(feature(g.simplify(0.00001), {'b': bid, 'zone': code, 'rule': f'{bid}:{code}',
                                                            'lx': round(pt.x, 5), 'ly': round(pt.y, 5)}))
        w, s, e, n = unary_union(list(zones.values())).bounds
        entry = {k: b[k] for k in ('name', 'short', 'hoursUrl', 'checked', 'eventDaysUrl', 'bankHolidayUrl',
                                   'mapPdf', 'yellowLines', 'charges', 'notes', 'licence') if k in b}
        entry['bbox'] = [round(w, 4), round(s, 4), round(e, 4), round(n, 4)]
        if b.get('partial'):
            entry['partial'] = True
        entry['zoneCount'] = len(zones)
        entry['knownHours'] = sum(1 for r in rules.values() if r['periods'] is not None and 'streets' not in r
                                  and r['zone'] in zones)
        all_boroughs[bid] = entry
        all_rules.update(rules)
        if not b.get('skipOsm'):
            try:
                streets, kerb, machines = build_osm(bid, b, zones, rules)
            except RuntimeError as e:
                log(f'  {e}; keeping any earlier street files')
                entry['detail'] = os.path.exists(os.path.join(OUT, bid, 'streets.geojson'))
            else:
                write(os.path.join(OUT, bid, 'streets.geojson'), streets)
                write(os.path.join(OUT, bid, 'kerb.geojson'), kerb)
                write(os.path.join(OUT, bid, 'machines.geojson'), machines)
                entry['detail'] = True

    rules_out = {'checked': max(b.get('checked', '') for b in all_boroughs.values()),
                 'boroughs': dict(sorted(all_boroughs.items())), 'rules': dict(sorted(all_rules.items()))}
    with open(rules_path, 'w') as f:
        json.dump(rules_out, f, separators=(',', ':'), ensure_ascii=False)
    write(zones_path, all_zones)
    known = sum(b['knownHours'] for b in all_boroughs.values())
    total = sum(b['zoneCount'] for b in all_boroughs.values())
    log(f'{len(all_boroughs)} boroughs, {total} zones, {known} with readable hours')


if __name__ == '__main__':
    main(sys.argv[1:])
