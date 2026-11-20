// Tests for app.js, run in a stand-in browser (tests/helpers/browser-stub.mjs). Run with: npm test
// They cover what the page does to its own state and to the map: which layers are on it, which
// card is showing, and what happens when answers arrive late or out of order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp, reply, deferred, settle, isochrones } from './helpers/browser-stub.mjs';

const BIG_BEN = { lng: -0.1246, lat: 51.5007, name: 'Big Ben', address: '', postcode: null };
const NO_STATIONS = [/api\.tfl\.gov\.uk/, () => reply({ stopPoints: [] })];
const STATIONS = [/api\.tfl\.gov\.uk/, () => reply({ stopPoints: [
  { commonName: 'Westminster Underground Station', lat: 51.501, lon: -0.125 }] })];
const ISO = [/isochrone\/v1/, () => reply(isochrones())];
const SQUARE = { type: 'Polygon', coordinates: [[[-0.2, 51.48], [-0.19, 51.48], [-0.19, 51.49], [-0.2, 51.49], [-0.2, 51.48]]] };
const BOUNDARY = [/api\.os\.uk/, () => reply({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: SQUARE }] })];

// Values made inside the page's own script realm, as plain ones that deepEqual can compare.
const plain = (v) => JSON.parse(JSON.stringify(v));
const isoOnMap = (app) => app.map.layerIds().filter((id) => id.indexOf('iso-') === 0).length;
const tags = (app) => plain(app.isoLayers.map((l) => l.data.properties.tag));

async function travel(app) {
  app.goToPlace({ ...BIG_BEN });
  await settle();
  assert.equal(app.isoLayers.length, 4);
}

test('a place without a postcode opens its travel view', async () => {
  const app = loadApp({ routes: [ISO, STATIONS] });
  await travel(app);
  assert.equal(app.appState, 'travel');
  assert.equal(isoOnMap(app), 8);                      // a fill and a line per contour
  assert.ok(app.map.getLayer('stations-circle'));
  assert.match(app.location.hash, /^#p=51\.50070,-0\.12460&m=walking&q=Big%20Ben$/);
});

test('switching mode twice ends on the last mode, whichever answer comes first', async () => {
  for (const firstToAnswer of ['cycling', 'driving']) {
    const answers = { cycling: deferred(), driving: deferred() };
    const app = loadApp({ routes: [
      [/isochrone\/v1\/mapbox\/cycling/, () => answers.cycling.promise],
      [/isochrone\/v1\/mapbox\/driving-traffic/, () => answers.driving.promise],
      [/isochrone\/v1\/mapbox\/walking/, () => reply(isochrones('walking'))], NO_STATIONS] });
    await travel(app);
    app.pickMode('cycling');
    app.pickMode('driving');
    const order = firstToAnswer === 'cycling' ? ['cycling', 'driving'] : ['driving', 'cycling'];
    for (const m of order) { answers[m].resolve(reply(isochrones(m))); await settle(); }
    assert.equal(app.mode, 'driving');
    assert.deepEqual(tags(app), ['driving', 'driving', 'driving', 'driving'], firstToAnswer + ' answered first');
    assert.equal(isoOnMap(app), 8);
  }
});

test('closing the travel card while it loads leaves nothing behind', async () => {
  const iso = deferred(), tfl = deferred();
  const app = loadApp({ routes: [[/isochrone\/v1/, () => iso.promise], [/api\.tfl\.gov\.uk/, () => tfl.promise]] });
  app.goToPlace({ ...BIG_BEN });
  await settle();
  app.closeTravelCard();
  iso.resolve(reply(isochrones()));
  tfl.resolve(reply({ stopPoints: [{ commonName: 'Westminster', lat: 51.501, lon: -0.125 }] }));
  await settle();
  assert.equal(app.appState, 'idle');
  assert.equal(app.isoLayers.length, 0);
  assert.deepEqual(app.map.layerIds(), []);
  assert.equal(app.location.hash, '');
});

test('station answers for a view since closed are dropped', async () => {
  const tfl = deferred();
  const app = loadApp({ routes: [ISO, [/api\.tfl\.gov\.uk/, () => tfl.promise]] });
  await travel(app);
  app.closeTravelCard();
  tfl.resolve(reply({ stopPoints: [{ commonName: 'Westminster', lat: 51.501, lon: -0.125 }] }));
  await settle();
  assert.equal(app.stationsData, null);
  assert.equal(app.map.getLayer('stations-circle'), undefined);
});

test('a TfL error says so instead of "No nearby stations"', async () => {
  const app = loadApp({ routes: [ISO, [/api\.tfl\.gov\.uk/, () => reply({ message: 'Rate limit' }, 429)]] });
  await travel(app);
  assert.match(app.el('travel-stations').innerHTML, /Couldn’t load stations/);
  assert.equal([...app.storage.keys()].filter((k) => k.indexOf('st:') === 0).length, 0, 'an error is not cached');
});

test('a busy isochrone service is retried, then reported with a retry hint', async () => {
  let calls = 0;
  const app = loadApp({ routes: [[/isochrone\/v1/, () => { calls++; return reply({}, 503); }], NO_STATIONS] });
  app.isoDelay = () => Promise.resolve();              // skip the backoff
  app.goToPlace({ ...BIG_BEN });
  await settle();
  assert.equal(calls, 3);
  assert.equal(app.el('st').textContent, 'Map service is busy · Tap to retry');
  assert.ok(app.el('st').classList.contains('error'));
});

test('search opened from the travel view goes back to it', async () => {
  const app = loadApp({ routes: [ISO, STATIONS] });
  await travel(app);
  app.openSearchOverlay();
  assert.equal(app.appState, 'search');
  app.closeSearchOverlay();
  assert.equal(app.appState, 'travel');
  assert.equal(isoOnMap(app), 8);

  // After the view is closed there is nothing to go back to.
  app.closeTravelCard();
  app.openSearchOverlay();
  app.closeSearchOverlay();
  assert.equal(app.appState, 'idle');
});

test('picking a postcode from the travel view takes the old view off the map', async () => {
  const app = loadApp({ routes: [ISO, STATIONS, BOUNDARY] });
  await travel(app);
  app.openSearchOverlay();
  app.overlayInput.value = 'sw6 1aa';
  app.selectSuggestionFromList(0, [{ type: 'postcode', postcode: 'SW6 1AA', name: 'SW6 1AA' }]);
  await settle();
  assert.equal(app.appState, 'modepicker');
  assert.equal(app.lastSearchQuery, 'sw6 1aa');
  assert.equal(app.marker, null, 'the previous place’s pin is gone');
  assert.deepEqual(app.map.layerIds(), ['postcode-fill', 'postcode-line']);
  app.closePostcodeChip();
  assert.equal(app.appState, 'idle');
  assert.deepEqual(app.map.layerIds(), []);
});

test('the back button on the travel card clears the view and its link', async () => {
  const app = loadApp({ routes: [ISO, STATIONS] });
  await travel(app);
  app.changeMode();
  assert.equal(app.appState, 'search');
  assert.equal(app.location.hash, '');
  assert.equal(app.storage.has('ldnmap:lastView'), false);
  assert.deepEqual(app.map.layerIds(), []);
  app.closeSearchOverlay();
  assert.equal(app.appState, 'idle');
});

test('a postcode with no boundary still gets working buttons, from its centre', async () => {
  const app = loadApp({ routes: [
    [/api\.os\.uk/, () => reply({ type: 'FeatureCollection', features: [] })],
    [/api\.postcodes\.io\/postcodes\/SW1A1AA/, () => reply({ status: 200, result: { latitude: 51.501, longitude: -0.1416 } })]] });
  app.goToPostcode('SW1A 1AA');
  assert.equal(app.el('postcode-cta-btn').disabled, true);
  assert.equal(app.el('postcode-parking-btn').disabled, true, 'no point to look up parking for yet');
  await settle();
  assert.equal(app.el('postcode-cta-btn').disabled, false);
  assert.equal(app.el('postcode-parking-btn').disabled, false);
  assert.equal(app.el('pc-st').classList.contains('is-loading'), false);
  assert.equal(app.el('pc-st').textContent, 'Boundary unavailable — showing postcode centre');
  assert.deepEqual([app.pendingPlace.lat, app.pendingPlace.lng], [51.501, -0.1416]);
});

test('a boundary drawn from its postcode enables the card and is cached', async () => {
  const app = loadApp({ routes: [BOUNDARY] });
  app.goToPostcode('SW6 1AA');
  await settle();
  assert.deepEqual(app.map.layerIds(), ['postcode-fill', 'postcode-line']);
  assert.equal(app.el('postcode-cta-btn').disabled, false);
  assert.ok(Math.abs(app.pendingPlace.lat - 51.485) < 1e-9);
  assert.ok(app.storage.has('pc:SW6 1AA'));
  assert.equal(app.map.getPadding().top, 0, 'fitting the boundary leaves no padding on the map');
});

test('a boundary that arrives after its card closed is not drawn', async () => {
  const os = deferred();
  const app = loadApp({ routes: [[/api\.os\.uk/, () => os.promise]] });
  app.goToPostcode('SW6 1AA');
  app.closePostcodeChip();
  os.resolve(reply({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: SQUARE }] }));
  await settle();
  assert.deepEqual(app.map.layerIds(), []);
  assert.equal(app.postcodeLayer, null);
  assert.equal(app.fetched.filter((u) => /postcodes\.io/.test(u)).length, 0);
});

