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
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
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
OVERPASS = 'https://overpass-api.de/api/interpreter'

CLS = {'motorway': 1, 'trunk': 1, 'primary': 1, 'secondary': 2, 'tertiary': 3,
       'unclassified': 4, 'residential': 4, 'living_street': 4, 'service': 5}
BAY = {'lane', 'street_side', 'on_kerb', 'half_on_kerb', 'shoulder', 'yes',
       'parallel', 'diagonal', 'perpendicular', 'marked'}
TO_WGS84 = {}


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, name, data=None):
    """GET (or POST `data`) a URL, cached in CACHE under `name`."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': '*/*'})
        with urllib.request.urlopen(req, timeout=300) as r, open(path, 'wb') as f:
            f.write(r.read())
    with open(path, 'rb') as f:
        return f.read()


def fetch_json(url, name, data=None):
    return json.loads(fetch(url, name, data))


def overpass(query, name):
    return fetch_json(OVERPASS, name, urllib.parse.urlencode({'data': query}).encode())['elements']


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
        if not code or code.lower() in ('none', 'null'):
            continue
        g = reproject(shape(f['geometry']), epsg).buffer(0)
        out.append((code, polygons_only(g), props))
    return out


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

def build_rules(bid, b, zone_codes):
    """Rules for a borough: one per zone from the sources file (or the polygon data), plus street rules."""
    rules = {}
    zones = dict(b.get('zones', {}))
    # Zones in the polygons but not in the sources file still get a rule, with unknown hours.
    for code in zone_codes:
        zones.setdefault(code, {})
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
        for k in ('maxStay', 'pdf', 'note', 'permit', 'permitOnly', 'event', 'url', 'name'):
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
        polys = load_polygons(bid, b['polygons'])
        zones = {}
        for code, g, _ in polys:
            zones[code] = unary_union([zones[code], g]) if code in zones else g
        if not zones:
            raise SystemExit(f'{bid}: no zone polygons')
        rules = build_rules(bid, b, sorted(zones))
        missing = sorted(set(b.get('zones', {})) - set(zones))
        if missing:
            log(f'  zones with hours but no polygon: {", ".join(missing)}')
        for code, g in sorted(zones.items()):
            pt = g.representative_point()
            all_zones.append(feature(g.simplify(0.00001), {'b': bid, 'zone': code, 'rule': f'{bid}:{code}',
                                                            'lx': round(pt.x, 5), 'ly': round(pt.y, 5)}))
        w, s, e, n = unary_union(list(zones.values())).bounds
        entry = {k: b[k] for k in ('name', 'short', 'hoursUrl', 'checked', 'eventDaysUrl', 'bankHolidayUrl',
                                   'mapPdf', 'yellowLines', 'charges', 'notes', 'licence') if k in b}
        entry['bbox'] = [round(w, 4), round(s, 4), round(e, 4), round(n, 4)]
        entry['zoneCount'] = len(zones)
        entry['knownHours'] = sum(1 for r in rules.values() if r['periods'] is not None and 'streets' not in r)
        all_boroughs[bid] = entry
        all_rules.update(rules)
        if not b.get('skipOsm'):
            streets, kerb, machines = build_osm(bid, b, zones, rules)
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
