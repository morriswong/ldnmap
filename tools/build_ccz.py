#!/usr/bin/env python3
"""Build data/ccz.geojson, the London Congestion Charge zone, from TfL's open data.

Source: TfL roads open data, boundaries/CC_Boundary_20211026_Shape Files.zip (a shapefile in
British National Grid, EPSG:27700). Licence: TfL open data terms (Open Government Licence).
See data/README.md. No dependencies:

    python3 tools/build_ccz.py              # download from TfL
    python3 tools/build_ccz.py path/to.zip  # or use a copy already downloaded

Each ring is simplified (Douglas-Peucker, TOLERANCE_M metres, done in the grid's metres) and
then turned into WGS84 longitude/latitude: the inverse Transverse Mercator projection gives
OSGB36 coordinates, and the OS's 7-parameter Helmert transform moves them to WGS84. That
transform is good to a few metres (OSTN15, the exact one, needs a grid file), which is fine for
drawing the zone and testing whether a place is in it, but not for telling which side of a
boundary road a car is on.
"""
import io
import json
import math
import os
import struct
import sys
import urllib.request
import zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'data', 'ccz.geojson')
URL = 'https://s3-eu-west-1.amazonaws.com/roads.data.tfl.gov.uk/boundaries/CC_Boundary_20211026_Shape%20Files.zip'
UA = 'ldnmap-ccz-build/1.0 (+https://ldnmap.pages.dev)'
TOLERANCE_M = 2.0
DECIMALS = 6        # about 0.1 m


def read_polygons(shp):
    """The rings of each record of a polygon shapefile, as lists of (easting, northing)."""
    if struct.unpack('<i', shp[32:36])[0] not in (5, 15, 25):
        raise ValueError('not a polygon shapefile')
    out, off = [], 100
    while off < len(shp):
        _num, words = struct.unpack('>2i', shp[off:off + 8])
        rec = shp[off + 8:off + 8 + words * 2]
        off += 8 + words * 2
        if struct.unpack('<i', rec[:4])[0] == 0:
            continue                                    # null shape
        nparts, npts = struct.unpack('<2i', rec[36:44])
        parts = list(struct.unpack('<%di' % nparts, rec[44:44 + 4 * nparts])) + [npts]
        xy = struct.unpack('<%dd' % (2 * npts), rec[44 + 4 * nparts:44 + 4 * nparts + 16 * npts])
        pts = list(zip(xy[0::2], xy[1::2]))
        out.append([pts[parts[i]:parts[i + 1]] for i in range(nparts)])
    return out


def signed_area(ring):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:])) / 2