test('a damaged cache entry is ignored, and expired ones are cleared at startup', async () => {
  const old = JSON.stringify({ ts: Date.now() - 31 * 24 * 60 * 60 * 1000, geojson: {}, stations: [] });
  const fresh = JSON.stringify({ ts: Date.now(), stations: [] });
  const app = loadApp({ routes: [BOUNDARY], storage: {
    'pc:SW6 1AA': '{not json', 'pc:E8 4QN': old, 'st:51.501,-0.125': old, 'st:51.500,-0.120': fresh,
    'recent_searches': '[]', 'ldnmap:fuelLast': '{"location":"E8","fuel":"E10"}' } });
  assert.deepEqual([...app.storage.keys()].sort(), ['ldnmap:fuelLast', 'recent_searches', 'st:51.500,-0.120']);
  app.goToPostcode('SW6 1AA');
  await settle();
  assert.deepEqual(app.map.layerIds(), ['postcode-fill', 'postcode-line']);
});

test('two quick theme toggles put each layer back once and keep them tracked', async () => {
  const app = loadApp({ routes: [ISO, STATIONS] });
  await travel(app);
  app.selectBucket(10);
  app.toggleTheme();
  app.toggleTheme();                                   // the first style never finishes loading
  assert.deepEqual(app.map.layerIds(), []);
  app.map.finishStyle();
  assert.equal(app.isoLayers.length, 4);
  assert.equal(isoOnMap(app), 8);
  assert.ok(app.map.getLayer('stations-circle'));
  assert.equal(app.selectedMin, 10);
  app.closeTravelCard();
  assert.deepEqual(app.map.layerIds(), [], 'nothing is left that the app has lost track of');
});

test('putting the layers back twice on one style is harmless', async () => {
  const app = loadApp({ routes: [ISO, STATIONS, BOUNDARY] });
  await travel(app);
  app.addPostcodeLayers({ type: 'Feature', properties: {}, geometry: SQUARE });
  const before = app.map.layerIds().slice().sort();
  app.rehydrateLayers();
  app.rehydrateLayers();
  assert.deepEqual(app.map.layerIds().slice().sort(), before);
  assert.equal(app.isoLayers.length, 4);
});

