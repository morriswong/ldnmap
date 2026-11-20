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
  assert.equal(app.el('postcode-park-btn').disabled, true, 'no point to look up parking for yet');
  await settle();
  assert.equal(app.el('postcode-cta-btn').disabled, false);
  assert.equal(app.el('postcode-park-btn').disabled, false);
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
    // An odd street in zone A: its own pay-by-phone strip at a different price.
    'x:A-mkt': rule('A', { name: 'Market Row', streets: ['Market Row'], periods: ALL_DAY, price: { perHour: 3 }, maxStay: '4 hours',
      payCode: { provider: 'PayByPhone', code: '5678' } }),
    'x:B': rule('B', { hours: 'No controls', periods: [] }),
    'x:P': rule('P', { periods: ALL_DAY, permitOnly: true }),
    'x:U': rule('U', { hours: 'Wording the map can’t read' }),
    // For "now": paid 9am–6:30pm (4 hours max), paid evenings by emissions band, permit holders only 6–8pm.
    'x:N': rule('N', { hours: 'Every day 9am–6:30pm', periods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '18:30' }],
      price: { perHour: 2.32 }, maxStay: '4 hours' }),
    'x:V': rule('V', { hours: 'Every day 7pm–midnight', periods: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '19:00', to: '24:00' }],
      price: { bands: [{ band: 1, perHour: 4.78 }, { band: 2, perHour: 10.58 }] } }),
    'x:Q': rule('Q', { hours: 'Permit holders only 6pm–8pm', periods: [], permit: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '18:00', to: '20:00' }] }) } };
const SQUARE_AT = (c, r) => ({ type: 'Polygon', coordinates: [[[c[0] - r, c[1] - r], [c[0] + r, c[1] - r], [c[0] + r, c[1] + r], [c[0] - r, c[1] + r], [c[0] - r, c[1] - r]]] });
const PARK_ZONES = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { b: 'x', zone: 'A', rule: 'x:A', lx: D[0], ly: D[1] }, geometry: SQUARE_AT(D, 0.001) }] };
const STREETS = [
  street('Alpha Road', 'x:A', 100),
  street('Alpha Road', 'x:A', 400, { cls: 5 }),          // another piece of the same street: one result
  street('Market Row', 'x:A-mkt', 200, { zone: 'A' }),    // its own rule in zone A: a row of its own
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
const parkZoneLayers = (app) => app.map.layerIds().filter((id) => id.indexOf('park-zones') === 0);

// Open the view for a place at `where`: it looks up where you can park now straight away.
function openParkNow(app, where) {
  const c = where || D;
  app.pendingPlace = { name: 'The Venue', lat: c[1], lng: c[0], postcode: 'X1 1AA' };
  return app.openParkNear();
}
// Open it and plan 10:00 today for 2 hours, as Change would; the test's parkFind() then overtakes
// the "now" lookup the opening started.
function openPark(app, where) {
  openParkNow(app, where);
  Object.assign(app.parkPlan, { dayIdx: 0, minutes: 600, stay: 120, now: false });
}

test('park near here: the place card has the button, usable once the place has a point', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button class="park-cta" id="postcode-park-btn" type="button" onclick="openParkNear\(\)" disabled>/);
  assert.ok(html.indexOf('id="postcode-park-btn"') < html.indexOf('id="postcode-cta-btn"'), 'above Check Travel Time');
  const app = loadApp({ routes: [BOUNDARY].concat(parkRoutes()) });
  app.goToPostcode('SW6 1AA');
  assert.equal(app.el('postcode-park-btn').disabled, true, 'a bare postcode has no point until its boundary loads');
  await settle();
  assert.equal(app.el('postcode-park-btn').disabled, false);
  // Straight to the results for now, with no stay chosen: no plan screen first.
  const found = app.openParkNear();
  assert.equal(app.parkView, 'loading');
  assert.ok(app.el('park-panel').classList.contains('open'));
  await found;
  assert.equal(app.parkView, 'results');
  assert.equal(app.parkPlan.stay, null);
  assert.equal(app.parkPlan.now, true);
  assert.match(app.el('park-body').textContent, /^Now · any lengthChange/);
  // Change opens the plan, with Any as the stay.
  app.el('park-body').querySelectorAll('.park-edit')[0].dispatch('click');
  assert.equal(app.parkView, 'plan');
  assert.match(app.el('park-body').textContent, /ArrivalToday.*Now.*StayAny30m1h2h3h4hAll day/);
  assert.deepEqual(app.el('park-body').querySelectorAll('.park-stays')[0].children.filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent), ['Any']);
  assert.match(app.el('park-body').querySelectorAll('.park-summary-main')[0].textContent, /^Now · any length$/);
  assert.equal(app.el('park-body').querySelectorAll('.park-primary')[0].textContent, 'Find parking');
});

