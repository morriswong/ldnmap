"""Offline tests for tools/dtro.py: the D-TRO API is replaced by canned responses.
Run with: python3 tests/test_dtro.py (npm test runs it)."""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import dtro  # noqa: E402

SRC = {'boroughs': {'hf': {'name': 'Hammersmith & Fulham', 'swaCode': 5390},
                    'croydon': {'name': 'Croydon', 'swaCode': 5240}}}


def event(id, tra, types, kind='create', stages=None, t='2026-11-17T10:00:00'):
    return {'id': id, 'traCreator': tra, 'currentTraOwner': tra, 'troName': f'Order {id}', 'regulationType': types,
            'orderReportingPoint': stages or ['permanentNoticeOfMaking'], 'eventType': kind, 'eventTime': t}


class FakeClient(dtro.Client):
    """Answers /oauth-generator and /events from canned pages, recording each request body."""

    def __init__(self, created, modified):
        super().__init__('id', 'secret', base='https://example.invalid/v1')
        self.pages = {'created': created, 'modified': modified}
        self.calls = []

    def _request(self, method, path, body=None, form=None, auth=None):
        if path != '/oauth-generator':
            auth = auth or f'Bearer {self.token()}'   # as Client._request does
        self.calls.append((method, path, body, form, auth))
        if path == '/oauth-generator':
            assert auth == 'Basic aWQ6c2VjcmV0' and form == {'grant_type': 'client_credentials'}
            return 200, {'access_token': 'tok'}
        assert auth == 'Bearer tok'
        if path == '/events':
            pages = self.pages['modified' if 'modifiedFrom' in body else 'created']
            i = body['page'] - 1
            return (200, {'events': pages[i]}) if i < len(pages) else (404, {'message': 'Not found'})
        if path == '/search':
            return 200, {'results': [], 'totalCount': 3 if body['queries'][0]['traCreator'] == 5390 else 0}
        raise AssertionError(path)


class DtroTests(unittest.TestCase):
    def test_parking_filter(self):
        self.assertTrue(dtro.is_parking_change(event('a', 5390, ['kerbsideControlledParkingZone'])))
        self.assertTrue(dtro.is_parking_change(event('a', 5390, ['kerbsideNoWaiting', 'kerbsidePaymentParkingPlace'])))
        self.assertFalse(dtro.is_parking_change(event('a', 5390, ['miscRoadClosure'])))
        self.assertFalse(dtro.is_parking_change(event('a', 5390, ['kerbsidePermitParkingPlace'], kind='delete')))
        # temporary orders (works, events) are not lasting zone changes
        self.assertFalse(dtro.is_parking_change(event('a', 5390, ['kerbsideControlledParkingZone'],
                                                      stages=['ttroTtmoByNotice'])))
        self.assertTrue(dtro.is_parking_change(event('a', 5390, ['kerbsideControlledParkingZone'], stages=[])))

    def test_recent_parking_events(self):
        created = [[event('1', 5390, ['kerbsideControlledParkingZone']),
                    event('2', 4205, ['kerbsideControlledParkingZone'])],      # not London
                   [event('3', 5240, ['miscRoadClosure'])]]                    # not parking
        modified = [[event('1', 5390, ['kerbsideControlledParkingZone'], kind='update', t='2026-11-18T09:00:00'),
                     event('4', 5240, ['kerbsidePaymentParkingPlace'], kind='update')]]
        c = FakeClient(created, modified)
        found = dtro.recent_parking_events(c, SRC, 8, now=dt.datetime(2026, 11, 19, 7, 0))
        self.assertEqual([(b, e['id'], e['eventType']) for b, e in found],
                         [('croydon', '4', 'update'), ('hf', '1', 'update')])   # latest event per D-TRO
        bodies = [b for m, p, b, f, a in c.calls if p == '/events']
        self.assertEqual(bodies[0]['since'], '2026-11-11T07:00:00')
        self.assertEqual(bodies[0]['pageSize'], 50)
        self.assertEqual(bodies[-1]['modifiedFrom'], '2026-11-11T07:00:00')
        self.assertEqual(sum(1 for m, p, *_ in c.calls if p == '/oauth-generator'), 1)   # token reused

    def test_count_and_describe(self):
        c = FakeClient([], [])
        self.assertEqual(c.count(traCreator=5390), 3)
        text = dtro.describe(event('abc', 5390, ['kerbsideControlledParkingZone']))
        self.assertIn('kerbsideControlledParkingZone', text)
        self.assertIn('python3 tools/dtro.py show abc', text)

    def test_bad_credentials(self):
        class Refused(FakeClient):
            def _request(self, method, path, **kw):
                return 401, {'fault': 'Invalid client'}
        with self.assertRaises(dtro.DtroError):
            Refused([], []).count(traCreator=5390)


if __name__ == '__main__':
    unittest.main(verbosity=1)