test('the theme button shows the theme a tap switches to', () => {
  const app = loadApp();
  app.toggleTheme();                                   // now dark
  assert.equal(app.isDark, true);
  assert.match(app.el('theme-icon-fab').innerHTML, /^<circle/, 'a sun in dark mode');
  assert.match(app.map.styles[0], /dark-v11$/);
  app.toggleTheme();                                   // light again
  assert.match(app.el('theme-icon-fab').innerHTML, /^<path d="M21 12\.79/, 'a moon in light mode');
});

test('whenStyleReady runs its work once and leaves no listener behind', () => {
  const app = loadApp();
  const base = { load: app.map.listenerCount('style.load'), idle: app.map.listenerCount('idle') };
  app.map.styleLoaded = false;
  let ran = 0;
  app.whenStyleReady(() => { ran++; });
  assert.equal(ran, 0);
  app.map.fire('idle');                                // idle comes first: the style.load listener must go too
  assert.equal(ran, 1);
  assert.deepEqual({ load: app.map.listenerCount('style.load'), idle: app.map.listenerCount('idle') }, base);
  app.map.fire('style.load');
  app.map.fire('idle');
  assert.equal(ran, 1);
});

const FUEL = (fuel, label) => ({
  location: { query: label, label, latitude: 51.48, longitude: -0.2 }, fuel, radius_miles: 5,
  data_fetched_at: new Date().toISOString(), warning: null,
  stations: [
    { node_id: 'a', name: 'Cheap ' + fuel, brand: 'X', address: '1 Road', postcode: 'SW6 1AA', latitude: 51.49, longitude: -0.19,
      distance_miles: 0.4, fuel, price_ppl: 130.9, price_updated: new Date().toISOString() },
    { node_id: 'b', name: 'Dear ' + fuel, brand: 'Y', address: '2 Road', postcode: 'SW6 2AA', latitude: 51.47, longitude: -0.21,
      distance_miles: 0.9, fuel, price_ppl: 139.9, price_updated: null }]
});
const fuelSummary = (app) => (app.el('fuel-results').querySelectorAll('.fuel-summary-text')[0] || {}).textContent;
const pickFuel = (app, code) => app.el('fuel-types').dispatch('click', { target: { closest: () => ({ dataset: { fuel: code } }) } });

test('fuel: the list, the pins and the cheapest station', async () => {
  const app = loadApp({ routes: [[/\/api\/fuel\?/, () => reply(FUEL('E10', 'SW6'))], [/\/api\/fuel$/, () => reply({ enabled: true })]] });
  await settle();
  assert.equal(app.fuelEnabled, true);
  assert.equal(app.el('postcode-fuel-btn').hidden, false);
  app.openFuel();
  app.fuelInput.value = 'SW6';
  await app.lookupFuel();
  assert.equal(fuelSummary(app), 'E10 petrol within 5 mi of SW6');
  assert.deepEqual(app.map.layerIds(), ['fuel-origin', 'fuel-circle', 'fuel-label']);
  const props = app.fuelData.features.map((f) => f.properties);
  assert.deepEqual(plain(props.map((p) => [p.kind, p.label, p.cheapest || 0])), [['station', '130.9p', 1], ['station', '139.9p', 0], ['origin', '', 0]]);
  assert.equal(app.el('fuel-send').disabled, false);
  assert.equal(JSON.parse(app.storage.get('ldnmap:fuelLast')).location, 'SW6');
});

test('fuel: changing fuel during a lookup ends on the fuel selected', async () => {
  const petrol = deferred();
  const app = loadApp({ routes: [
    [/\/api\/fuel\?.*fuel=E10/, () => petrol.promise],
    [/\/api\/fuel\?.*fuel=B7_STANDARD/, () => reply(FUEL('B7_STANDARD', 'SW6'))]] });
  app.openFuel();
  app.fuelInput.value = 'SW6';
  const first = app.lookupFuel();
  pickFuel(app, 'B7_STANDARD');
  await settle();
  assert.equal(fuelSummary(app), 'Diesel within 5 mi of SW6');
  petrol.resolve(reply(FUEL('E10', 'SW6')));           // the answer to the question no longer being asked
  await first;
  assert.equal(app.fuelType, 'B7_STANDARD');
  assert.equal(fuelSummary(app), 'Diesel within 5 mi of SW6');
  assert.equal(app.fuelStations.a.fuel, 'B7_STANDARD');
  assert.equal(app.el('fuel-send').disabled, false);
});

test('fuel: a point search is named and pinned as the user saw it', async () => {
  const app = loadApp({ routes: [[/\/api\/fuel\?/, () => reply(FUEL('E10', 'SW1A 0AA'))]] });
  app.fuelNear(51.5007, -0.1246, 'Big Ben');
  await settle();
  assert.match(app.fetched.filter((u) => /fuel\?/.test(u))[0], /\?lat=51\.50070&lon=-0\.12460&fuel=E10$/);
  assert.equal(fuelSummary(app), 'E10 petrol within 5 mi of Big Ben');
  const origin = app.fuelData.features.filter((f) => f.properties.kind === 'origin')[0];
  assert.deepEqual(plain(origin.geometry.coordinates), [-0.1246, 51.5007]);
  assert.equal(app.storage.has('ldnmap:fuelLast'), false, 'a point’s label is not saved as a place to search');
});

test('fuel: a server error is shown, and a later search still works', async () => {
  let fail = true;
  const app = loadApp({ routes: [[/\/api\/fuel\?/, () => (fail ? reply({ error: 'Postcode ZZ1 was not found.' }, 400) : reply(FUEL('E10', 'SW6')))]] });
  app.openFuel();
  app.fuelInput.value = 'ZZ1';
  await app.lookupFuel();
  assert.equal(app.el('fuel-results').textContent, 'Postcode ZZ1 was not found.');
  fail = false;
  await app.lookupFuel();
  assert.equal(fuelSummary(app), 'E10 petrol within 5 mi of SW6');
});

test('copying falls back where the clipboard API is missing or refuses', async () => {
  for (const navigator of [{}, { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }]) {
    const app = loadApp({ navigator });
    app.pendingPlace = { name: 'SW6 1AA', postcode: 'SW6 1AA' };
    app.copyPostcode();
    await settle();
    assert.deepEqual(app.document.copied, ['SW6 1AA']);
    assert.ok(app.el('pc-copy-btn').classList.contains('pc-copy-btn--copied'));
  }
  const written = [];
  const app = loadApp({ routes: [ISO, NO_STATIONS], navigator: { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } } });
  await travel(app);
  app.shareLink();
  await settle();
  assert.deepEqual(written, ['https://ldnmap.test/#p=51.50070,-0.12460&m=walking&q=Big%20Ben']);
  assert.ok(app.el('share-btn').classList.contains('share-btn--copied'));
});