test('park near here: plan, then the zones and odd streets where the whole stay is allowed', async () => {
  const app = loadApp({ routes: parkRoutes() });
  openPark(app);
  app.parkShowPlan();
  assert.match(app.el('park-body').querySelectorAll('.park-summary-main')[0].textContent, /^\w{3} 10:00am – 12:00pm$/);
  await app.parkFind();
  assert.equal(app.parkView, 'results');
  assert.equal(app.el('park-title').textContent, 'Parking near The Venue');
  assert.match(app.el('park-body').textContent, /^\w{3} 10:00am · 2hChange/);
  assert.equal(app.el('park-back').hidden, true, 'Change, not Back, opens the plan');
  // One row per zone, and Market Row (its own rule in zone A) on its own. The Venue is in zone A:
  // about a minute. The rest walk as the Matrix answers (Market Row 5 min, zone B's nearest street
  // 8), not the straight line; unreadable hours last.
  assert.deepEqual(parkNames(app), ['Zone A · Alpha', 'Market Row', 'Zone B · B zone', 'Zone U · U zone']);
  const matrix = app.fetched.filter((u) => /directions-matrix/.test(u));
  assert.equal(matrix.length, 1);
  assert.match(matrix[0], /\/walking\/-0\.250000,51\.450000;[^?]*\?sources=0&annotations=duration&access_token=/);
  assert.equal(matrix[0].split('?')[0].split(';').length, 4, 'the place and the three rows left after planning, not the zone it’s in');
  const rows = parkRows(app);
  assert.match(rows[0], /^1minZone A · AlphaThe Venue is in this zone · Xshire4h max · fits 2h£4\.00paid all stay$/);
  assert.match(rows[1], /^5minMarket RowZone A · Alpha4h max · fits 2h£6\.00paid all stay$/);
  assert.match(rows[2], /^8minZone B · B zoneNearest: Bravo Street · XshireFree$/);
  assert.match(rows[3], /Check signs$/);
  assert.match(app.el('park-body').textContent, /not whether a space is free\. Check the signs\.$/);
  assert.equal(app.el('park-body').querySelectorAll('.pk-note').length, 0, 'the place is in a zone');

  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Zone B · B zone', 'Zone A · Alpha', 'Market Row', 'Zone U · U zone']);

  // On the map: the results over the parking layer, which this turned on with its panel shut.
  assert.deepEqual(parkLayers(app), ['park-results-casing', 'park-results-line', 'park-results-sel']);
  assert.deepEqual(parkZoneLayers(app), ['park-zones-fill', 'park-zones-line'], 'zone A’s outline (B and U have none in the data)');
  assert.equal(app.map.layerIds().slice(-3).join(), 'park-results-casing,park-results-line,park-results-sel');
  assert.ok(app.map.getLayer('parking-zones-fill'));
  assert.equal(app.el('parking-panel').classList.contains('open'), false);
  const feats = app.map.getSource('park-results').def.data.features;
  assert.deepEqual(plain(feats.map((f) => app.parkResults[f.properties.i].name + ':' + f.properties.kind + ':' + f.properties.state)).sort(),
    ['Market Row:street:paid', 'Zone A:zone:paid', 'Zone A:zone:paid', 'Zone B:zone:free', 'Zone B:zone:free', 'Zone U:zone:unknown']);
  assert.equal(app.map.calls.pop().name, 'fitBounds');

  // A zone's card: its hours and price, its nearest street, and its odd streets.
  const zoneA = app.parkResults.findIndex((r) => r.kind === 'zone' && r.zone === 'A');
  app.parkShowDetail(zoneA);
  let card = app.el('park-body').textContent;
  assert.match(card, /^Zone A · AlphaXshirePay to park all stayThe Venue is in this zone/);
  assert.match(card, /10am–12pm2h × £2\.00£4\.00Total£4\.00/);
  assert.match(card, /Max stay4 hours · your 2h stay fits/);
  assert.match(card, /ControlledEvery day, all day/);
  assert.match(card, /Pay by phonePayByPhone location 1234/);
  assert.match(card, /Nearest streetAlpha RoadWalkAbout 1 min: The Venue is in this zone/);
  assert.match(card, /Streets here with their own rules5minMarket RowZone A · Alpha4h max · fits 2h£6\.00paid all stay/);
  let dir = app.el('park-body').querySelectorAll('.park-primary')[0];
  assert.equal(dir.textContent, 'Directions');
  assert.match(dir.href, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=51\.450000,-0\.248\d+&travelmode=driving$/, 'to its nearest street');
  assert.equal(dir.target, '_blank');
  assert.equal(app.map.calls.pop().name, 'fitBounds', 'the map frames the zone');

  // An odd street's card, from the zone's sub-list.
  app.el('park-body').querySelectorAll('.park-sublist')[0].querySelectorAll('.park-row')[0].dispatch('click');
  card = app.el('park-body').textContent;
  assert.match(card, /^Market RowZone A · Alpha · XshirePay to park all stay5 min walk to The Venue/);
  assert.match(card, /10am–12pm2h × £3\.00£6\.00Total£6\.00/);
  assert.match(card, /Pay by phonePayByPhone location 5678/);
  assert.doesNotMatch(card, /Nearest street|own rules/);
  dir = app.el('park-body').querySelectorAll('.park-primary')[0];
  assert.match(dir.href, /destination=51\.450000,-0\.247\d+&/);
  const fly = app.map.calls.pop();
  assert.equal(fly.name, 'flyTo');
  assert.equal(fly.options.padding, undefined);
  app.parkBack();
  assert.equal(app.parkView, 'results');
  app.parkBack();
  assert.equal(app.parkView, 'results', 'nothing behind the list');
  // Change: the plan, its results off the map; Back looks the same plan up again.
  app.el('park-body').querySelectorAll('.park-edit')[0].dispatch('click');
  assert.equal(app.parkView, 'plan');
  assert.deepEqual(parkLayers(app), [], 'results for the old plan come off the map');
  assert.equal(app.el('park-back').hidden, false);
  assert.equal(app.el('park-back').getAttribute('aria-label'), 'Back to results');
  app.parkPlan.stay = 60;                              // changed, then not used
  await app.parkBack();
  assert.equal(app.parkView, 'results');
  assert.equal(app.parkPlan.stay, 120);
  assert.match(app.el('park-body').textContent, /^\w{3} 10:00am · 2hChange/);
  assert.equal(parkLayers(app).length, 3);
});

// With no stay chosen: how long each street allows from now, at the hourly rate.
const NOW_STREETS = [street('Alpha Road', 'x:A', 100), street('Bravo Street', 'x:B', 300), street('Unknown Way', 'x:U', 200),
  street('Permit Lane', 'x:P', 50), street('Nine Road', 'x:N', 400), street('Vesper Way', 'x:V', 650), street('Quay Lane', 'x:Q', 800)];

test('park near here: no stay chosen lists where you can park now, the rate and for how long', async () => {
  const app = loadApp({ routes: parkRoutes(NOW_STREETS) });
  app.parkNowMinutes = () => 17 * 60;                 // 5pm
  await openParkNow(app);
  assert.equal(app.parkView, 'results');
  assert.match(app.el('park-body').textContent, /^Now · any lengthChange/);
  const change = app.el('park-body').querySelectorAll('.park-edit')[0];
  assert.equal(change.textContent, 'Change');
  assert.equal(change.tagName, 'BUTTON');
  // One street per zone here, so one row per zone. Zone P is permit holders only now: gone.
  // Unreadable hours last.
  assert.deepEqual(parkNames(app), ['Zone A · Alpha', 'Zone B · B zone', 'Zone N · N zone', 'Zone V · V zone', 'Zone Q · Q zone', 'Zone U · U zone']);
  const rows = parkRows(app);
  assert.match(rows[0], /^1minZone A · AlphaThe Venue is in this zone · XshireUp to 4h, until 9pm£2\.00\/hr$/);
  assert.match(rows[1], /^8minZone B · B zoneNearest: Bravo Street · XshireFree, no time limitFree$/);
  assert.match(rows[2], /^10minZone N · N zoneNearest: Nine Road · XshirePaid until 6:30pm, then free£2\.32\/hr$/);
  assert.match(rows[3], /^11minZone V · V zoneNearest: Vesper Way · XshireFree until 7pm, then paidFreethen £4\.78–£10\.58\/hr$/);
  assert.match(rows[4], /^14minZone Q · Q zoneNearest: Quay Lane · XshireFree until 6pm, then permit holders onlyFree$/);
  assert.match(rows[5], /^5minZone U · U zoneNearest: Unknown Way · XshireHours couldn’t be readCheck signs$/);
  // On the map, each zone's streets in its state now.
  const feats = app.map.getSource('park-results').def.data.features;
  assert.deepEqual(plain(feats.map((f) => app.parkResults[f.properties.i].name + ':' + f.properties.state)).sort(),
    ['Zone A:paid', 'Zone B:free', 'Zone N:paid', 'Zone Q:free', 'Zone U:unknown', 'Zone V:free']);
  // Cheapest: by the hourly rate now, free first.
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Zone B · B zone', 'Zone V · V zone', 'Zone Q · Q zone', 'Zone A · Alpha', 'Zone N · N zone', 'Zone U · U zone']);

  // A zone's card covers the time you can stay (up to 24 hours) and what it costs.
  const card = (name) => {
    app.parkShowDetail(app.parkResults.findIndex((r) => r.name === name));
    return app.el('park-body').textContent;
  };
  let text = card('Zone A');
  assert.match(text, /^Zone A · AlphaXshireUp to 4h, until 9pmThe Venue is in this zone/);
  assert.match(text, /From now · until 9pm/);
  assert.match(text, /5–9pm4h × £2\.00£8\.00Total, until 9pm£8\.00/);
  assert.match(text, /Max stay4 hoursControlled/, 'no stay to fit');
  text = card('Zone B');
  assert.match(text, /^Zone B · B zoneXshireFree, no time limit8 min walk to The Venue from Bravo Street/);
  assert.match(text, /From now · next 24h/);
  assert.match(text, /Total, 24hFree/);
  assert.match(text, /Nearest streetBravo StreetWalk8 min to The Venue/);
  text = card('Zone V');
  assert.match(text, /5–7pm2h, no chargeFree7pm–midnight5h × £4\.78–£10\.58£23\.90–£52\.90midnight–5pm17h, no chargeFreeTotal, 24h£23\.90–£52\.90/);
  assert.match(text, /By emissions band · 5h paid/);
  app.parkBack();
  assert.equal(app.parkView, 'results');
});

