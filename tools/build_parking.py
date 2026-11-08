#!/usr/bin/env python3
"""Build the GeoJSON files in data/parking/ for the parking layer.

Not part of the site: run it by hand when the data needs refreshing. The page
only fetches the files it writes. data/parking/rules.json is written by hand
from the council's zone times page (see data/parking/README.md).

    python3 -m venv /tmp/pv && /tmp/pv/bin/pip install shapely
    /tmp/pv/bin/python tools/build_parking.py

Sources:
  zones     LBHF "Controlled Parking Zones" layer (INSPIRE map service)
  streets   OpenStreetMap highways, clipped to each zone
  machines  OpenStreetMap vending=parking_tickets (incomplete)
  kerb      OpenStreetMap street parking tags (parking:*), about 5% of streets
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from shapely.geometry import shape, mapping, Point, LineString
from shapely.ops import unary_union

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'data', 'parking')
CACHE = os.environ.get('PARKING_CACHE', '/tmp/ldnmap-parking-cache')
UA = 'ldnmap-parking-build'

ZONES_URL = ('https://www.rbkc.gov.uk/arcgis/rest/services/LBHF/INSPIRE/MapServer/10/query'
             '?where=1%3D1&outFields=ZONE&outSR=4326&f=geojson')
OVERPASS = 'https://overpass-api.de/api/interpreter'

CLS = {'motorway': 1, 'trunk': 1, 'primary': 1, 'secondary': 2, 'tertiary': 3,
       'unclassified': 4, 'residential': 4, 'living_street': 4, 'service': 5}
BAY = {'lane', 'street_side', 'on_kerb', 'half_on_kerb', 'shoulder', 'yes',
       'parallel', 'diagonal', 'perpendicular', 'marked'}


def fetch(url, name, data=None):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        req = urllib.request.Request(url, data=data, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=300) as r, open(path, 'wb') as f:
            f.write(r.read())
    with open(path) as f:
        return json.load(f)


def overpass(query, name):
    return fetch(OVERPASS, name, urllib.parse.urlencode({'data': query}).encode())['elements']


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


def feature(geom, props):
    return {'type': 'Feature', 'properties': props, 'geometry': r5(geom)}


def write(name, features):
    path = os.path.join(OUT, name)
    with open(path, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    print(f'{name}: {len(features)} features, {os.path.getsize(path) // 1024} KB')


def main():
    rules = json.load(open(os.path.join(OUT, 'rules.json')))
    special = {}  # (zone, street name) -> rule key
    for key, s in rules['specialStreets'].items():
        for name in s['streets']:
            special[(s['zone'], name)] = key

    raw = fetch(ZONES_URL, 'zones.geojson')['features']
    zones = {}
    for f in raw:
        z = f['properties']['ZONE'].strip()
        g = shape(f['geometry']).buffer(0)
        zones[z] = unary_union([zones[z], g]) if z in zones else g
    missing = sorted(set(rules['zones']) - set(zones))
    if missing:
        print('zones in rules.json with no polygon:', ', '.join(missing))

    w, s, e, n = unary_union(list(zones.values())).bounds
    bbox = f'{s - 0.001},{w - 0.001},{n + 0.001},{e + 0.001}'
    ways = overpass(f'[out:json][timeout:180];way["highway"~"^({"|".join(CLS)})$"]({bbox});out tags geom;',
                    'streets.json')
    nodes = overpass(f'[out:json][timeout:60];nwr["vending"~"parking_tickets"]({bbox});out center tags;',
                     'machines.json')

    # The Great West Road splits Rivercourt Road and Weltje Road: only the parts north of it
    # are in the M special area.
    gwr = unary_union([LineString([(p['lon'], p['lat']) for p in w_['geometry']])
                       for w_ in ways if w_['tags'].get('name') == 'Great West Road'])

    def north_of_gwr(line):
        c = line.interpolate(0.5, normalized=True)
        x0, x1 = c.x - 0.002, c.x + 0.002
        near = [p for g in lines(gwr) for p in g.coords if x0 <= p[0] <= x1]
        return not near or c.y > sum(p[1] for p in near) / len(near)

    zone_features = []
    for z, g in sorted(zones.items()):
        pt = g.representative_point()
        zone_features.append(feature(g.simplify(0.00001), {'zone': z, 'lx': round(pt.x, 5), 'ly': round(pt.y, 5)}))

    streets, kerb = [], []
    for w_ in ways:
        t = w_['tags']
        hw = t['highway']
        if hw == 'service' and t.get('service') not in (None, 'alley'):
            continue  # driveways, car park aisles
        if t.get('area') == 'yes' or 'geometry' not in w_:
            continue
        line = LineString([(p['lon'], p['lat']) for p in w_['geometry']])
        tfl = t.get('operator') == 'Transport for London'
        name = t.get('name') or t.get('ref') or ''
        for z, zg in zones.items():
            if not line.intersects(zg):
                continue
            for piece in lines(line.intersection(zg)):
                if piece.length < 1e-5:
                    continue
                rule = special.get((z, name), z)
                if rule == 'M-river' and name != 'Cromwell Avenue' and not north_of_gwr(piece):
                    rule = z
                props = {'name': name, 'zone': z, 'rule': rule, 'cls': CLS[hw]}
                if tfl:
                    props['tfl'] = 1
                streets.append(feature(piece, props))
                if not tfl:
                    for side, kind in kerb_kinds(t):
                        kerb.append(feature(piece, {'kind': kind, 'side': side, 'zone': z}))

    machines = []
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
        machines.append(feature(p, {'id': t.get('ref') or f'OSM {m["type"][0]}{m["id"]}', 'zone': z,
                                    'type': mtype, 'pdf': rules['zones'].get(z, {}).get('pdf', '')}))

    write('zones.geojson', zone_features)
    write('streets.geojson', streets)
    write('kerb.geojson', kerb)
    write('machines.geojson', machines)
    named = {f['properties']['name'] for f in streets}
    for key, s in rules['specialStreets'].items():
        gone = [n for n in s['streets'] if n not in named]
        if gone:
            print(f'{key}: not found in OpenStreetMap:', ', '.join(gone))


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


if __name__ == '__main__':
    sys.exit(main())