test('suggestions that arrive after the box is cleared are dropped', async () => {
  const slow = deferred();
  const app = loadApp({ routes: [[/searchbox\/v1\/suggest/, () => slow.promise]] });
  app.openSearchOverlay();
  app.overlayInput.value = 'Hackney';
  app.fetchSuggest('Hackney');
  app.overlayInput.value = '';
  app.overlayInput.dispatch('input');
  slow.resolve(reply({ suggestions: [{ mapbox_id: 'x', name: 'Hackney' }] }));
  await settle();
  assert.deepEqual(plain(app.currentSuggestions), []);
  assert.match(app.el('overlay-sugg').innerHTML, /search-helper/);
});

test('suggestions answered out of order show the newest query', async () => {
  const first = deferred();
  const app = loadApp({ routes: [
    [/suggest\?q=Hack&/, () => first.promise],
    [/suggest\?q=Hackney&/, () => reply({ suggestions: [{ mapbox_id: 'b', name: 'Hackney' }] })]] });
  app.openSearchOverlay();
  app.fetchSuggest('Hack');
  app.fetchSuggest('Hackney');
  await settle();
  first.resolve(reply({ suggestions: [{ mapbox_id: 'a', name: 'Hackbridge' }] }));
  await settle();
  assert.deepEqual(plain(app.currentSuggestions.map((s) => s.name)), ['Hackney']);
});

const PARKING = [
  [/data\/parking\/rules\.json/, () => reply({ checked: '2026-11-01',
    boroughs: { x: { name: 'Xshire', bbox: [-0.3, 51.4, -0.2, 51.5], zoneCount: 1, knownHours: 1, detail: true } },
    rules: { 'x:A': { borough: 'x', zone: 'A', hours: 'Mon-Fri 9am-5pm', periods: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] } } })],
  [/data\/parking\/zones\.geojson/, () => reply({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { b: 'x', zone: 'A', rule: 'x:A', lx: -0.25, ly: 51.45 }, geometry: SQUARE }] })]
];
const parkingNotes = (app) => app.el('parking-body').querySelectorAll('.fuel-msg--warn').length;

test('parking from a postcode card moves the map without leaving padding on it', async () => {
  const app = loadApp({ routes: PARKING });
  app.pendingPlace = { lng: -0.25, lat: 51.45, name: 'X1', postcode: 'X1 1AA' };
  app.parkingFromPostcode();
  await settle();
  assert.equal(app.parkingOn, true);
  assert.ok(app.map.getLayer('parking-zones-fill'));
  const fly = app.map.calls.filter((c) => c.name === 'flyTo').pop();
  assert.deepEqual(plain(fly.options.center), [-0.25, 51.45]);
  assert.equal(fly.options.padding, undefined);
  assert.deepEqual(plain(fly.options.offset), [-170, 0], 'the place sits in the middle of the map left of the panel');
  assert.deepEqual({ ...app.map.getPadding() }, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(parkingNotes(app), 0);
});

test('parking: the "no data for that place" note stays until the user moves the map', async () => {
  const app = loadApp({ routes: PARKING });
  app.pendingPlace = { lng: -2.2426, lat: 53.4808, name: 'Manchester', postcode: 'M1 1AE' };
  app.parkingFromPostcode();
  await settle();
  assert.equal(app.map.calls.pop().name, 'fitBounds');
  assert.equal(parkingNotes(app), 1);
  app.map.fire('moveend', {});                         // the fit finishing
  assert.equal(parkingNotes(app), 1);
  app.map.fire('moveend', { originalEvent: {} });      // a drag
  assert.equal(parkingNotes(app), 0);
});

test('parking: a card waiting for ticket machines fills in when they load', async () => {
  const machines = deferred();
  const empty = () => reply({ type: 'FeatureCollection', features: [] });
  const app = loadApp({ routes: PARKING.concat([
    [/data\/parking\/x\/streets/, empty],
    [/data\/parking\/x\/kerb/, () => reply({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { kind: 'bay', side: 'both', zone: 'A' }, geometry: { type: 'LineString', coordinates: [[-0.25, 51.45], [-0.251, 51.45]] } }] })],
    [/data\/parking\/x\/machines/, () => machines.promise]]) });
  app.map.zoom = 16;
  app.map.center = { lng: -0.25, lat: 51.45 };
  app.toggleParking(true);
  await settle();
  app.setParkingSel({ kind: 'zone', b: 'x', zone: 'A', rule: 'x:A', lngLat: { lng: -0.25, lat: 51.45 } });
  assert.match(app.el('parking-body').textContent, /Ticket machines within 150 mLoading…/);
  machines.resolve(reply({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { id: 'M1', zone: 'A', type: 'Card only', pdf: '' }, geometry: { type: 'Point', coordinates: [-0.2501, 51.45] } }] }));
  await settle();
  assert.match(app.el('parking-body').textContent, /M1Card only7 m/);
  assert.deepEqual(plain(app.map.getSource('parking-kerb').def.data.features.map((f) => f.properties.o)), [-1, 1], 'a both-sides kerb is drawn on each side');
  app.toggleParking(false);
  assert.deepEqual(app.map.layerIds(), []);
});

test('a shared link restores its view; a bad one does nothing', async () => {
  const app = loadApp({ routes: [ISO, NO_STATIONS], hash: '#p=51.50070,-0.12460&m=cycling&b=15&q=Big%20Ben' });
  await settle();
  assert.equal(app.appState, 'travel');
  assert.equal(app.mode, 'cycling');
  assert.equal(app.selectedMin, 15);
  assert.equal(app.el('st').textContent, 'Big Ben');
  assert.match(app.fetched.filter((u) => /isochrone/.test(u))[0], /mapbox\/cycling\/-0\.1246,51\.5007\?/);

  const bad = loadApp({ routes: [ISO, NO_STATIONS], hash: '#p=abc,def&m=cycling' });
  await settle();
  assert.equal(bad.appState, 'idle');
});