test('park near here: late in the evening, times run into tomorrow', async () => {
  const app = loadApp({ routes: parkRoutes(NOW_STREETS) });
  app.parkNowMinutes = () => 22 * 60;                 // 10pm
  await openParkNow(app);
  const line = (name) => app.el('park-body').querySelectorAll('.park-row').filter((r) => r.textContent.indexOf(name) !== -1)[0]
    .descendants().filter((e) => e.classList && e.classList.contains('park-stay'))[0].textContent;
  assert.equal(line('Zone N'), 'Free until 9am tomorrow, then paid until 1pm tomorrow');
  assert.equal(line('Zone V'), 'Paid until midnight, then free');
  assert.equal(line('Zone Q'), 'Free until 6pm tomorrow, then permit holders only');
  assert.equal(line('Zone A'), 'Up to 4h, until 2am tomorrow');
});

test('park near here: Change plans a stay for later; Back returns to the "now" list', async () => {
  const app = loadApp({ routes: parkRoutes(NOW_STREETS) });
  app.parkNowMinutes = () => 17 * 60;
  await openParkNow(app);
  const matrixCalls = () => app.fetched.filter((u) => /directions-matrix/.test(u)).length;
  assert.equal(matrixCalls(), 1);
  app.el('park-body').querySelectorAll('.park-edit')[0].dispatch('click');
  assert.equal(app.parkView, 'plan');
  assert.equal(app.el('park-title').textContent, 'Park near The Venue');
  assert.equal(app.el('park-back').hidden, false);
  assert.deepEqual(parkLayers(app), []);
  await app.parkBack();
  assert.equal(app.parkView, 'results');
  assert.match(app.el('park-body').textContent, /^Now · any lengthChange/);
  assert.equal(parkNames(app).length, 6);
  assert.equal(matrixCalls(), 2, 'looked up again for the time now');

  // Pick 2 hours and find: whole-stay costs, streets the stay fits.
  app.parkShowPlan();
  const chip = app.el('park-body').querySelectorAll('.park-stays')[0].children.filter((b) => b.textContent === '2h')[0];
  chip.dispatch('click');
  assert.match(app.el('park-body').querySelectorAll('.park-summary-main')[0].textContent, /^\w{3} 5:00pm – 7:00pm$/);
  await app.el('park-body').querySelectorAll('.park-primary')[0].dispatch('click');
  await settle();
  assert.equal(app.parkView, 'results');
  assert.match(app.el('park-body').textContent, /^Now · 2hChange/);
  assert.equal(app.el('park-back').hidden, true);
  const rows = parkRows(app);
  assert.match(rows[0], /^1minZone A · AlphaThe Venue is in this zone · Xshire4h max · fits 2h£4\.00paid all stay$/);
  // Zone Q turns permit-only at 6pm, within the stay: gone.
  assert.equal(parkNames(app).indexOf('Zone Q · Q zone'), -1);
  assert.notEqual(parkNames(app).indexOf('Zone V · V zone'), -1);
});

test('park near here: nowhere to park now offers to plan for later', async () => {
  const app = loadApp({ routes: parkRoutes([street('Permit Lane', 'x:P', 50)]) });
  await openParkNow(app);
  assert.match(app.el('park-body').textContent, /Nowhere within a 20 min walk you can park now/);
  const btn = app.el('park-body').querySelectorAll('.park-primary')[0];
  assert.equal(btn.textContent, 'Plan for later');
  btn.dispatch('click');
  assert.equal(app.parkView, 'plan');
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
  // One street per zone, so one row per zone; The Venue is in zone A (about a minute).
  assert.deepEqual(parkNames(app), ['Zone A · Alpha', 'Zone C', 'Zone F', 'Zone G', 'Zone E', 'Zone B · B zone', 'Zone H', 'Zone D']);
  assert.deepEqual(plain(app.parkResults.map((r) => r.name + ' ' + r.walk)),
    ['Zone A 1', 'Zone B 9', 'Zone C 3', 'Zone D 1', 'Zone E 7', 'Zone F 5', 'Zone G 6', 'Zone H 10']);
  const rows = parkRows(app);
  assert.match(rows[0], /^1minZone A.*£4\.64paid all stay$/, 'an exact price has no basis line');
  assert.match(rows[1], /^3minZone CNearest: Cedar.*Price unknownpaid 10–11am, free after$/);
  assert.match(rows[2], /^5minZone F.*£3\.00–£9\.00paid all stayby car emissions$/);
  assert.match(rows[3], /^6minZone G.*from £4\.00paid all stayby car emissions$/);
  assert.match(rows[4], /^7minZone E.*£2\.00free 10–11am, paid after$/);
  assert.match(rows[6], /^10minZone H.*£6\.00–£12\.00paid all stayby fuel type$/);
  assert.match(rows[7], /^1minZone D.*Check signs$/);
  // A range can wrap after its dash rather than squeeze the street name.
  const fir = app.el('park-body').querySelectorAll('.park-amt')[2];
  assert.deepEqual(fir.children.map((c) => c.tagName.toLowerCase()), ['#text', 'wbr', '#text']);
  // Cheapest: free first, then by the lowest cost (a range or 'from' by its bottom), unknown prices
  // after every known one, hours that couldn't be read last.
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Zone B · B zone', 'Zone E', 'Zone F', 'Zone G', 'Zone A · Alpha', 'Zone H', 'Zone C', 'Zone D']);
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
  assert.deepEqual(parkNames(app), ['Zone W · West End', 'Zone N · N zone', 'Zone Y · Y zone', 'Zone F · F zone']);
  const rows = parkRows(app);
  // The rule's own bands: £4.78–£10.58 an hour for 2 hours; no maxStay, so the council's 4 hour default
  assert.match(rows[0], /^2minZone W · West EndNearest: Wren Street · Xshire4h max · fits 2h£9\.56–£21\.16paid all stayby car emissions$/);
  assert.match(rows[1], /^3minZone N · N zoneNearest: Nook Street · ZshirePrice unknownpaid all stay$/);
  assert.match(rows[2], /^4minZone Y.*£5\.00–£10\.00paid all stayby car emissions$/);
  assert.match(rows[3], /^5minZone F.*from £5\.00paid all stayby car emissions$/);
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Zone Y · Y zone', 'Zone F · F zone', 'Zone W · West End', 'Zone N · N zone'], 'a tie at £5 goes to the shorter walk');

  const priceLink = (body) => body.descendants().filter((e) => e.tagName === 'A' && /parking charges/.test(e.textContent))[0];
  const card = (name) => {
    app.parkShowDetail(app.parkResults.findIndex((r) => r.name === name));
    return app.el('park-body');
  };
  // Bands: the paid time at the range, then what each band pays for this stay, and the council's prices.
  let body = card('Zone W');
  let text = body.textContent;
  assert.match(text, /10am–12pm2h × £4\.78–£10\.58£9\.56–£21\.16Total£9\.56–£21\.16/);
  assert.match(text, /By emissions band · 2h paidBand 1 \(0–50 g\/km\)£9\.56Band 2 \(51–100 g\/km\)£12\.00Band 3 \(101–150 g\/km\)£15\.00Band 4 \(151–200 g\/km\)£18\.00Band 5 \(over 200 g\/km\)£21\.16/);
  assert.match(text, /PricesXshire parking charges/);
  assert.match(text, /Max stay4 hours \(council default\) · your 2h stay fits/);
  assert.equal(priceLink(body).href, 'https://x.example/zone-w.pdf', 'the rule’s own link first');
  // A 'from' price: the cheapest band's cost, said so.
  text = card('Zone F').textContent;
  assert.match(text, /10am–12pm2h × from £2\.50from £5\.00Totalfrom £5\.00/);
  assert.match(text, /from £5\.00: the lowest rate published for this zone\. The price depends on your car’s emissions, so yours may be higher\./);
  assert.match(text, /PricesYshire parking charges/);
  assert.doesNotMatch(text, /By emissions band/);
  // Borough bands
  text = card('Zone Y').textContent;
  assert.match(text, /By emissions band · 2h paidBand A \(0 g\/km\)£5\.00Band B \(1–100 g\/km\)£6\.00Band C \(101\+ g\/km\)£10\.00/);
  // No prices in the data: the council's note, cut short, and its link.
  body = card('Zone N');
  text = body.textContent;
  assert.match(text, /10am–12pm2h, price unknown\?TotalUnknown/);
  assert.match(text, /Prices are set street by street \(e\.g\. Agdon Street is £7\.30\/hour, 2h max\)\. Mon–Fri 10am–1pm adds a peak surcharge in most zones, and diesel cars pay more everywhere\.PricesZshire parking charges/);
  assert.doesNotMatch(text, /list of streets for each tariff/, 'shortened to whole sentences');
  assert.equal(priceLink(body).href, 'https://z.example/parking');
});