def simplify(pts, tol):
    """Douglas-Peucker on an open polyline; keeps both ends."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = -1.0, None
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / L if L else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring, tol):
    """A closed ring, split at its farthest point from the start so both halves have ends."""
    if ring[0] != ring[-1]:
        ring = ring + [ring[0]]
    far = max(range(len(ring)), key=lambda i: math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]))
    out = simplify(ring[:far + 1], tol)[:-1] + simplify(ring[far:], tol)
    return out if len(out) >= 4 else ring


# --- British National Grid → WGS84 ---------------------------------------------------------
AIRY_A, AIRY_B = 6377563.396, 6356256.909
GRS80_A, GRS80_B = 6378137.0, 6356752.3141
F0, LAT0, LON0, E0, N0 = 0.9996012717, math.radians(49), math.radians(-2), 400000.0, -100000.0
# OSGB36 → WGS84 (the OS's published WGS84 → OSGB36 parameters, negated).
TX, TY, TZ = 446.448, -125.157, 542.060
S = -20.4894e-6
RX, RY, RZ = (math.radians(v / 3600) for v in (0.1502, 0.2470, 0.8421))


def bng_to_osgb36(E, N):
    a, b = AIRY_A, AIRY_B
    e2 = 1 - b * b / (a * a)
    n = (a - b) / (a + b)
    lat, M = LAT0, 0.0
    while True:
        lat = (N - N0 - M) / (a * F0) + lat
        Ma = (1 + n + 5 / 4 * n ** 2 + 5 / 4 * n ** 3) * (lat - LAT0)
        Mb = (3 * n + 3 * n ** 2 + 21 / 8 * n ** 3) * math.sin(lat - LAT0) * math.cos(lat + LAT0)
        Mc = (15 / 8 * n ** 2 + 15 / 8 * n ** 3) * math.sin(2 * (lat - LAT0)) * math.cos(2 * (lat + LAT0))
        Md = 35 / 24 * n ** 3 * math.sin(3 * (lat - LAT0)) * math.cos(3 * (lat + LAT0))
        M = b * F0 * (Ma - Mb + Mc - Md)
        if abs(N - N0 - M) < 1e-5:
            break
    s, c, t = math.sin(lat), math.cos(lat), math.tan(lat)
    nu = a * F0 / math.sqrt(1 - e2 * s * s)
    rho = a * F0 * (1 - e2) / (1 - e2 * s * s) ** 1.5
    eta2 = nu / rho - 1
    VII = t / (2 * rho * nu)
    VIII = t / (24 * rho * nu ** 3) * (5 + 3 * t * t + eta2 - 9 * t * t * eta2)
    IX = t / (720 * rho * nu ** 5) * (61 + 90 * t * t + 45 * t ** 4)
    X = 1 / (c * nu)
    XI = 1 / (c * 6 * nu ** 3) * (nu / rho + 2 * t * t)
    XII = 1 / (c * 120 * nu ** 5) * (5 + 28 * t * t + 24 * t ** 4)
    XIIA = 1 / (c * 5040 * nu ** 7) * (61 + 662 * t * t + 1320 * t ** 4 + 720 * t ** 6)
    dE = E - E0
    lat = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6
    lon = LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7
    return lat, lon


def to_cartesian(lat, lon, a, b):
    e2 = 1 - b * b / (a * a)
    nu = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return (nu * math.cos(lat) * math.cos(lon), nu * math.cos(lat) * math.sin(lon),
            (1 - e2) * nu * math.sin(lat))


def from_cartesian(x, y, z, a, b):
    e2 = 1 - b * b / (a * a)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(10):
        nu = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        lat = math.atan2(z + e2 * nu * math.sin(lat), p)
    return lat, math.atan2(y, x)


def bng_to_wgs84(E, N):
    lat, lon = bng_to_osgb36(E, N)
    x, y, z = to_cartesian(lat, lon, AIRY_A, AIRY_B)
    x2 = TX + (1 + S) * x - RZ * y + RY * z
    y2 = TY + RZ * x + (1 + S) * y - RX * z
    z2 = TZ - RY * x + RX * y + (1 + S) * z
    lat, lon = from_cartesian(x2, y2, z2, GRS80_A, GRS80_B)
    return round(math.degrees(lon), DECIMALS), round(math.degrees(lat), DECIMALS)


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'rb') as f:
            raw = f.read()
    else:
        req = urllib.request.Request(URL, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
    z = zipfile.ZipFile(io.BytesIO(raw))
    shp = z.read([n for n in z.namelist() if n.lower().endswith('.shp')][0])
    records = read_polygons(shp)
    # The file has the zone itself and one small strip (about 2,700 m², by Green Park near Hyde
    # Park Corner) that touches it; together they are the zone, so both are kept, as one MultiPolygon.
    polys, before, after = [], 0, 0
    for rings in records:
        out = []
        for ring in rings:
            before += len(ring)
            simple = simplify_ring(ring, TOLERANCE_M)
            after += len(simple)
            ll = [bng_to_wgs84(e, n) for e, n in simple]
            # Shapefile outer rings are clockwise; GeoJSON (RFC 7946) wants them anticlockwise.
            outer = signed_area(ring) < 0
            if outer:
                ll.reverse()
            out.append(ll)
        polys.append(out)
    polys.sort(key=lambda p: -abs(signed_area(p[0])))
    fc = {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'properties': {
                'name': 'Congestion Charge zone',
                'source': 'Transport for London, roads open data: boundaries/CC_Boundary_20211026_Shape Files.zip',
                'licence': 'TfL open data (Open Government Licence v2.0)',
            },
            'geometry': {'type': 'MultiPolygon', 'coordinates': polys},
        }],
    }
    with open(OUT, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
        f.write('\n')
    print('%d records, %d → %d points, %d bytes → %s' % (len(records), before, after, os.path.getsize(OUT), OUT))


if __name__ == '__main__':
    main()