// ---- Park near here ----
// A place at D in zone A of borough x, with streets a known number of metres east of it.
const D = [-0.25, 51.45];
const M_LNG = 1 / (111320 * Math.cos(51.45 * Math.PI / 180)), M_LAT = 1 / 110540;
const at = (east, north = 0) => [D[0] + east * M_LNG, D[1] + north * M_LAT];
const street = (name, rule, east, extra) => ({ type: 'Feature', properties: { name, zone: rule.split(':')[1], rule, cls: 4, ...extra },
  geometry: { type: 'LineString', coordinates: [at(east, -40), at(east, 40)] } });
const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }];
const rule = (zone, more) => ({ borough: 'x', zone, name: zone + ' zone', hours: 'Every day, all day', ...more });
const PARK_RULES = { checked: '2026-11-01', bankHolidays: [],
  boroughs: { x: { name: 'Xshire', bbox: [-0.3, 51.4, -0.2, 51.5], zoneCount: 4, knownHours: 3, detail: true } },
  rules: {
    'x:A': rule('A', { name: 'Alpha', periods: ALL_DAY, price: { perHour: 2 }, maxStay: '4 hours', payCode: { provider: 'PayByPhone', code: '1234' } }),
    'x:B': rule('B', { hours: 'No controls', periods: [] }),
    'x:P': rule('P', { periods: ALL_DAY, permitOnly: true }),
    'x:U': rule('U', { hours: 'Wording the map can’t read' }) } };
const SQUARE_AT = (c, r) => ({ type: 'Polygon', coordinates: [[[c[0] - r, c[1] - r], [c[0] + r, c[1] - r], [c[0] + r, c[1] + r], [c[0] - r, c[1] + r], [c[0] - r, c[1] - r]]] });
const PARK_ZONES = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { b: 'x', zone: 'A', rule: 'x:A', lx: D[0], ly: D[1] }, geometry: SQUARE_AT(D, 0.001) }] };
const STREETS = [
  street('Alpha Road', 'x:A', 100),
  street('Alpha Road', 'x:A', 400, { cls: 5 }),          // another piece of the same street: one result
  street('Bravo Street', 'x:B', 300),
  street('Unknown Way', 'x:U', 200),
  street('Permit Lane', 'x:P', 50),                       // permit holders only: never listed
  street('Red Route', 'x:A', 30, { tfl: 1 }),             // TfL rules, not the zone's
  street('', 'x:A', 20),                                   // unnamed
  street('Far Avenue', 'x:B', 3000)];                      // well over a 25 min walk
const collection = (features) => () => reply({ type: 'FeatureCollection', features });
// Walking seconds by how far east a point is: the Matrix answer.
const WALK_SECS = { 100: 60, 200: 300, 300: 480, 400: 600 };
function matrixReply(url) {
  const coords = url.split('/walking/')[1].split('?')[0].split(';').map((c) => c.split(',').map(Number));
  return reply({ code: 'Ok', durations: [coords.map((c, i) => (i === 0 ? 0 : WALK_SECS[Math.round((c[0] - D[0]) / M_LNG / 100) * 100]))] });
}
const parkRoutes = (streets, matrix) => [
  [/data\/parking\/rules\.json/, () => reply(PARK_RULES)],
  [/data\/parking\/zones\.geojson/, () => reply(PARK_ZONES)],
  [/data\/parking\/x\/streets/, collection(streets || STREETS)],
  [/data\/parking\/x\/(kerb|machines)/, collection([])],
  [/directions-matrix\/v1\/mapbox\/walking\//, matrix || matrixReply]];
const parkNames = (app) => app.el('park-body').querySelectorAll('.park-name').map((e) => e.textContent);
const parkRows = (app) => app.el('park-body').querySelectorAll('.park-row').map((e) => e.textContent);
const parkLayers = (app) => app.map.layerIds().filter((id) => id.indexOf('park-results') === 0);

// Open the view for a place at `where` and plan 10:00 today for 2 hours (the default stay).
function openPark(app, where) {
  const c = where || D;
  app.pendingPlace = { name: 'The Venue', lat: c[1], lng: c[0], postcode: 'X1 1AA' };
  app.openParkNear();
  app.parkPlan.dayIdx = 0;
  app.parkPlan.minutes = 600;
}

test('park near here: the place card has the button, usable once the place has a point', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button class="park-cta" id="postcode-park-btn" type="button" onclick="openParkNear\(\)" disabled>/);
  assert.ok(html.indexOf('id="postcode-park-btn"') < html.indexOf('id="postcode-cta-btn"'), 'above Check Travel Time');
  const app = loadApp({ routes: [BOUNDARY] });
  app.goToPostcode('SW6 1AA');
  assert.equal(app.el('postcode-park-btn').disabled, true, 'a bare postcode has no point until its boundary loads');
  await settle();
  assert.equal(app.el('postcode-park-btn').disabled, false);
  app.openParkNear();
  assert.equal(app.parkView, 'plan');
  assert.ok(app.el('park-panel').classList.contains('open'));
  assert.match(app.el('park-body').textContent, /ArrivalToday.*Now.*Stay30m1h2h3h4hAll day/);
  assert.equal(app.el('park-body').querySelectorAll('.park-primary')[0].textContent, 'Find parking');
});