test('park near here: with no stay chosen, the hourly rate: a range, a "from" price, or unknown', async () => {
  const app = loadApp({ routes: priceRoutes() });
  app.parkNowMinutes = () => 600;
  await openParkNow(app);
  const rows = parkRows(app);
  // x's 4 hour council default max stay; y has none, so nothing ends a stay there.
  assert.match(rows[0], /^2minZone W · West EndNearest: Wren Street · XshireUp to 4h, until 2pm£4\.78–£10\.58\/hrby car emissions$/);
  assert.match(rows[1], /^3minZone N · N zoneNearest: Nook Street · ZshireNo max stay listedPrice unknown$/);
  assert.match(rows[2], /^4minZone Y.*No max stay listed£2\.50–£5\.00\/hrby car emissions$/);
  assert.match(rows[3], /^5minZone F.*No max stay listedfrom £2\.50\/hrby car emissions$/);
  const wren = app.el('park-body').querySelectorAll('.park-amt')[0];
  assert.deepEqual(wren.children.map((c) => c.tagName.toLowerCase()), ['#text', 'wbr', '#text'], 'a range can wrap after its dash');
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Zone Y · Y zone', 'Zone F · F zone', 'Zone W · West End', 'Zone N · N zone'], 'by the lowest rate, unknown last');
});

test('park near here: a place outside every zone says so, and still lists zones in reach', async () => {
  const app = loadApp({ routes: parkRoutes() });
  openPark(app, at(-250));                                // 250 m west of zone A's square
  await app.parkFind();
  assert.equal(app.parkInfo.inZone, false);
  assert.match(app.el('park-body').querySelectorAll('.pk-note')[0].textContent,
    /^The Venue isn’t in a controlled parking zone: most streets nearby have no parking controls\. Watch for yellow lines and signs\.$/);
  assert.ok(parkNames(app).indexOf('Zone A · Alpha') !== -1);
  const zoneA = app.parkResults.filter((r) => r.name === 'Zone A')[0];
  assert.equal(zoneA.inside, false, 'not in the zone, so a walk to its nearest street');
  assert.ok(zoneA.d > 300 && zoneA.refined, 'walked from Alpha Road, 350 m away');
});

// Zones with outlines: A around the place, B 600 m east. Zone A's streets follow its rule except
// two odd ones: Market Row (its own pay-by-phone price) and Short Street (a 1 hour max stay).
const ZONE_RULES = { ...PARK_RULES, rules: { ...PARK_RULES.rules,
  'x:A-short': rule('A', { name: 'Short Street', streets: ['Short Street'], periods: ALL_DAY, price: { perHour: 2 }, maxStay: '1 hour' }) } };
