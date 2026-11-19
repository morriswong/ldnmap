"""Offline tests for tools/council_notices.py: each parser against a trimmed copy of its page.
Run with: python3 tests/test_council_notices.py (npm test runs it)."""
import datetime as dt
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import council_notices as cn  # noqa: E402

D = dt.date

RICHMOND = '''<table id="results" class=" table"><tbody>
<tr class="tableHeader"><th>Date</th><th>Ref</th></tr>
<tr class="lb-table-row"><td>19/11/26</td><td>26/116</td><td>Parking Charges, Parking permits</td><td>Permanent</td>
<td>Advertised</td><td>Various Streets</td><td><a href="https://www2.richmond.gov.uk/docs/PublicNotices/26_116.pdf">View</a></td></tr>
<tr class="lb-table-row"><td>18/11/26</td><td>26/250</td><td>Road closures</td><td>Temporary</td>
<td>Made</td><td>Kew Road</td><td><a href="https://www2.richmond.gov.uk/docs/PublicNotices/26_250.pdf">View</a></td></tr>
</tbody></table>'''

WESTMINSTER = '''<li><a href="tmo_details.php?tt=2&amp;id=2763&amp;cid=2">Map Based Orders (B Zone)</a></li>
<li><a href="tmo_details.php?tt=2&amp;id=2583&amp;cid=2">Brook Street and Morshead Road EV Bays</a></li>'''

CITY = ('<div class="list"><div class="CardListing__ListingCard-sc-1t816db-0 SSPed card"><a class="Link" target="_self" '
        'href="/services/streets/traffic-order-consultations/draft-traffic-management-orders"><h2 class="Heading">'
        'Controlled Parking Zone draft Traffic Management Orders</h2></a><span class="info"><span>Date created:'
        '<!-- --> <!-- -->19/10/2026</span></span><p>CPZ hours.</p></div>')

ISLINGTON = '''<h3>Blackstock Road parklet</h3><p>Start date: 2 October 2026</p>
<a href="/x.pdf">The Islington (Charged-For Parking Places) (Amendment No. 30) Experimental Order 2026</a>
<a href="https://www.islington.gov.uk:443/-/media/parking/charged-pps-as-amended.pdf?la=en&amp;hash=B17C7A68A8660CE2">Charged PPs as amended</a>'''

BRENT = '''<div id="schemehead_9" data-schemename="Housing Estate Car Parks 2026" class="schemeHead"><h5>Housing</h5>
<a class="doc" href="https://store.traffweb.app/brent/documents/consult/29-005.pdf">Scheme Document</a>
<span>Advertised from <b>05/11/2026</b> to 26/11/2026</span></div>
<div id="schemehead_9" data-schemename="Housing Estate Car Parks 2026" class="schemeHead"></div>'''

WANDSWORTH = '''<table><tr><th>Date</th></tr>
<tr><td>7/8 November 2026</td><td>TMO-08-26-282</td><td>Fireworks</td><td>Temporary</td><td>Made</td><td>Various</td>
<td><a href="/media/a/tmo-08-26-282.pdf">PDF</a></td></tr>
<tr><td>03/02/2025</td><td>TMO-02-25-001</td><td>Controlled parking zone hours</td><td>Permanent</td><td>Made</td><td>Zone E</td>
<td><a href="/media/b/tmo.pdf">PDF</a></td></tr></table>'''


class Parsers(unittest.TestCase):
    def test_richmond(self):
        a, b = cn.parse_richmond(RICHMOND)
        self.assertEqual((a['id'], a['date']), ('26/116', D(2026, 11, 19)))
        self.assertTrue(cn.is_parking(a))
        self.assertFalse(cn.is_parking(b))   # temporary road closure

    def test_westminster(self):
        a, b = cn.parse_westminster(WESTMINSTER, 'made')
        self.assertEqual(a['id'], '2763')
        self.assertIsNone(a['date'])
        self.assertTrue(a['url'].endswith('tmo_details.php?tt=2&id=2763&cid=2'))
        self.assertTrue(cn.is_parking(a))
        self.assertFalse(cn.is_parking(b))   # EV bays only

    def test_city(self):
        [n] = cn.parse_city(CITY)
        self.assertEqual((n['id'], n['date']), ('draft-traffic-management-orders', D(2026, 10, 19)))
        self.assertTrue(n['url'].startswith('https://www.cityoflondon.gov.uk/services/'))
        self.assertTrue(cn.is_parking(n))

    def test_islington(self):
        eto, order = cn.parse_islington(ISLINGTON)
        self.assertEqual(eto['date'], D(2026, 10, 2))
        self.assertIn('Charged-For Parking Places', eto['title'])
        self.assertTrue(cn.is_parking(eto))
        self.assertEqual((order['id'], order['kind']), ('charged-pps-B17C7A68', 'consolidation'))
        with self.assertRaises(cn.SourceError):
            cn.parse_islington('<h3>No links here</h3>')

    def test_brent(self):
        [n] = cn.parse_brent(BRENT)   # the scheme is listed twice on the page
        self.assertEqual((n['id'], n['date']), ('9', D(2026, 11, 5)))
        self.assertFalse(cn.is_parking(n))   # estate car parks, not on-street

    def test_wandsworth(self):
        a, b = cn.parse_wandsworth(WANDSWORTH)
        self.assertEqual(a['date'], D(2026, 11, 8))
        self.assertEqual(b['date'], D(2025, 2, 3))
        self.assertEqual(b['url'], 'https://www.wandsworth.gov.uk/media/b/tmo.pdf')
        self.assertFalse(cn.is_parking(a))
        self.assertTrue(cn.is_parking(b))

    def test_rbkc_and_ealing(self):
        [r] = cn.parse_rbkc(json.dumps([{'id': 'november-2026-parking-changes', 'title': 'November 2026 Parking Changes',
                                         'startdate': '2026/11/04', 'url': 'https://consult.rbkc.gov.uk/x'}]))
        self.assertEqual(r['date'], D(2026, 11, 4))
        self.assertTrue(cn.is_parking(r))
        [e] = cn.parse_ealing(json.dumps({'data': [{'attributes': {
            'slug': 'west-twyford-zone-y-cpz-review', 'created_at': '2026-10-20T09:00:00Z',
            'title_multiloc': {'en-GB': 'West Twyford Controlled Parking Consultation (Zone Y)'}}}]}))
        self.assertEqual(e['date'], D(2026, 10, 20))
        self.assertTrue(cn.is_parking(e))

    def test_layout_change_is_an_error(self):
        with self.assertRaises(cn.SourceError):
            cn.parse_richmond('<html>new design</html>')


if __name__ == '__main__':
    unittest.main(verbosity=1)