test('park near here: plan, then the streets where the whole stay is allowed', async () => {
  const app = loadApp({ routes: parkRoutes() });
  openPark(app);
  app.parkPlanChanged();
  assert.match(app.el('park-body').querySelectorAll('.park-summary-main')[0].textContent, /^\w{3} 10:00am – 12:00pm$/);
  await app.parkFind();
  assert.equal(app.parkView, 'results');
  assert.equal(app.el('park-title').textContent, 'Parking near The Venue');
  assert.match(app.el('park-body').textContent, /^\w{3} 10:00am–12:00pm · 2hEdit/);
  // Walks from the Matrix answer (Alpha 1 min, Bravo 8), not the straight line; unreadable hours last.
  assert.deepEqual(parkNames(app), ['Alpha Road', 'Bravo Street', 'Unknown Way']);
  const matrix = app.fetched.filter((u) => /directions-matrix/.test(u));
  assert.equal(matrix.length, 1);
  assert.match(matrix[0], /\/walking\/-0\.250000,51\.450000;[^?]*\?sources=0&annotations=duration&access_token=/);
  assert.equal(matrix[0].split('?')[0].split(';').length, 4, 'the place and the three streets left after planning');
  const rows = parkRows(app);
  assert.match(rows[0], /^1minAlpha RoadZone A · Alpha4h max · fits 2h£4\.00paid all stay$/);
  assert.match(rows[1], /^8minBravo StreetZone B · B zoneFree$/);
  assert.match(rows[2], /Check signs$/);
  assert.match(app.el('park-body').textContent, /not whether a space is free\. Check the signs\.$/);
  assert.equal(app.el('park-body').querySelectorAll('.pk-note').length, 0, 'the place is in a zone');

  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Bravo Street', 'Alpha Road', 'Unknown Way']);

  // On the map: the results over the parking layer, which this turned on with its panel shut.
  assert.deepEqual(parkLayers(app), ['park-results-casing', 'park-results-line', 'park-results-sel']);
  assert.equal(app.map.layerIds().slice(-3).join(), 'park-results-casing,park-results-line,park-results-sel');
  assert.ok(app.map.getLayer('parking-zones-fill'));
  assert.equal(app.el('parking-panel').classList.contains('open'), false);
  const feats = app.map.getSource('park-results').def.data.features;
  assert.deepEqual(plain(feats.map((f) => app.parkResults[f.properties.i].name + ':' + f.properties.state)).sort(),
    ['Alpha Road:paid', 'Alpha Road:paid', 'Bravo Street:free', 'Unknown Way:unknown']);
  assert.equal(app.map.calls.pop().name, 'fitBounds');

  // A street's card.
  const alpha = app.parkResults.findIndex((r) => r.name === 'Alpha Road');
  app.parkShowDetail(alpha);
  const card = app.el('park-body').textContent;
  assert.match(card, /^Alpha RoadZone A · Alpha · XshirePay to park all stay1 min walk to The Venue/);
  assert.match(card, /10am–12pm2h × £2\.00£4\.00Total£4\.00/);
  assert.match(card, /Max stay4 hours · your 2h stay fits/);
  assert.match(card, /Pay by phonePayByPhone location 1234/);
  const dir = app.el('park-body').querySelectorAll('.park-primary')[0];
  assert.equal(dir.textContent, 'Directions');
  assert.match(dir.href, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=51\.450000,-0\.248\d+&travelmode=driving$/);
  assert.equal(dir.target, '_blank');
  const fly = app.map.calls.pop();
  assert.equal(fly.name, 'flyTo');
  assert.equal(fly.options.padding, undefined);
  app.parkBack();
  assert.equal(app.parkView, 'results');
  app.parkBack();
  assert.equal(app.parkView, 'plan', 'back from the list is Edit');
  assert.deepEqual(parkLayers(app), [], 'results for the old plan come off the map');
});

test('park near here: nearest and cheapest orders', async () => {
  const paid2h = [{ start: 0, end: 120, status: 'ctrl' }];
  const tariff = (basis, min, max, by) => ({ min, max, exact: min === max, basis, by: by || null, bands: null, note: null, url: null });
  const ok = (segments, paidMin, costMin, costMax, t) => ({ ok: true, status: 'ok', segments, paidMin,
    cost: t && t.exact ? costMin : paidMin ? null : 0, costMin, costMax, tariff: t || null, perHour: t && t.exact ? t.min : null,
    maxStayMin: null, longestPaidMin: paidMin, freeAll: paidMin === 0 });
  const plans = {
    'x:A': ok(paid2h, 120, 4.64, 4.64, tariff('zone', 2.32, 2.32)),
    'x:B': ok([{ start: 0, end: 120, status: 'free' }], 0, 0, 0, null),
    'x:C': ok([{ start: 0, end: 60, status: 'ctrl' }, { start: 60, end: 120, status: 'free' }], 60, null, null, null),
    'x:D': { ok: false, status: 'unknown', segments: [{ start: 0, end: 120, status: 'unknown' }], paidMin: 0, cost: null, costMin: null, costMax: null, tariff: null, perHour: null, maxStayMin: null, longestPaidMin: 0, freeAll: false },
    'x:E': ok([{ start: 0, end: 60, status: 'free' }, { start: 60, end: 120, status: 'ctrl' }], 60, 2, 2, tariff('flat', 2, 2)),
    'x:F': ok(paid2h, 120, 3, 9, tariff('bands', 1.5, 4.5, 'emissions')),
    'x:G': ok(paid2h, 120, 4, null, tariff('from', 2, null, 'emissions')),
    'x:H': ok(paid2h, 120, 6, 12, tariff('fuel', 3, 6, 'fuel')),
    'x:P': { ok: false, status: 'permit', segments: [], paidMin: 0, cost: null, costMin: null, costMax: null, tariff: null, perHour: null, maxStayMin: null, longestPaidMin: 0, freeAll: false },
    'x:M': { ok: false, status: 'maxstay', segments: [], paidMin: 240, cost: 9, costMin: 9, costMax: 9, tariff: tariff('zone', 2, 2), perHour: 2, maxStayMin: 60, longestPaidMin: 240, freeAll: false } };
  const streets = [street('Ash', 'x:A', 100), street('Beech', 'x:B', 500), street('Cedar', 'x:C', 150), street('Dock', 'x:D', 50),
    street('Elm', 'x:E', 400), street('Fir', 'x:F', 250), street('Gorse', 'x:G', 320), street('Holly', 'x:H', 600),
    street('Pine', 'x:P', 60), street('Maple', 'x:M', 70)];
  // No Matrix answer (an error): the straight-line estimates stand.
  const app = loadApp({ routes: parkRoutes(streets, () => reply({ message: 'Not Authorized' }, 401)) });
  app.planStay = (key) => plans[key];
  openPark(app);
  await app.parkFind();
  assert.deepEqual(parkNames(app), ['Ash', 'Cedar', 'Fir', 'Gorse', 'Elm', 'Beech', 'Holly', 'Dock']);
  assert.deepEqual(plain(app.parkResults.map((r) => r.name + ' ' + r.walk)),
    ['Ash 2', 'Beech 9', 'Cedar 3', 'Dock 1', 'Elm 7', 'Fir 5', 'Gorse 6', 'Holly 10']);
  const rows = parkRows(app);
  assert.match(rows[0], /^2minAsh.*£4\.64paid all stay$/, 'an exact price has no basis line');
  assert.match(rows[1], /^3minCedar.*Price unknownpaid 10–11am, free after$/);
  assert.match(rows[2], /^5minFir.*£3\.00–£9\.00paid all stayby car emissions$/);
  assert.match(rows[3], /^6minGorse.*from £4\.00paid all stayby car emissions$/);
  assert.match(rows[4], /^7minElm.*£2\.00free 10–11am, paid after$/);
  assert.match(rows[6], /^10minHolly.*£6\.00–£12\.00paid all stayby fuel type$/);
  assert.match(rows[7], /^1minDock.*Check signs$/);
  // A range can wrap after its dash rather than squeeze the street name.
  const fir = app.el('park-body').querySelectorAll('.park-amt')[2];
  assert.deepEqual(fir.children.map((c) => c.tagName.toLowerCase()), ['#text', 'wbr', '#text']);
  // Cheapest: free first, then by the lowest cost (a range or 'from' by its bottom), unknown prices
  // after every known one, hours that couldn't be read last.
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Beech', 'Elm', 'Fir', 'Gorse', 'Ash', 'Holly', 'Cedar', 'Dock']);
});