const ZONE_B = { type: 'Feature', properties: { b: 'x', zone: 'B', rule: 'x:B', lx: at(600)[0], ly: D[1] }, geometry: SQUARE_AT(at(600), 0.002) };
const zoneRoutes = () => [
  [/data\/parking\/rules\.json/, () => reply(ZONE_RULES)],
  [/data\/parking\/zones\.geojson/, () => reply({ type: 'FeatureCollection', features: PARK_ZONES.features.concat([ZONE_B]) })],
  [/data\/parking\/x\/streets/, collection([street('Alpha Road', 'x:A', 100), street('Abbey Mews', 'x:A', 50),
    street('Market Row', 'x:A-mkt', 200, { zone: 'A' }), street('Short Street', 'x:A-short', 300, { zone: 'A' }),
    street('Bravo Street', 'x:B', 600)])],
  [/data\/parking\/x\/(kerb|machines)/, collection([])],
  [/directions-matrix\/v1\/mapbox\/walking\//, matrixReply]];

test('park near here: one row per zone, odd streets on their own, the zones framed and drawn', async () => {
  const app = loadApp({ routes: zoneRoutes() });
  app.parkNowMinutes = () => 17 * 60;                 // 5pm
  await openParkNow(app);
  // Alpha Road and Abbey Mews follow zone A's rule: one row. The odd streets keep rows of their own.
  assert.deepEqual(parkNames(app), ['Zone A · Alpha', 'Market Row', 'Short Street', 'Zone B · B zone']);
  const idx = (name) => app.parkResults.findIndex((r) => r.name === name);
  const zoneA = app.parkResults[idx('Zone A')], zoneB = app.parkResults[idx('Zone B')];
  assert.equal(zoneA.kind, 'zone');
  assert.equal(zoneA.lines.length, 2);
  assert.equal(zoneA.street, 'Abbey Mews', 'its nearest street');
  assert.equal(app.parkResults[idx('Market Row')].kind, 'street');
  const rows = parkRows(app);
  assert.match(rows[0], /^1minZone A · AlphaThe Venue is in this zone · XshireUp to 4h, until 9pm£2\.00\/hr$/);
  assert.match(rows[1], /^5minMarket RowZone A · AlphaUp to 4h, until 9pm£3\.00\/hr$/);
  assert.match(rows[2], /^8minShort StreetZone A · AlphaUp to 1h, until 6pm£2\.00\/hr$/, 'its own max stay, not the zone’s');
  assert.match(rows[3], /^10minZone B · B zoneNearest: Bravo Street · XshireFree, no time limitFree$/);
  assert.ok(app.el('park-body').querySelectorAll('.park-row')[0].className.includes('park-row--zone'));
  app.parkSetSort('cheapest');
  assert.deepEqual(parkNames(app), ['Zone B · B zone', 'Zone A · Alpha', 'Short Street', 'Market Row'], 'free first, then a tie at £2 by walk');
  app.parkSetSort('nearest');

  // The map: each listed zone's outline in its row's state, and only the odd streets drawn until a
  // zone is opened.
  const zoneFeats = app.map.getSource('park-zones').def.data.features;
  assert.deepEqual(plain(zoneFeats.map((f) => app.parkResults[f.properties.i].name + ':' + f.properties.state)), ['Zone A:paid', 'Zone B:free']);
  assert.deepEqual(parkZoneLayers(app), ['park-zones-fill', 'park-zones-line']);
  assert.ok(JSON.stringify(app.map.getPaintProperty('park-zones-line', 'line-color')).includes(app.PARKING_PALETTES.light.ctrl));
  const shown = () => plain(app.map.getLayer('park-results-line').filter);
  assert.deepEqual(shown(), ['any', ['==', ['get', 'kind'], 'street'], ['==', ['get', 'i'], -1]]);

  // Fit to every listed zone (A's square around the place, B's 600 m east) and the odd streets.
  const fit = app.map.calls.filter((c) => c.name === 'fitBounds').pop().bounds;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(fit.w, D[0] - 0.001) && near(fit.e, at(600)[0] + 0.002), 'west of zone A to east of zone B');
  assert.ok(near(fit.s, D[1] - 0.002) && near(fit.n, D[1] + 0.002), 'zone B is the taller');
  assert.deepEqual(plain(app.parkResultsBounds()), [fit.w, fit.s, fit.e, fit.n]);

  // A zone row: the map frames that zone, highlights it and colours its streets.
  app.parkShowDetail(idx('Zone A'));
  let move = app.map.calls.pop();
  assert.equal(move.name, 'fitBounds');
  assert.ok(near(move.bounds.w, D[0] - 0.001) && near(move.bounds.e, D[0] + 0.001), 'zone A alone');
  assert.equal(move.options.maxZoom, 17);
  assert.deepEqual(shown(), ['any', ['==', ['get', 'kind'], 'street'], ['==', ['get', 'i'], idx('Zone A')]]);
  assert.deepEqual(plain(app.map.getLayer('park-results-sel').filter), ['all', ['==', ['get', 'i'], idx('Zone A')], ['==', ['get', 'kind'], 'street']]);
  assert.deepEqual(plain(app.map.getPaintProperty('park-zones-fill', 'fill-opacity')), ['case', ['==', ['get', 'i'], idx('Zone A')], 0.16, 0.03]);
  let text = app.el('park-body').textContent;
  assert.match(text, /^Zone A · AlphaXshireUp to 4h, until 9pmThe Venue is in this zone/);
  assert.match(text, /ControlledEvery day, all day/);
  // Its odd streets, nearest first, each opening its own card.
  assert.deepEqual(app.el('park-body').querySelectorAll('.park-sublist')[0].querySelectorAll('.park-name').map((e) => e.textContent),
    ['Market Row', 'Short Street']);
  // Zone B has none.
  app.parkShowDetail(idx('Zone B'));
  text = app.el('park-body').textContent;
  assert.match(text, /^Zone B · B zoneXshireFree, no time limit10 min walk to The Venue from Bravo Street \(estimate\)/);
  assert.doesNotMatch(text, /own rules/);
  app.parkShowList();
  assert.deepEqual(shown(), ['any', ['==', ['get', 'kind'], 'street'], ['==', ['get', 'i'], -1]]);

  // Tapping a zone on the map opens its row; tapping it again leaves the camera alone.
  const tapZone = (i) => app.map.fireLayer('click', 'park-zones-fill', { point: { x: 1, y: 1 }, features: [{ properties: { i } }] });
  tapZone(idx('Zone B'));
  assert.equal(app.parkView, 'detail');
  assert.equal(app.parkSelIdx, idx('Zone B'));
  const moves = app.map.calls.length;
  tapZone(idx('Zone B'));
  assert.equal(app.map.calls.length, moves);
  // A result street drawn over a zone takes the tap.
  app.map.rendered = { 'park-results-casing': [{ properties: { i: idx('Market Row') } }] };
  tapZone(idx('Zone A'));
  assert.equal(app.parkSelIdx, idx('Zone B'));
  app.map.fireLayer('click', 'park-results-casing', { point: { x: 1, y: 1 }, features: [{ properties: { i: idx('Market Row') } }] });
  assert.equal(app.parkSelIdx, idx('Market Row'));
  assert.match(app.el('park-body').textContent, /^Market RowZone A · Alpha · Xshire/);
  assert.equal(app.map.calls.pop().name, 'flyTo', 'an odd street flies to the street, as before');
  app.map.rendered = {};

  // A theme switch puts the zones back, in the dark shades, still showing the selection.
  app.parkShowDetail(idx('Zone A'));
  app.toggleTheme();
  app.map.finishStyle();
  assert.deepEqual(parkZoneLayers(app), ['park-zones-fill', 'park-zones-line']);
  assert.equal(app.map.layerIds().slice(-3).join(), 'park-results-casing,park-results-line,park-results-sel');
  assert.ok(JSON.stringify(app.map.getPaintProperty('park-zones-line', 'line-color')).includes(app.PARKING_PALETTES.dark.ctrl));
  assert.deepEqual(shown(), ['any', ['==', ['get', 'kind'], 'street'], ['==', ['get', 'i'], idx('Zone A')]]);
  app.rehydrateLayers();                               // twice on one style is harmless
  assert.deepEqual(parkZoneLayers(app), ['park-zones-fill', 'park-zones-line']);
  app.closeParkNear();
  assert.deepEqual(app.map.layerIds(), []);
  assert.equal(app.parkZoneData, null);
  assert.equal(app.map.getSource('park-zones'), undefined);
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

test('parking colours: red only for red routes, pay is sign blue, each theme its own shades', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const app = loadApp({ routes: parkRoutes() });
  const light = plain(app.PARKING_PALETTES.light), dark = plain(app.PARKING_PALETTES.dark);
  assert.deepEqual(plain(app.PARKING_COLORS), light, 'the page starts light');
  assert.equal(light.ctrl, '#1d4ed8', 'pay to park is the P sign blue');
  for (const p of [light, dark]) {
    assert.equal(new Set(Object.values(p)).size, 5, 'five different colours');
    for (const k of ['ctrl', 'free', 'permit', 'unknown']) assert.doesNotMatch(p[k], /^#(e7|dc|ef|f8|b9|7f)/, k + ' is not red');
  }
  // The legend swatches use the same colours, per theme.
  const vars = (sel) => Object.fromEntries([...css.match(new RegExp(sel + ' \\{ (--pk-[^}]*)\\}'))[1]
    .matchAll(/--pk-(\w+): (#[0-9a-f]+)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(vars(':root'), dark);
  assert.deepEqual(vars('body\\.light'), light);
  // The Park near here panel has its own key, outside the body it re-renders.
  assert.match(html, /id="park-legend"[^]*Pay to park[^]*Free[^]*Permit only[^]*Hours unknown[^]*Red route: no parking[^]*id="park-body"/);
  app.toggleTheme();
  assert.deepEqual(plain(app.PARKING_COLORS), dark);
  assert.equal(app.PARK_STATE_COLORS.paid, dark.ctrl, 'Park near here follows the theme too');
  assert.equal(app.PARK_SEG_COLORS.permit, dark.permit);
  app.toggleTheme();
  assert.equal(app.PARK_STATE_COLORS.paid, light.ctrl);
});

test('park near here: result streets stand out over a dimmed parking layer, and rows match their lines', async () => {
  const app = loadApp({ routes: parkRoutes() });
  openPark(app);
  await app.parkFind();
  const opacity = () => [app.map.getPaintProperty('parking-streets', 'line-opacity'), app.map.getPaintProperty('parking-zones-line', 'line-opacity')];
  assert.ok(app.parkResults.length);
  assert.deepEqual(opacity(), [0.3, 0.35], 'dimmed under the results');
  const lineColor = () => JSON.stringify(app.map.getPaintProperty('park-results-line', 'line-color'));
  assert.ok(lineColor().includes(app.PARKING_PALETTES.light.ctrl));
  // Each row's edge is its line's colour: a class per state, coloured by style.css.
  const rows = app.el('park-body').querySelectorAll('.park-row');
  assert.equal(rows.length, app.parkResults.length);
  for (const row of rows) assert.match(row.className, /park-row--line park-row--(free|paid|unknown)/);
  // A theme switch puts it all back with the dark shades, still dimmed.
  app.toggleTheme();
  app.map.finishStyle();
  assert.deepEqual(opacity(), [0.3, 0.35]);
  assert.ok(lineColor().includes(app.PARKING_PALETTES.dark.ctrl));
  // Once the results go, the layer is back to full strength.
  app.clearParkResults();
  assert.deepEqual(opacity(), [0.85, 0.8]);
  app.closeParkNear();
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

// --- Congestion Charge ---------------------------------------------------------------------
const CCZ_ZONE = JSON.parse(readFileSync(new URL('../data/ccz.geojson', import.meta.url), 'utf8'));
const CCZ_HOLIDAYS = JSON.parse(readFileSync(new URL('../data/bank-holidays.json', import.meta.url), 'utf8'));
const CCZ = [
  [/data\/ccz\.geojson/, () => reply(CCZ_ZONE)],
  [/data\/bank-holidays\.json/, () => reply(CCZ_HOLIDAYS)]
];
const FRI_3PM = Date.UTC(2026, 10, 20, 15, 0);                  // Friday 20 Nov 2026, GMT
const cczLayers = (app) => app.map.layerIds().filter((id) => id.indexOf('ccz-') === 0);
const chipText = (app) => app.el('ccz-chip-status').textContent;
// Each custom map control's button, by id, in the order they were added (the stand-in
// NavigationControl and AttributionControl have no onAdd).
const controlButtons = (app) => app.map.controls.filter((c) => typeof c.control.onAdd === 'function')
  .map((c) => ({ id: c.control.onAdd(app.map).children[0].id, position: c.position }));

test('congestion charge: a C button right under the P button, labelled for screen readers', () => {
  const app = loadApp({ routes: CCZ, now: FRI_3PM });
  const ids = controlButtons(app).map((c) => c.id);
  assert.equal(ids.indexOf('ccz-ctrl'), ids.indexOf('parking-ctrl') + 1);
  assert.equal(controlButtons(app)[ids.indexOf('ccz-ctrl')].position, 'top-right');
  const b = app.cczBtn;                                         // the button from the last onAdd
  assert.equal(b.id, 'ccz-ctrl');
  assert.equal(b.getAttribute('aria-label'), 'Congestion Charge zone');
  assert.equal(b.getAttribute('aria-pressed'), 'false');
  assert.match(b.innerHTML, /aria-hidden="true">C</);
});

test('congestion charge: the button draws the zone and shows the chip, and takes them away', async () => {
  const app = loadApp({ routes: CCZ, now: FRI_3PM });
  controlButtons(app);
  app.cczBtn.dispatch('click');
  assert.equal(app.cczOn, true);
  assert.equal(app.cczBtn.getAttribute('aria-pressed'), 'true');
  assert.ok(app.el('ccz-chip').classList.contains('open'), 'the chip shows at once');
  assert.equal(chipText(app), 'Charging now · until 6pm');
  assert.ok(app.el('ccz-chip').classList.contains('is-charging'));
  await settle();
  assert.deepEqual(cczLayers(app), ['ccz-fill', 'ccz-line']);
  assert.match(app.map.getSource('ccz').def.attribution, /TfL Open Data/);
  assert.equal(app.map.getPaintProperty('ccz-line', 'line-color'), app.CCZ_PALETTES.light.line);
  app.cczBtn.dispatch('click');
  assert.equal(app.cczOn, false);
  assert.equal(app.cczBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(app.el('ccz-chip').classList.contains('open'), false);
  assert.deepEqual(app.map.layerIds(), []);
  assert.equal(app.map.getSource('ccz'), undefined);
  assert.equal(app.intervals.size, 0, 'the minute timer stops');
});

test('congestion charge chip: free in the evening, and it moves on every minute', async () => {
  const app = loadApp({ routes: CCZ, now: Date.UTC(2026, 10, 20, 20, 0) });   // Fri 8pm
  app.toggleCcz(true);
  await settle();
  assert.equal(chipText(app), 'Free now · starts 12pm tomorrow');
  assert.equal(app.el('ccz-chip').classList.contains('is-charging'), false);
  assert.deepEqual([...app.intervals.values()].map((t) => t.ms), [60000]);
  app.setNow(Date.UTC(2026, 10, 21, 12, 0));                                   // Sat noon
  app.runIntervals();
  assert.equal(chipText(app), 'Charging now · until 6pm');
  assert.ok(app.el('ccz-chip').classList.contains('is-charging'));
  app.setNow(Date.UTC(2026, 10, 22, 18, 30));                                  // Sun 6:30pm
  app.runIntervals();
  assert.equal(chipText(app), 'Free now · starts 7am tomorrow');
});

test('congestion charge chip: bank holidays come with the zone and give weekend hours', async () => {
  const app = loadApp({ routes: CCZ, now: Date.UTC(2026, 7, 31, 9, 0) });     // 10am BST, Mon 31 Aug
  app.toggleCcz(true);
  assert.equal(chipText(app), 'Charging now · until 6pm', 'before the list arrives: an ordinary Monday');
  await settle();
  assert.equal(chipText(app), 'Free now · starts 12pm');
});

test('congestion charge: without the zone file the chip says so, and a second try loads it', async () => {
  let ok = false;
  const app = loadApp({ now: FRI_3PM, routes: [
    [/data\/ccz\.geojson/, () => (ok ? reply(CCZ_ZONE) : reply({}, 500))], CCZ[1]] });
  app.toggleCcz(true);
  await settle();
  assert.equal(chipText(app), 'Couldn’t load the zone');
  assert.deepEqual(cczLayers(app), []);
  app.toggleCcz(false);
  ok = true;
  app.toggleCcz(true);
  await settle();
  assert.equal(chipText(app), 'Charging now · until 6pm');
  assert.deepEqual(cczLayers(app), ['ccz-fill', 'ccz-line']);
});

test('congestion charge: the zone comes back after a theme change, in the new theme’s colours', async () => {
  const app = loadApp({ routes: CCZ, now: FRI_3PM });
  app.toggleCcz(true);
  await settle();
  app.toggleTheme();
  assert.deepEqual(cczLayers(app), [], 'the old style took them');
  app.map.finishStyle();
  assert.deepEqual(cczLayers(app), ['ccz-fill', 'ccz-line']);
  assert.equal(app.map.getPaintProperty('ccz-line', 'line-color'), app.CCZ_PALETTES.dark.line);
  assert.equal(app.map.getPaintProperty('ccz-fill', 'fill-color'), app.CCZ_PALETTES.dark.fill);
  app.rehydrateLayers();                                        // safe to run twice
  assert.deepEqual(cczLayers(app), ['ccz-fill', 'ccz-line']);
  app.toggleTheme();
  app.map.finishStyle();
  assert.equal(app.map.getPaintProperty('ccz-line', 'line-color'), app.CCZ_PALETTES.light.line);
  // Off, it stays off through a style change.
  app.toggleCcz(false);
  app.toggleTheme();
  app.map.finishStyle();
  assert.deepEqual(cczLayers(app), []);
});

test('congestion charge: picking a place in the zone turns it on; outside it doesn’t', async () => {
  const inside = loadApp({ routes: [ISO, NO_STATIONS, ...CCZ], now: FRI_3PM });
  inside.goToPlace({ lng: -0.1281, lat: 51.5080, name: 'Trafalgar Square', address: '', postcode: null });
  await settle();
  assert.equal(inside.cczOn, true);
  assert.ok(inside.el('ccz-chip').classList.contains('open'));
  assert.deepEqual(cczLayers(inside), ['ccz-fill', 'ccz-line']);

  const outside = loadApp({ routes: [ISO, NO_STATIONS, ...CCZ], now: FRI_3PM });
  outside.goToPlace({ lng: -0.1426, lat: 51.5392, name: 'Camden Town', address: '', postcode: null });
  await settle();
  assert.equal(outside.cczOn, false);
  assert.deepEqual(cczLayers(outside), []);
});

test('congestion charge: only the newest pick counts while the zone loads', async () => {
  const zone = deferred();
  const app = loadApp({ now: FRI_3PM, routes: [ISO, NO_STATIONS, [/data\/ccz\.geojson/, () => zone.promise], CCZ[1]] });
  app.goToPlace({ lng: -0.1281, lat: 51.5080, name: 'Trafalgar Square', address: '', postcode: null });
  await settle();
  app.goToPlace({ lng: -0.1426, lat: 51.5392, name: 'Camden Town', address: '', postcode: null });
  zone.resolve(reply(CCZ_ZONE));
  await settle();
  assert.equal(app.cczOn, false);
});

test('congestion charge: a postcode in the zone turns it on once its boundary has loaded', async () => {
  const COVENT_GARDEN = { type: 'Polygon', coordinates: [[[-0.1245, 51.5115], [-0.1235, 51.5115], [-0.1235, 51.5120], [-0.1245, 51.5120], [-0.1245, 51.5115]]] };
  const app = loadApp({ now: FRI_3PM, routes: [...CCZ,
    [/api\.os\.uk/, () => reply({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: COVENT_GARDEN }] })]] });
  app.goToPostcode('WC2E 9DD');
  assert.equal(app.fetched.filter((u) => /ccz\.geojson/.test(u)).length, 0, 'no coordinates yet');
  await settle();
  assert.equal(app.cczOn, true);
});

test('congestion charge chip: under the sheets and the search screen, clear of the corner buttons on mobile', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const block = (re) => css.match(re)[1];
  const z = (sel) => Number(block(new RegExp('\\n  ' + sel + ' \\{([^}]*)\\}')).match(/z-index: (\d+)/)[1]);
  assert.ok(z('\\.ccz-chip') < z('\\.fuel-panel'), 'under the fuel / parking / park sheets');
  assert.ok(z('\\.ccz-chip') < z('\\.travel-card, \\.postcode-chip'), 'under the place and travel cards');
  assert.ok(z('\\.ccz-chip') < z('\\.search-overlay'), 'under the search screen');
  // On mobile: right of the theme button (12–52px) and the travel view's search button
  // (60–108px), left of the zoom buttons (36px wide, 10px in from the right).
  const mobile = block(/\n    \.ccz-chip \{([^}]*)\}/);
  assert.match(mobile, /top: 12px; left: 116px; right: 56px;/);
});

// --- Park near here and the Congestion Charge ------------------------------------------------
// A place by Liverpool Street, inside the charge zone, whose edge is 400–500 m east of it. Zone A
// is around the place; Inner Lane (zone B, free) is inside the charge zone too. Outside it: Permit
// Close (permit holders only), Unknown Way (hours unknown), Outer Street (zone O, paid) and, too
// far to walk, Far Parade.
const C = [-0.0790, 51.5150];
const C_LNG = 1 / (111320 * Math.cos(C[1] * Math.PI / 180));
const cAt = (east, north = 0) => [C[0] + east * C_LNG, C[1] + north * M_LAT];
const cStreet = (name, rule, east) => ({ type: 'Feature', properties: { name, zone: rule.split(':')[1], rule, cls: 4 },
  geometry: { type: 'LineString', coordinates: [cAt(east, -40), cAt(east, 40)] } });
const CCZ_RULES = { ...PARK_RULES, rules: { ...PARK_RULES.rules,
  'x:O': rule('O', { name: 'Outer', periods: ALL_DAY, price: { perHour: 3 } }) } };
const CCZ_STREETS = [cStreet('Alpha Road', 'x:A', 100), cStreet('Inner Lane', 'x:B', 300), cStreet('Permit Close', 'x:P', 600),
  cStreet('Unknown Way', 'x:U', 650), cStreet('Outer Street', 'x:O', 700), cStreet('Far Parade', 'x:O', 2600)];
const C_WALK_SECS = { 300: 240, 650: 480, 700: 660 };
function cczMatrixReply(url) {
  const coords = url.split('/walking/')[1].split('?')[0].split(';').map((c) => c.split(',').map(Number));
  return reply({ code: 'Ok', durations: [coords.map((c, i) => (i === 0 ? 0 : C_WALK_SECS[Math.round((c[0] - C[0]) / C_LNG / 50) * 50]))] });
}
const cczParkRoutes = (streets) => [...CCZ,
  [/data\/parking\/rules\.json/, () => reply(CCZ_RULES)],
  [/data\/parking\/zones\.geojson/, () => reply({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { b: 'x', zone: 'A', rule: 'x:A', lx: C[0], ly: C[1] }, geometry: SQUARE_AT(C, 0.001) }] })],
  [/data\/parking\/x\/streets/, collection(streets || CCZ_STREETS)],
  [/data\/parking\/x\/(kerb|machines)/, collection([])],
  [/directions-matrix\/v1\/mapbox\/walking\//, cczMatrixReply]];
const cczBody = (app) => app.el('park-body');
const cczBanner = (app) => cczBody(app).querySelectorAll('.park-ccz')[0];
const cczQuiet = (app) => cczBody(app).querySelectorAll('.park-ccz-quiet').map((e) => e.textContent);
const cczTip = (app) => cczBody(app).querySelectorAll('.park-ccz-tip')[0];
const cczOutsideRows = (app) => cczBody(app).querySelectorAll('.park-ccz-list').flatMap((l) => l.querySelectorAll('.park-row'));
function openCczPark(app, plan, where) {
  const c = where || C;
  app.pendingPlace = { name: 'The Office', lat: c[1], lng: c[0] };
  const found = app.openParkNear();
  if (!plan) return found;
  Object.assign(app.parkPlan, plan);
  return app.parkFind();
}

test('park near here, congestion charge: in charging hours, the charge, a tip and parking just outside', async () => {
  const app = loadApp({ routes: cczParkRoutes(), now: FRI_3PM });
  await openCczPark(app);
  assert.equal(app.parkView, 'results');
  // Under the header: the charge for driving in now, said honestly with no stay chosen.
  assert.match(cczBody(app).textContent, /^Now · any lengthChange\+ £18 Congestion Charge today/);
  const banner = cczBanner(app);
  assert.equal(banner.querySelectorAll('.park-ccz-main')[0].textContent, '+ £18 Congestion Charge today');
  assert.equal(banner.querySelectorAll('.park-ccz-why')[0].textContent,
    'For driving in now, in charging hours (until 6pm). Leaving in another day’s charging hours costs £18 more.');
  // The tip: a later arrival only, since with no stay you'd still leave in charging hours.
  const tip = cczTip(app);
  assert.equal(tip.tagName, 'BUTTON');
  assert.equal(tip.textContent, 'Arrive after 6pm and it’s freeIf you leave before 12pm tomorrow. Tap to see parking for 6:00pm');
  // Parking just outside, above the list: Outer Street, not the nearer permit-only or unreadable streets.
  const out = cczOutsideRows(app);
  assert.equal(out.length, 1);
  assert.match(out[0].textContent, /^11minOutside the charge zone · 11 min walk · saves £18Zone O · OuterNearest: Outer Street · Xshire/);
  assert.match(out[0].className, /park-row--ccz/);
  const kids = cczBody(app).children.map((c) => c.className);
  assert.ok(kids.indexOf('park-list park-ccz-list') < kids.indexOf('park-list'), 'above the list');
  const listed = cczBody(app).children.filter((c) => c.className === 'park-list')[0].querySelectorAll('.park-name').map((e) => e.textContent);
  assert.deepEqual(listed, ['Zone A · Alpha', 'Zone B · B zone', 'Zone O · Outer', 'Zone U · U zone'], 'the list is as before');
  const r = app.parkResults.find((x) => x.outside);
  assert.equal(r.street, 'Outer Street');
  assert.equal(r.inside, false);
  assert.equal(app.ccInZone(r.point[0], r.point[1]), false);
  // One Matrix call: the place, the list's three and the outside candidate.
  const matrix = app.fetched.filter((u) => /directions-matrix/.test(u));
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].split('?')[0].split(';').length, 5);
  assert.equal(r.refined, true);

  // On the map: its street, always shown like an odd street; no outline for its zone.
  const i = app.parkResults.indexOf(r);
  const feats = () => app.map.getSource('park-results').def.data.features.filter((f) => f.properties.i === i);
  assert.deepEqual(plain(feats().map((f) => f.properties)), [{ i, state: 'paid', kind: 'street' }]);
  assert.equal(app.map.getSource('park-zones').def.data.features.filter((f) => f.properties.i === i).length, 0);
  const fit = app.map.calls.filter((c) => c.name === 'fitBounds').pop().bounds;
  assert.ok(fit.e >= r.point[0], 'the results frame it too');

  // Tapping it: its card, and the map frames the walk.
  out[0].dispatch('click');
  assert.equal(app.parkView, 'detail');
  assert.equal(app.parkSelIdx, i);
  const card = cczBody(app).textContent;
  assert.match(card, /^Zone O · OuterXshire.*11 min walk to The Office from Outer StreetOutside the Congestion Charge zone: saves £18 today/);
  assert.doesNotMatch(card, /own rules/);
  const move = app.map.calls.pop();
  assert.equal(move.name, 'fitBounds');
  assert.ok(move.bounds.w <= C[0] && move.bounds.e >= r.point[0], 'from the place to the street');
  assert.deepEqual(plain(app.map.getLayer('park-results-sel').filter), ['all', ['==', ['get', 'i'], i], ['==', ['get', 'kind'], 'street']]);

  // A theme change puts it all back.
  app.toggleTheme();
  app.map.finishStyle();
  assert.equal(feats().length, 1);
  app.rehydrateLayers();
  assert.equal(feats().length, 1);
  app.parkShowList();
  assert.equal(cczOutsideRows(app).length, 1);
  app.closeParkNear();
  assert.deepEqual(app.map.layerIds().filter((id) => id.indexOf('park') === 0), []);
});

test('park near here, congestion charge: free hours, an uncharged stay, and a place outside the zone', async () => {
  // Friday 7pm, no stay: free to drive in, and says until when.
  let app = loadApp({ routes: cczParkRoutes(), now: Date.UTC(2026, 10, 20, 19, 0) });
  await openCczPark(app);
  assert.equal(cczBanner(app), undefined);
  assert.equal(cczTip(app), undefined);
  assert.equal(cczOutsideRows(app).length, 0);
  assert.deepEqual(cczQuiet(app), ['In the Congestion Charge zone · no charge if you leave before 12pm tomorrow']);
  assert.equal(app.parkResults.filter((r) => r.outside).length, 0);
  // Saturday 1pm for 2 hours: charged, on weekend hours.
  await openCczPark(app, { dayIdx: 1, minutes: 13 * 60, stay: 120, now: false });
  assert.equal(cczBanner(app).querySelectorAll('.park-ccz-main')[0].textContent, '+ £18 Congestion Charge tomorrow');
  assert.equal(cczBanner(app).querySelectorAll('.park-ccz-why')[0].textContent, 'Arriving and leaving in charging hours (12–6pm).');
  assert.equal(cczOutsideRows(app).length, 1);
  // Friday 7pm for 2 hours: nothing to pay.
  await openCczPark(app, { dayIdx: 0, minutes: 19 * 60, stay: 120, now: false });
  assert.deepEqual(cczQuiet(app), ['In the Congestion Charge zone · no charge for this trip']);
  assert.equal(cczBanner(app), undefined);

  // Charged, but nothing outside within the walk: no row.
  app = loadApp({ routes: cczParkRoutes(CCZ_STREETS.filter((f) => f.properties.name !== 'Outer Street')), now: FRI_3PM });
  await openCczPark(app);
  assert.ok(cczBanner(app));
  assert.equal(cczOutsideRows(app).length, 0);
  assert.equal(app.parkResults.filter((r) => r.outside).length, 0);

  // A place outside the zone, in charging hours: nothing about the charge.
  app = loadApp({ routes: cczParkRoutes(), now: FRI_3PM });
  await openCczPark(app, null, cAt(900));
  assert.equal(cczBanner(app), undefined);
  assert.deepEqual(cczQuiet(app), []);
  assert.equal(app.parkInfo.ccz, null);

  // Without the zone file the list works as before.
  app = loadApp({ routes: cczParkRoutes().slice(2), now: FRI_3PM });
  await openCczPark(app);
  assert.equal(app.parkView, 'results');
  assert.equal(app.parkInfo.ccz, null);
  assert.equal(cczBanner(app), undefined);
});

test('park near here, congestion charge: the tip moves the arrival, keeps the stay and looks again', async () => {
  const app = loadApp({ routes: cczParkRoutes(), now: FRI_3PM });
  await openCczPark(app, { dayIdx: 0, minutes: 15 * 60, stay: 120, now: false });
  assert.match(cczBody(app).textContent, /^Fri 3:00pm · 2hChange\+ £18 Congestion Charge today/);
  assert.equal(cczBanner(app).querySelectorAll('.park-ccz-why')[0].textContent, 'Arriving and leaving in charging hours (7am–6pm).');
  const tip = cczTip(app);
  assert.equal(tip.textContent, 'Arrive after 6pm and it’s freeTap to see parking for 6:00pm');
  assert.equal(tip.getAttribute('aria-label'), 'Arrive after 6pm and it’s free. Tap to see parking for 6:00pm');
  const seq = app.parkSeq;
  tip.dispatch('click');
  assert.equal(app.parkView, 'loading', 'the same search as Find parking');
  assert.ok(app.parkSeq > seq, 'a new lookup: an older one is dropped');
  assert.deepEqual(plain(app.parkPlan), { dayIdx: 0, minutes: 18 * 60, stay: 120, now: false });
  await settle();
  assert.equal(app.parkView, 'results');
  assert.match(cczBody(app).textContent, /^Fri 6:00pm · 2hChange/);
  assert.deepEqual(cczQuiet(app), ['In the Congestion Charge zone · no charge for this trip']);
  assert.equal(cczTip(app), undefined);
  assert.equal(cczOutsideRows(app).length, 0);
  assert.equal(app.parkingWhen.minutes, 18 * 60, 'the parking layer follows the new arrival');

  // A late answer for the old plan doesn't win over the tip's.
  const slow = loadApp({ routes: cczParkRoutes(), now: FRI_3PM });
  await openCczPark(slow, { dayIdx: 0, minutes: 15 * 60, stay: 120, now: false });
  cczTip(slow).dispatch('click');
  slow.parkShowPlan();
  await settle();
  assert.equal(slow.parkView, 'plan');
});

test('park near here, congestion charge: the tip never offers a time that has gone', async () => {
  // Friday 8am for an hour is charged. Leaving before 7am means arriving at 5:55am.
  const plan = { dayIdx: 0, minutes: 8 * 60, stay: 60, now: false };
  let app = loadApp({ routes: cczParkRoutes(), now: Date.UTC(2026, 10, 20, 5, 0) });   // 5am: still ahead
  await openCczPark(app, plan);
  assert.equal(cczTip(app).querySelectorAll('.park-ccz-tip-main')[0].textContent, 'Leave before 7am and it’s free');
  cczTip(app).dispatch('click');
  assert.equal(app.parkPlan.minutes, 5 * 60 + 55);
  await settle();
  assert.match(cczBody(app).textContent, /^Fri 5:55am · 1hChange/);
  assert.deepEqual(cczQuiet(app), ['In the Congestion Charge zone · no charge for this trip']);
  app = loadApp({ routes: cczParkRoutes(), now: Date.UTC(2026, 10, 20, 6, 30) });         // 6:30am: gone
  await openCczPark(app, plan);
  assert.equal(cczTip(app).querySelectorAll('.park-ccz-tip-main')[0].textContent, 'Arrive after 6pm and it’s free');
});
