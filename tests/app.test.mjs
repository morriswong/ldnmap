// Tests for app.js, run in a stand-in browser (tests/helpers/browser-stub.mjs). Run with: npm test
// They cover what the page does to its own state and to the map: which layers are on it, which
// card is showing, and what happens when answers arrive late or out of order.
import test from 'node:test';
import assert from 'node:assert/strict';
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