// Prices the way the real data holds them: x prices by its rules (a Westminster-style rule with
// its own emission bands, and a 4 hour council default max stay), y by borough emission bands (one
// rule with a 'from' price of its own), z only has a note.
const PRICE_ZONE = (b, east) => ({ type: 'Feature', properties: { b, zone: 'Q', rule: b + ':Q', lx: at(east)[0], ly: D[1] }, geometry: SQUARE_AT(at(east), 0.001) });
const PRICE_NOTE = 'Prices are set street by street (e.g. Agdon Street is £7.30/hour, 2h max). Mon–Fri 10am–1pm adds a peak surcharge in most zones, '
  + 'and diesel cars pay more everywhere. See the council’s list of streets for each tariff.';
const PRICE_RULES = { checked: '2026-11-01', bankHolidays: [],
  boroughs: {
    x: { name: 'Xshire', bbox: [-0.3, 51.4, -0.2, 51.5], zoneCount: 1, knownHours: 1, detail: true, maxStayDefault: '4 hours',
      charges: { model: 'zone', note: 'By parent zone and CO2 band.', url: 'https://x.example/tariffs.pdf' } },
    y: { name: 'Yshire', bbox: [-0.3, 51.4, -0.2, 51.5], zoneCount: 1, knownHours: 1, detail: true,
      charges: { bands: [{ band: 'A', co2: '0 g/km', perHour: 2.5 }, { band: 'B', co2: '1–100 g/km', perHour: 3 }, { band: 'C', co2: '101+ g/km', perHour: 5 }],
        url: 'https://y.example/charges' } },
    z: { name: 'Zshire', bbox: [-0.3, 51.4, -0.2, 51.5], zoneCount: 1, knownHours: 1, detail: true,
      charges: { model: 'note', note: PRICE_NOTE, url: 'https://z.example/parking' } } },
  rules: {
    'x:W': rule('W', { name: 'West End', periods: ALL_DAY, price: { bands: [
      { band: 1, co2: '0–50 g/km', perHour: 4.78 }, { band: 2, co2: '51–100 g/km', perHour: 6 }, { band: 3, co2: '101–150 g/km', perHour: 7.5 },
      { band: 4, co2: '151–200 g/km', perHour: 9 }, { band: 5, co2: 'over 200 g/km', perHour: 10.58 }], url: 'https://x.example/zone-w.pdf' } }),
    'y:F': { ...rule('F', { periods: ALL_DAY, price: { perHour: 2.5 } }), borough: 'y' },
    'y:Y': { ...rule('Y', { periods: ALL_DAY }), borough: 'y' },
    'z:N': { ...rule('N', { periods: ALL_DAY }), borough: 'z' } } };
const priceRoutes = () => [
  [/data\/parking\/rules\.json/, () => reply(PRICE_RULES)],
  [/data\/parking\/zones\.geojson/, () => reply({ type: 'FeatureCollection', features: [PRICE_ZONE('x', 0), PRICE_ZONE('y', 600), PRICE_ZONE('z', -600)] })],
  [/data\/parking\/x\/streets/, collection([street('Wren Street', 'x:W', 100)])],
  [/data\/parking\/y\/streets/, collection([street('Yew Road', 'y:Y', 200), street('Fern Lane', 'y:F', 300)])],
  [/data\/parking\/z\/streets/, collection([street('Nook Street', 'z:N', 150)])],
  [/data\/parking\/[xyz]\/(kerb|machines)/, collection([])],
  [/directions-matrix\/v1\/mapbox\/walking\//, () => reply({ message: 'Not Authorized' }, 401)]];

test('park near here: prices from rule bands, borough bands, a "from" price and a council note', async () => {
  const app = loadApp({ routes: priceRoutes() });
  openPark(app);
  await app.parkFind();
  assert.deepEqual(parkNames(app), ['Wren Street', 'Nook Street', 'Yew Road', 'Fern Lane']);
  const rows = parkRows(app);
  // The rule's own bands: £4.78–£10.58 an hour for 2 hours; no maxStay, so the council's 4 hour default
  assert.match(rows[0], /^2minWren StreetZone W · West End4h max · fits 2h£9\.56–£21\.16paid all stayby car emissions$/);
  assert.match(rows[1], /^3minNook Street.*Price unknownpaid all stay$/);
  assert.match(rows[2], /^4minYew Road.*£5\.00–£10\.00paid all stayby car emissions$/);
  assert.match(rows[3], /^5minFern Lane.*from £5\.00paid all stayby car emissions$/);
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Yew Road', 'Fern Lane', 'Wren Street', 'Nook Street'], 'a tie at £5 goes to the shorter walk');

  const priceLink = (body) => body.descendants().filter((e) => e.tagName === 'A' && /parking charges/.test(e.textContent))[0];
  const card = (name) => {
    app.parkShowDetail(app.parkResults.findIndex((r) => r.name === name));
    return app.el('park-body');
  };
  // Bands: the paid time at the range, then what each band pays for this stay, and the council's prices.
  let body = card('Wren Street');
  let text = body.textContent;
  assert.match(text, /10am–12pm2h × £4\.78–£10\.58£9\.56–£21\.16Total£9\.56–£21\.16/);
  assert.match(text, /By emissions band · 2h paidBand 1 \(0–50 g\/km\)£9\.56Band 2 \(51–100 g\/km\)£12\.00Band 3 \(101–150 g\/km\)£15\.00Band 4 \(151–200 g\/km\)£18\.00Band 5 \(over 200 g\/km\)£21\.16/);
  assert.match(text, /PricesXshire parking charges/);
  assert.match(text, /Max stay4 hours \(council default\) · your 2h stay fits/);
  assert.equal(priceLink(body).href, 'https://x.example/zone-w.pdf', 'the rule’s own link first');
  // A 'from' price: the cheapest band's cost, said so.
  text = card('Fern Lane').textContent;
  assert.match(text, /10am–12pm2h × from £2\.50from £5\.00Totalfrom £5\.00/);
  assert.match(text, /from £5\.00: the lowest rate published for this zone\. The price depends on your car’s emissions, so yours may be higher\./);
  assert.match(text, /PricesYshire parking charges/);
  assert.doesNotMatch(text, /By emissions band/);
  // Borough bands
  text = card('Yew Road').textContent;
  assert.match(text, /By emissions band · 2h paidBand A \(0 g\/km\)£5\.00Band B \(1–100 g\/km\)£6\.00Band C \(101\+ g\/km\)£10\.00/);
  // No prices in the data: the council's note, cut short, and its link.
  body = card('Nook Street');
  text = body.textContent;
  assert.match(text, /10am–12pm2h, price unknown\?TotalUnknown/);
  assert.match(text, /Prices are set street by street \(e\.g\. Agdon Street is £7\.30\/hour, 2h max\)\. Mon–Fri 10am–1pm adds a peak surcharge in most zones, and diesel cars pay more everywhere\.PricesZshire parking charges/);
  assert.doesNotMatch(text, /list of streets for each tariff/, 'shortened to whole sentences');
  assert.equal(priceLink(body).href, 'https://z.example/parking');
});

test('park near here: a place outside every zone says so, and still lists zone streets in reach', async () => {
  const app = loadApp({ routes: parkRoutes() });
  openPark(app, at(-250));                                // 250 m west of zone A's square
  await app.parkFind();
  assert.equal(app.parkInfo.inZone, false);
  assert.match(app.el('park-body').querySelectorAll('.pk-note')[0].textContent,
    /^The Venue isn’t in a controlled parking zone: most streets nearby have no parking controls\. Watch for yellow lines and signs\.$/);
  assert.ok(parkNames(app).indexOf('Alpha Road') !== -1);
});

test('park near here: nothing fits the stay offers to shorten it', async () => {
  const app = loadApp({ routes: parkRoutes([street('Permit Lane', 'x:P', 50)]) });
  openPark(app);
  await app.parkFind();
  assert.match(app.el('park-body').textContent, /No streets within a 20 min walk allow this stay/);
  app.el('park-body').querySelectorAll('.park-primary')[0].dispatch('click');
  assert.equal(app.parkView, 'plan');
});

test('park near here: a late Matrix answer after closing or editing is dropped', async () => {
  for (const leave of ['close', 'edit', 'new place']) {
    const matrix = deferred();
    const app = loadApp({ routes: parkRoutes(null, () => matrix.promise).concat([ISO, NO_STATIONS]) });
    openPark(app);
    app.parkFind();
    await settle();
    assert.equal(app.parkView, 'loading');
    if (leave === 'close') app.closeParkNear();
    else if (leave === 'edit') app.parkShowPlan();
    else app.goToPlace({ ...BIG_BEN });
    matrix.resolve(matrixReply(app.fetched.filter((u) => /directions-matrix/.test(u))[0]));
    await settle();
    assert.equal(app.parkResults.length, 0, leave);
    assert.deepEqual(parkLayers(app), [], leave);
    assert.equal(app.parkView, leave === 'edit' ? 'plan' : null, leave);
    if (leave !== 'edit') {
      assert.equal(app.parkingOn, false, 'the parking layer it turned on goes too');
      assert.equal(app.map.layerIds().filter((id) => id.indexOf('parking-') === 0).length, 0);
      assert.equal(app.el('park-panel').classList.contains('open'), false);
    }
  }
});

test('park near here: results come back after a theme switch and go when it closes', async () => {
  const app = loadApp({ routes: parkRoutes() });
  openPark(app);
  await app.parkFind();
  app.parkShowDetail(0);
  app.toggleTheme();
  assert.deepEqual(app.map.layerIds(), []);
  app.map.finishStyle();
  assert.equal(app.map.layerIds().slice(-3).join(), 'park-results-casing,park-results-line,park-results-sel');
  assert.ok(app.map.getLayer('parking-zones-fill'));
  app.rehydrateLayers();                               // twice on one style is harmless
  assert.deepEqual(parkLayers(app), ['park-results-casing', 'park-results-line', 'park-results-sel']);
  app.closeParkNear();
  assert.deepEqual(app.map.layerIds(), []);
  assert.equal(app.parkData, null);
});

test('park near here: the parking layer, if it was on, is handed back as it was', async () => {
  const app = loadApp({ routes: parkRoutes() });
  app.toggleParking(true);
  await settle();
  const before = plain(app.parkingWhen);
  openPark(app);
  assert.equal(app.el('parking-panel').classList.contains('open'), false, 'the panels share a spot');
  await app.parkFind();
  assert.equal(app.parkingNow, false, 'coloured for the arrival');
  assert.equal(app.parkingWhen.minutes, 600);
  app.closeParkNear();
  assert.equal(app.parkingOn, true);
  assert.equal(app.parkingNow, true);
  assert.deepEqual(plain(app.parkingWhen), before);
  assert.ok(app.el('parking-panel').classList.contains('open'));
  assert.ok(app.map.getLayer('parking-zones-fill'));
  assert.deepEqual(parkLayers(app), []);
  // The P button with the view open turns both off.
  openPark(app);
  await app.parkFind();
  app.toggleParking(false);
  assert.equal(app.parkPlace, null);
  assert.deepEqual(app.map.layerIds(), []);
});
