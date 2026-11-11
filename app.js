var MAPBOX_TOKEN = '__MAPBOX_TOKEN__';
var OS_TOKEN = '__OS_TOKEN__';
mapboxgl.accessToken = MAPBOX_TOKEN;
var COLORS = ['#2ecc71','#3498db','#f39c12','#e74c3c'];
var MINS = [5,10,15,20];
var PC_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
var CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // postcode boundaries, station lists and the last view are kept 30 days

// Cached boundaries and station lists are only read again if the same place comes up,
// so expired ones would otherwise sit in localStorage until it fills.
(function pruneCaches() {
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k.indexOf('pc:') !== 0 && k.indexOf('st:') !== 0) continue;
      var ts = 0;
      try { ts = JSON.parse(localStorage.getItem(k)).ts; } catch (e) {}
      if (!(Date.now() - ts < CACHE_TTL)) localStorage.removeItem(k);
    }
  } catch (e) {}
})();

function syncAppHeight() {
  var vv = window.visualViewport;
  var h = (vv && vv.height) || window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
}
syncAppHeight();
window.addEventListener('resize', syncAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAppHeight);
  window.visualViewport.addEventListener('scroll', syncAppHeight);
}

function buildStyleUrl(dark) {
  return 'mapbox://styles/mapbox/' + (dark ? 'dark-v11' : 'streets-v12');
}
// Padding that always leaves some map showing. Mapbox GL v2.15 doesn't guard against padding
// larger than the map (a tall bottom sheet, or iOS shrinking the page for the keyboard):
// fitBounds then works out a NaN camera and throws "Invalid LngLat object: (NaN, NaN)".
function fitPadding(pad) {
  map.resize();                                      // the canvas can lag the page after iOS resizes it
  var c = map.getContainer(), keep = 40;
  function squeeze(a, b, size) {
    var room = Math.max(0, size - keep);
    if (a + b <= room) return [a, b];
    var k = (a + b) ? room / (a + b) : 0;
    return [Math.floor(a * k), Math.floor(b * k)];
  }
  var x = squeeze(pad.left || 0, pad.right || 0, c.clientWidth);
  var y = squeeze(pad.top || 0, pad.bottom || 0, c.clientHeight);
  return { left: x[0], right: x[1], top: y[0], bottom: y[1] };
}
// The same clearance as a flyTo offset. A padding given to flyTo stays on the map afterwards
// and shifts every later move; fitBounds only uses its padding for that one fit.
function paddingOffset(pad) {
  return [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2];
}

function whenStyleReady(fn) {
  if (map.isStyleLoaded()) { fn(); return; }
  // The style isn't ready yet. `style.load` is a ONE-SHOT event: if it has
  // already fired (or isStyleLoaded() reports false transiently right after it,
  // as Mapbox GL JS sometimes does on cold load), a lone `once('style.load')`
  // would register a callback that never runs — silently dropping the work.
  // This is what broke isochrone rendering on shared-permalink cold loads:
  // run()'s draw+fitBounds block deferred here and was never invoked.
  // `idle` re-fires on every render-settle, so it guarantees forward progress.
  function go() {
    map.off('style.load', go);   // whichever fires first; the other mustn't linger
    map.off('idle', go);
    fn();
  }
  map.once('style.load', go);
  map.once('idle', go);
}

var map = new mapboxgl.Map({
  container: 'map',
  style: buildStyleUrl(false),
  center: [-0.1246, 51.5007],
  zoom: 13,
  attributionControl: false
});
map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

var isDark = false;

var prevState = null;
var appState = 'idle';
function setState(newState) {
  if (newState === appState) return;
  prevState = appState;
  appState = newState;
  document.body.dataset.state = newState;
  if (window.__sheet) {                                  // [snap-sheet]
    if (newState === 'travel') window.__sheet.open();
    else if (prevState === 'travel') window.__sheet.close();
  }
  if (location.hostname === 'localhost' || location.port) {
    console.log('[state] ' + prevState + ' → ' + newState);
  }
}

// The newest postcode lookup. It moves on with each lookup and when the card closes, so an
// answer that arrives late (for a card since closed, or an earlier postcode) is dropped.
var postcodeSeq = 0;

function cachedPostcode(pc) {
  try {
    var entry = JSON.parse(localStorage.getItem('pc:' + pc));
    return entry && Date.now() - entry.ts < CACHE_TTL ? entry.geojson : null;
  } catch (e) { return null; }
}

function searchPostcode(pc) {
  pc = pc.trim().toUpperCase();
  if (!pc) return;
  var seq = ++postcodeSeq;
  setStatus('Fetching ' + pc + '…');

  var cached = cachedPostcode(pc);
  if (cached) { renderPostcode(cached, seq); return; }

  var url = 'https://api.os.uk/features/ngd/ofa/v1/collections/asu-gbpcd-postcodeunitarea-1/items'
    + '?filter=' + encodeURIComponent("postcode='" + pc + "'") + '&key=' + OS_TOKEN;

  fetch(url)
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(geo) {
      if (seq !== postcodeSeq) return;
      // Postcodes with no area of their own (one large building, a PO box) have no polygon.
      if (!geo.features || geo.features.length === 0) throw new Error('no polygon');
      try { localStorage.setItem('pc:' + pc, JSON.stringify({ geojson: geo, ts: Date.now() })); } catch(e) {}
      renderPostcode(geo, seq);
    })
    .catch(function() { postcodeCentre(pc, seq); });
}

// No boundary to draw: find the postcode's centre instead, so its card still works.
function postcodeCentre(pc, seq) {
  if (seq !== postcodeSeq) return;
  function done(msg, isError) {
    if (seq !== postcodeSeq) return;
    document.getElementById('pc-st').classList.remove('is-loading');
    setStatus(msg, isError);
  }
  fetch('https://api.postcodes.io/postcodes/' + pc.replace(/\s+/g, ''))
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (seq !== postcodeSeq) return;
      if (!(data.status === 200 && data.result && data.result.latitude)) { done('Postcode lookup failed.', true); return; }
      if (pendingPlace) {
        pendingPlace.lat = data.result.latitude;
        pendingPlace.lng = data.result.longitude;
      }
      postcodeReady();
      map.flyTo({ center: [data.result.longitude, data.result.latitude], zoom: 14 });
      done('Boundary unavailable — showing postcode centre', false);
    })
    .catch(function() { done('Postcode lookup failed.', true); });
}

// The card's place has its coordinates: its buttons can be used.
function postcodeReady() {
  document.getElementById('postcode-cta-btn').disabled = false;
  document.getElementById('postcode-parking-btn').disabled = false;
}

function removePostcodeLayers() {
  if (map.getLayer('postcode-fill')) map.removeLayer('postcode-fill');
  if (map.getLayer('postcode-line')) map.removeLayer('postcode-line');
  if (map.getSource('postcode'))     map.removeSource('postcode');
  postcodeLayer = null;
}

function addPostcodeLayers(geo) {
  removePostcodeLayers();
  map.addSource('postcode', { type: 'geojson', data: geo });
  map.addLayer({ id: 'postcode-fill', type: 'fill', source: 'postcode',
    paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'postcode-line', type: 'line', source: 'postcode',
    paint: { 'line-color': '#8b5cf6', 'line-width': 2.5, 'line-opacity': 1 } });
  postcodeLayer = geo;
}

function renderPostcode(geo, seq) {
  whenStyleReady(function() {
    if (seq !== postcodeSeq) return;
    addPostcodeLayers(geo);

    var bounds = geojsonBounds(geo);
    if (bounds) {
      map.fitBounds(bounds, { padding: fitPadding({ top: 24, right: 24, bottom: 24, left: 24 }), maxZoom: 16 });
      var ctr = bounds.getCenter();
      if (pendingPlace && pendingPlace.postcode) {
        pendingPlace.lat = ctr.lat;
        pendingPlace.lng = ctr.lng;
        postcodeReady();
      }
    }

    var pcStEl = document.getElementById('pc-st');
    if (pcStEl) { pcStEl.textContent = ''; pcStEl.classList.remove('is-loading'); }
  });
}

setState('idle');

// The button shows the theme a tap switches to: a moon in light mode, a sun in dark mode.
function toggleTheme() {
  isDark = !isDark;
  document.body.classList.toggle('light', !isDark);
  var iconHtml = isDark
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
    : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  var fab = document.getElementById('theme-icon-fab');
  if (fab) fab.innerHTML = iconHtml;
  map.setStyle(buildStyleUrl(isDark));
}

// setStyle() drops every source and layer, so ours go back whenever a style finishes loading.
// One listener for the map's life: two quick toggles load one style, so a listener per toggle
// would put the layers back twice.
map.on('style.load', function() {
  rehydrateLayers();
  updateMarkerColor();
});

var markerEl = (function() {
  var el = document.createElement('div');
  el.style.cssText = 'width:20px;height:20px;border-radius:50%;border:4px solid;cursor:pointer;box-sizing:border-box;';
  return el;
})();
function updateMarkerColor() {
  markerEl.style.backgroundColor = isDark ? '#fff' : '#1a1a1a';
  markerEl.style.borderColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)';
}
updateMarkerColor();
var markerInstance = new mapboxgl.Marker({ element: markerEl });
var marker = null;

var isoLayers = [];
var selectedMin = null;
var mode = 'walking';
var center = null;
var postcodeLayer = null;
var pendingPlace = null;
var postcodeChipVisible = false;
var lastSearchQuery = '';

function isoFillId(m)  { return 'iso-' + m + '-fill'; }
function isoLineId(m)  { return 'iso-' + m + '-line'; }

function isoSourceId(m) { return 'iso-' + m; }

function removeIsoLayer(m) {
  if (map.getLayer(isoFillId(m)))    map.removeLayer(isoFillId(m));
  if (map.getLayer(isoLineId(m)))    map.removeLayer(isoLineId(m));
  if (map.getSource(isoSourceId(m))) map.removeSource(isoSourceId(m));
}

// Draw one contour, replacing any already drawn for the same minutes.
function addIsoLayer(feature) {
  var mins = feature.properties.contour;
  var sid  = isoSourceId(mins);
  var color = COLORS[MINS.indexOf(mins)] || '#888';
  removeIsoLayer(mins);
  map.addSource(sid, { type: 'geojson', data: feature });
  map.addLayer({ id: isoFillId(mins), type: 'fill', source: sid,
    paint: { 'fill-color': color, 'fill-opacity': 0.18 } });
  map.addLayer({ id: isoLineId(mins), type: 'line', source: sid,
    paint: { 'line-color': color, 'line-width': 3.5, 'line-opacity': 0.9 } });
  isoLayers = isoLayers.filter(function(l) { return l.minutes !== mins; });
  isoLayers.push({ minutes: mins, data: feature });
}

function removeAllIsoLayers() {
  isoLayers.forEach(function(l) { removeIsoLayer(l.minutes); });
  isoLayers = [];
}

function geojsonBounds(geojson) {
  var coords = [];
  function walk(geom) {
    if (!geom) return;
    if (geom.type === 'Polygon')           { geom.coordinates.forEach(function(r) { coords = coords.concat(r); }); }
    else if (geom.type === 'MultiPolygon') { geom.coordinates.forEach(function(p) { p.forEach(function(r) { coords = coords.concat(r); }); }); }
  }
  if (geojson.type === 'Feature')                { walk(geojson.geometry); }
  else if (geojson.type === 'FeatureCollection') { geojson.features.forEach(function(f) { walk(f.geometry); }); }
  else { walk(geojson); }
  if (!coords.length) return null;
  var b = new mapboxgl.LngLatBounds(coords[0], coords[0]);
  coords.forEach(function(c) { b.extend(c); });
  return b;
}

// Put every layer of ours back on a freshly loaded style. Safe to run more than once.
function rehydrateLayers() {
  var saved = isoLayers;
  isoLayers = [];
  saved.forEach(function(l) { addIsoLayer(l.data); });
  if (selectedMin !== null) updateIsoHighlight();

  if (postcodeLayer) addPostcodeLayers(postcodeLayer);

  if (stationsData) addStationsLayer(stationsData); // [stations]
  if (fuelData) addFuelLayer(fuelData); // [fuel]
  if (parkingOn) addParkingLayers(); // [parking]
}

function isoFitPadding() {
  return window.innerWidth <= 768
    ? { top: 60, right: 24, bottom: 200, left: 24 }
    : { top: 60, right: 24, bottom: 100, left: 340 };
}
function fitIsochroneBounds() {
  if (!isoLayers.length) return;
  var bounds = geojsonBounds(isoLayers[0].data);
  if (bounds) map.fitBounds(bounds, { padding: fitPadding(isoFitPadding()), maxZoom: 14 });
}

function placeMarker(lat, lng) {
  updateMarkerColor();
  markerInstance.setLngLat([lng, lat]).addTo(map);
  marker = markerInstance;
}

function pickMode(m) {
  if (!pendingPlace) return;
  mode = m;
  updateModeButtons();
  run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
}

function updateModeButtons() {
  ['walking', 'cycling', 'driving'].forEach(function(m) {
    var btn = document.getElementById('btn-' + m);
    if (btn) btn.classList.toggle('active', m === mode);
  });
}

function resetBucketSelection() {
  selectedMin = null;
  var slots = document.querySelector('.travel-slots');
  if (slots) slots.classList.remove('has-selection');
  MINS.forEach(function(m) {
    var slot = document.getElementById('slot-' + m);
    if (slot) slot.classList.remove('active');
  });
}

function updateIsoHighlight() {
  isoLayers.forEach(function(l) {
    var m = l.minutes;
    var sel = selectedMin !== null && m === selectedMin;
    var dim = selectedMin !== null && m !== selectedMin;
    if (map.getLayer(isoLineId(m))) {
      map.setPaintProperty(isoLineId(m), 'line-width',   sel ? 5.5 : (dim ? 2   : 3.5));
      map.setPaintProperty(isoLineId(m), 'line-opacity', sel ? 1.0 : (dim ? 0.35 : 0.9));
    }
    if (map.getLayer(isoFillId(m))) {
      map.setPaintProperty(isoFillId(m), 'fill-opacity', sel ? 0.28 : (dim ? 0.08 : 0.18));
    }
  });
}

function selectBucket(min) {
  selectedMin = (selectedMin === min) ? null : min;
  var slots = document.querySelector('.travel-slots');
  MINS.forEach(function(m) {
    var slot = document.getElementById('slot-' + m);
    if (slot) slot.classList.toggle('active', m === selectedMin);
  });
  if (slots) slots.classList.toggle('has-selection', selectedMin !== null);
  updateIsoHighlight();
  updatePermalink(); // [permalink]
}

// Take the travel view off the map (isochrones, stations, bucket) and drop any lookup for it
// that is still on its way. Every way out of the view goes through here.
function clearTravel() {
  runSeq++;
  lastRunArgs = null;
  removeAllIsoLayers();
  clearStations(); // [stations]
  resetBucketSelection();
}

function changeMode() {
  clearTravel();
  clearPermalink(); // [permalink]
  hidePostcodeChip();
  if (pendingPlace && pendingPlace.postcode) {
    showPostcodeChip();
    searchPostcode(pendingPlace.postcode);
    setState('modepicker');
  } else {
    modePickerBack();
  }
}

function closeTravelCard() {
  if (marker) { marker.remove(); marker = null; }
  clearTravel();
  pendingPlace = null;
  setState('idle');
  clearPermalink(); // [permalink]
}

function closePostcodeChip() {
  hidePostcodeChip();
  clearTravel();
  if (marker) { marker.remove(); marker = null; }
  pendingPlace = null;
  setState('idle');
  clearPermalink(); // [permalink]
}

function showPostcodeChip() {
  var name = pendingPlace.name;
  var postcode = pendingPlace.postcode;
  var isBare = (name === postcode);
  document.getElementById('pc-label').textContent = isBare ? postcode : name;
  var badge = document.getElementById('pc-badge');
  if (badge) badge.textContent = isBare ? '' : postcode;
  var pcSt = document.getElementById('pc-st');
  if (pcSt) { pcSt.textContent = 'Loading boundary…'; pcSt.classList.add('is-loading'); }
  // Travel times wait for the boundary (they start from its centre); parking only needs a point,
  // which a bare postcode doesn't have until its boundary loads. postcodeReady() enables both.
  document.getElementById('postcode-cta-btn').disabled = true;
  document.getElementById('postcode-parking-btn').disabled = !pendingPlace.lat;
  document.getElementById('postcode-chip').classList.add('postcode-chip-active');
  postcodeChipVisible = true;
}

function hidePostcodeChip() {
  postcodeSeq++;   // a boundary still loading is no longer wanted
  document.getElementById('postcode-chip').classList.remove('postcode-chip-active');
  postcodeChipVisible = false;
  removePostcodeLayers();
}

function chipBack() {
  modePickerBack();
}

function launchFromPostcodeDefault() {
  if (!pendingPlace) return;
  hidePostcodeChip();
  mode = 'walking';
  updateModeButtons();
  setState('travel');
  run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
}

function copyPostcode() {
  if (!pendingPlace || !pendingPlace.postcode) return;
  copyText(pendingPlace.postcode, function() {
    flashCopied(document.getElementById('pc-copy-btn'), 'pc-copy-btn--copied');
  });
}

function modePickerBack() {
  hidePostcodeChip();
  if (marker) { marker.remove(); marker = null; }
  openSearchOverlay();
  var q = lastSearchQuery.trim();
  overlayInput.value = lastSearchQuery;
  if (q) {
    pendingPostcode = PC_RE.test(q) ? formatPostcode(q) : null;
    fetchSuggest(q);
  }
  pendingPlace = null;
}

function newSessionToken() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
}
var sessionToken = newSessionToken();
var suggestTimer = null;
var suggestSeq = 0;   // the newest suggest request; answers to older ones are dropped
var currentSuggestions = [];
var activeIdx = -1;
var pendingPostcode = null;
var preSearchState = null;

var overlayInput = document.getElementById('overlay-input');
var overlaySugg = document.getElementById('overlay-sugg');
var overlayEl = document.getElementById('search-overlay');

var SEARCH_HELPER_HTML = '<div class="search-helper"><p class="search-helper-hint">Search for any place, landmark or postcode</p><div class="search-helper-chips"><button class="search-helper-chip" onclick="triggerExampleSearch(\'Big Ben\')">Big Ben</button></div></div>';

var RECENT_KEY = 'recent_searches';

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch(e) { return []; }
}

function saveRecentSearch(entry) {
  if (!entry || !entry.name) return;
  var recent = getRecentSearches();
  recent = recent.filter(function(r) { return r.name !== entry.name; });
  recent.unshift(entry);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5))); } catch(e) {}
}

function renderHelperContent() {
  var recent = getRecentSearches();
  overlaySugg.innerHTML = recent.length
    ? '<div class="search-helper"><p class="search-helper-hint">Recent searches</p></div>'
    : SEARCH_HELPER_HTML;
  if (fuelEnabled) { // [fuel] shortcut above the helper / recents
    var fuelItem = document.createElement('div');
    fuelItem.className = 'sugg-item sugg-fuel';
    fuelItem.innerHTML = '<div class="sugg-name">⛽ Fuel prices near me</div><div class="sugg-addr">Cheapest fuel around your location</div>';
    fuelItem.addEventListener('click', function() { closeSearchOverlay(); fuelNearMe(); });
    overlaySugg.insertBefore(fuelItem, overlaySugg.firstChild);
  }
  recent.forEach(function(r, i) {
    var item = document.createElement('div');
    item.className = 'sugg-item';
    item.innerHTML = '<div class="sugg-name"><span class="sugg-recent-icon">◷</span> </div><div class="sugg-addr"></div>';
    item.querySelector('.sugg-name').appendChild(document.createTextNode(r.name));
    item.querySelector('.sugg-addr').textContent = r.address || '';
    item.addEventListener('mousedown', (function(idx) {
      return function(e) { e.preventDefault(); launchRecentSearch(idx); };
    })(i));
    overlaySugg.appendChild(item);
  });
}

// Show a searched place: its postcode card when it has a postcode, else its travel times.
// Whatever travel view was showing belongs to the previous place, so it goes first.
function goToPlace(place) {
  clearTravel();
  pendingPlace = place;
  map.flyTo({ center: [place.lng, place.lat], zoom: 12, duration: 1000 });
  placeMarker(place.lat, place.lng);
  setStatus(place.name);
  if (place.postcode) {
    showPostcodeChip();
    searchPostcode(place.postcode);
    setState('modepicker');
  } else {
    updateModeButtons();
    setState('travel');
    run(place.lng, place.lat, place.name);
  }
}

// Show a bare postcode: its card and boundary. Its coordinates (0, 0 until then) come from
// the boundary once that loads.
function goToPostcode(pc) {
  clearTravel();
  if (marker) { marker.remove(); marker = null; }
  pendingPlace = { lng: 0, lat: 0, name: pc, address: 'UK postcode boundary', postcode: pc };
  showPostcodeChip();
  searchPostcode(pc);
  setState('modepicker');
}

function launchRecentSearch(idx) {
  var recent = getRecentSearches();
  var r = recent[idx];
  if (!r) return;
  closeSearchOverlay();
  if (r.type === 'place') {
    lastSearchQuery = r.name;
    goToPlace({ lng: r.lng, lat: r.lat, name: r.name, address: r.address, postcode: r.postcode });
  } else {
    lastSearchQuery = r.postcode;
    goToPostcode(r.postcode);
  }
}

function triggerExampleSearch(q) {
  overlayInput.value = q;
  clearTimeout(suggestTimer);
  fetchSuggest(q);
}

function openSearchOverlay() {
  preSearchState = appState;
  setState('search');
  overlayInput.value = '';
  overlayInput.placeholder = 'Search Maps';
  pendingPostcode = null;
  currentSuggestions = [];
  renderHelperContent();
  requestAnimationFrame(function() {
    if (appState !== 'search') return;   // closed again before the frame came round
    overlayEl.classList.add('open');
    overlayInput.focus();
  });
}

function closeSearchOverlay() {
  clearTimeout(suggestTimer);
  suggestSeq++;   // suggestions still on their way are no longer wanted
  overlayInput.blur();
  overlayEl.classList.remove('open');
  pendingPostcode = null;
  currentSuggestions = [];
  overlaySugg.innerHTML = '';
  if (preSearchState === 'modepicker' && pendingPlace) {
    setState('modepicker');
  } else if (preSearchState === 'travel' && lastRunArgs) {
    setState('travel');   // the travel view is still on the map: back to its card
  } else {
    setState('idle');
  }
  preSearchState = null;
}

function formatPostcode(raw) {
  var s = raw.replace(/\s+/g, '').toUpperCase();
  return s.slice(0, -3) + ' ' + s.slice(-3);
}

function renderSuggestions() {
  overlaySugg.innerHTML = '';
  var items = getMergedItems();

  items.forEach(function(s, i) {
    var item = document.createElement('div');
    item.className = 'sugg-item' + (i === activeIdx ? ' active' : '');
    if (s.type === 'postcode') {
      item.className += ' sugg-postcode';
      item.innerHTML = '<div class="sugg-name"><span class="sugg-pc-icon">▣</span> </div><div class="sugg-addr"></div>';
      item.querySelector('.sugg-name').appendChild(document.createTextNode(s.name));
      item.querySelector('.sugg-addr').textContent = 'UK postcode boundary';
    } else {
      item.innerHTML = '<div class="sugg-name"></div><div class="sugg-addr"></div>';
      item.querySelector('.sugg-name').textContent = s.name;
      item.querySelector('.sugg-addr').textContent = s.place_formatted || s.full_address || '';
    }
    item.addEventListener('mousedown', function(e) { e.preventDefault(); selectSuggestionFromList(i, items); });
    overlaySugg.appendChild(item);
  });
}

async function fetchSuggest(q) {
  var seq = ++suggestSeq;
  var found = [];
  try {
    var mc = map.getCenter();
    var url = 'https://api.mapbox.com/search/searchbox/v1/suggest?q=' + encodeURIComponent(q)
      + '&language=en&country=gb&proximity=' + mc.lng.toFixed(4) + ',' + mc.lat.toFixed(4) + '&limit=6'
      + '&session_token=' + sessionToken
      + '&access_token=' + MAPBOX_TOKEN;
    var r = await fetch(url);
    var d = await r.json();
    found = (d.suggestions || []).map(function(s) {
      return { mapbox_id: s.mapbox_id, name: s.name, place_formatted: s.place_formatted, full_address: s.full_address };
    });
  } catch (e) {}
  if (seq !== suggestSeq) return;   // the box has changed or closed since this was asked
  currentSuggestions = found;
  activeIdx = -1;
  renderSuggestions();
}

function selectSuggestionFromList(i, items) {
  var s = items[i];
  if (!s) return;
  if (s.type === 'postcode') {
    lastSearchQuery = overlayInput.value;
    closeSearchOverlay();
    saveRecentSearch({ type: 'postcode', name: s.postcode, address: 'UK postcode', postcode: s.postcode });
    goToPostcode(s.postcode);
    return;
  }
  selectSuggestion(s);
}

async function selectSuggestion(s) {
  if (!s || !s.mapbox_id) return;
  lastSearchQuery = overlayInput.value;
  closeSearchOverlay();
  setStatus('Loading…');
  try {
    var url = 'https://api.mapbox.com/search/searchbox/v1/retrieve/' + encodeURIComponent(s.mapbox_id)
      + '?session_token=' + sessionToken + '&access_token=' + MAPBOX_TOKEN;
    var r = await fetch(url);
    var d = await r.json();
    if (d.features && d.features.length) {
      var c = d.features[0].geometry.coordinates;
      var props = d.features[0].properties;
      var name = s.name || props.name || '';
      var address = props.full_address || s.place_formatted || '';
      var postcode = null;
      if (props.context) {
        var ctxArr = Array.isArray(props.context) ? props.context : Object.values(props.context);
        for (var ci = 0; ci < ctxArr.length; ci++) {
          var ctx = ctxArr[ci];
          if (ctx && (ctx.layer === 'postcode' || (ctx.id && ctx.id.startsWith('postcode.'))) && ctx.name) {
            postcode = ctx.name.trim().toUpperCase(); break;
          }
        }
      }
      if (!postcode) {
        var fa = props.full_address || address || '';
        var pcMatch = fa.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
        if (pcMatch) postcode = formatPostcode(pcMatch[1]);
      }
      saveRecentSearch({ type: 'place', name: name, address: address, lat: c[1], lng: c[0], postcode: postcode });
      goToPlace({ lng: c[0], lat: c[1], name: name, address: address, postcode: postcode });
      sessionToken = newSessionToken();
    } else { setStatus('Could not load that location', true); }
  } catch (e) { setStatus('Search failed', true); }
}

document.getElementById('search-back-btn').addEventListener('click', closeSearchOverlay);

overlayInput.addEventListener('input', function() {
  var q = overlayInput.value.trim();
  clearTimeout(suggestTimer);
  suggestSeq++;   // an answer for the text as it was is out of date
  if (!q) { pendingPostcode = null; currentSuggestions = []; renderHelperContent(); return; }
  pendingPostcode = PC_RE.test(q) ? formatPostcode(q) : null;
  if (pendingPostcode) renderSuggestions();
  suggestTimer = setTimeout(function() { fetchSuggest(q); }, 180);
});

function getMergedItems() {
  var items = [];
  if (pendingPostcode) {
    items.push({ type: 'postcode', postcode: pendingPostcode, name: pendingPostcode + ' · Show boundary' });
  }
  var pcNorm = pendingPostcode ? pendingPostcode.replace(/\s+/g, '').toUpperCase() : null;
  currentSuggestions.forEach(function(s) {
    if (pcNorm && s.name && s.name.replace(/\s+/g, '').toUpperCase() === pcNorm) return;
    items.push(s);
  });
  return items;
}

overlayInput.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeSearchOverlay(); return; }
  var items = getMergedItems();
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, items.length - 1);
    renderSuggestions();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectSuggestionFromList(activeIdx >= 0 ? activeIdx : 0, items);
  }
});

// [retry] Args of the most recent run(), so a transient failure can be re-attempted
// — automatically below, or by the user tapping the error status line.
var lastRunArgs = null;  // also the sign that a travel view is showing; clearTravel() empties it
var runSeq = 0;          // the newest run(); an older one's answers are dropped when they arrive late
var ISO_MAX_RETRIES = 2; // re-attempts for a transient isochrone fetch (network blip / 429 / 5xx)

function isoDelay(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }
function isoTransientStatus(s) { return s === 429 || (s >= 500 && s <= 599); }
function retryLastRun() { if (lastRunArgs) run(lastRunArgs.lng, lastRunArgs.lat, lastRunArgs.label); }

// Surface a recoverable failure: recenter on the searched point so a failed search
// still takes you SOMEWHERE (fitIsochroneBounds can't run with no layers), then show
// a clear message — with a tap-to-retry hint only when retrying could actually help.
function isoError(lng, lat, msg, retryable) {
  map.flyTo({ center: [lng, lat], zoom: 14 });
  setStatus(retryable ? msg + ' · Tap to retry' : msg, true);
}

async function run(lng, lat, label) {
  // A newer run() (another mode or place) or clearTravel() moves runSeq on. This run then
  // stops at its next step, so a slow answer can't draw over, or after, what replaced it.
  var seq = ++runSeq;
  center = [lng, lat];
  lastRunArgs = { lng: lng, lat: lat, label: label }; // [retry]
  setStatus('Loading isochrones…');
  placeMarker(lat, lng);

  removeAllIsoLayers();
  resetBucketSelection();

  var profile = mode === 'driving' ? 'driving-traffic' : mode;
  var url = 'https://api.mapbox.com/isochrone/v1/mapbox/' + profile + '/' + lng + ',' + lat
    + '?contours_minutes=' + MINS.join(',')
    + '&contours_colors=' + COLORS.map(function(c) { return c.slice(1); }).join(',')
    + '&polygons=true&generalize=50&access_token=' + MAPBOX_TOKEN;

  // Transient failures (network blip, 429, 5xx) are the usual reason a perimeter
  // "sometimes" fails to appear on first search. Retry those a couple of times with
  // a short backoff before giving up. Permanent errors (bad coords, empty result)
  // fall straight through without retrying.
  var data = null, failure = '';
  for (var attempt = 0; attempt <= ISO_MAX_RETRIES && !data; attempt++) {
    if (attempt) await isoDelay(400 * attempt);
    if (seq !== runSeq) return;
    try {
      var r = await fetch(url);
      if (isoTransientStatus(r.status)) failure = 'Map service is busy';
      else data = await r.json();
    } catch (e) {
      failure = 'Couldn’t reach the map service';
    }
  }
  if (seq !== runSeq) return;

  if (!data) { return isoError(lng, lat, failure, true); }
  if (data.message) { return isoError(lng, lat, 'API error: ' + data.message, false); }
  if (!data.features || !data.features.length) { return isoError(lng, lat, 'No travel data for this spot', false); }

  var sorted = data.features.slice().sort(function(a, b) { return b.properties.contour - a.properties.contour; });
  whenStyleReady(function() {
    if (seq !== runSeq) return;
    sorted.forEach(addIsoLayer);
    fitIsochroneBounds();
  });

  setStatus(label || lat.toFixed(4) + '°N, ' + lng.toFixed(4) + '°E');
  updatePermalink(); // [permalink]
  loadNearbyStations(lat, lng, seq); // [stations]
}

// [retry] Tapping the status line while it shows an error re-runs the last search.
(function() {
  var st = document.getElementById('st');
  if (st) st.addEventListener('click', function() {
    if (st.classList.contains('error') && lastRunArgs) retryLastRun();
  });
})();

/* ===== NEARBY STATIONS ===== */
var stationsData = null; // GeoJSON FeatureCollection of currently-shown stations (null when none)

function haversineMetres(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Map a walk-time (minutes) to its isochrone bucket colour: ≤5 green, ≤10 blue,
// ≤15 orange, ≤20 (and anything beyond) red. Mirrors the COLORS/MINS pairing used
// for the travel slots, so a station's time label matches the ring it falls inside.
function bucketColor(mins) {
  for (var i = 0; i < MINS.length; i++) {
    if (mins <= MINS[i]) return COLORS[i];
  }
  return COLORS[COLORS.length - 1];
}

// "#2ecc71" → "rgba(46,204,113,a)". Used for the faint tinted fill behind a
// station's time pill, so the bucket colour reads as a soft background.
function hexToRgba(hex, a) {
  var n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// Re-rank a raw station list (no dist) against an exact point: compute walk
// distance, sort nearest-first, keep the closest 5. Used for both fresh fetches
// and cache hits, so distances stay accurate even when a cache entry (keyed to a
// rounded coordinate) is reused for a slightly different pin.
function rankStations(list, lat, lng) {
  return (list || []).map(function(s) {
    return { name: s.name, lat: s.lat, lng: s.lng, dist: haversineMetres(lat, lng, s.lat, s.lng) };
  }).sort(function(a, b) { return a.dist - b.dist; }).slice(0, 5);
}

function stationCacheKey(lat, lng) {
  // Round to 3 decimals (~110 m grid) so nearby pins share a cache entry.
  return 'st:' + lat.toFixed(3) + ',' + lng.toFixed(3);
}
function readStationCache(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var e = JSON.parse(raw);
    if (Date.now() - e.ts > CACHE_TTL) { localStorage.removeItem(key); return null; }
    return e.stations || null;
  } catch (e) { return null; }
}
function writeStationCache(key, stations) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), stations: stations })); } catch (e) {}
}

// `seq` is the run() these stations belong to; see runSeq.
async function loadNearbyStations(lat, lng, seq) {
  var listEl = document.getElementById('travel-stations');
  if (!listEl) return;

  // Cache hit → render instantly, skip the (cold-slow) TfL round-trip.
  var key = stationCacheKey(lat, lng);
  var cached = readStationCache(key);
  if (cached) {
    var hit = rankStations(cached, lat, lng);
    if (hit.length) { renderStationList(hit); renderStationMarkers(hit); return; }
  }

  listEl.innerHTML = '<div class="travel-stations-title">Nearby stations</div>'
    + '<div class="travel-stations-empty">Finding stations…</div>';
  try {
    // 1000 m radius is plenty — we only ever show the 5 nearest, and a tighter
    // radius means far less work for TfL to hydrate (faster cold response).
    var url = 'https://api.tfl.gov.uk/StopPoint?stopTypes=NaptanMetroStation,NaptanRailStation&lat='
      + lat + '&lon=' + lng + '&radius=1000&useStopPointHierarchy=false';
    var r = await fetch(url);
    if (!r.ok) throw new Error('TfL HTTP ' + r.status);   // an error body has no stopPoints: not "no stations"
    var d = await r.json();
    if (seq !== runSeq) return;
    var pts = (d && d.stopPoints) || [];
    // Cache the raw (dist-less) list; distances are derived per-render via rankStations.
    var raw = pts.filter(function(s) { return typeof s.lat === 'number' && typeof s.lon === 'number'; })
      .map(function(s) {
        return {
          name: (s.commonName || '').replace(/\s+(Underground|Rail|DLR)\s+Station$/i, '').replace(/\s+Station$/i, ''),
          lat: s.lat, lng: s.lon
        };
      });
    writeStationCache(key, raw);
    var stations = rankStations(raw, lat, lng);

    if (!stations.length) {
      stationsData = null;
      clearStationsLayer();
      listEl.innerHTML = '<div class="travel-stations-title">Nearby stations</div>'
        + '<div class="travel-stations-empty">No nearby stations</div>';
      return;
    }
    renderStationList(stations);
    renderStationMarkers(stations);
  } catch (e) {
    if (seq !== runSeq) return;
    stationsData = null;
    clearStationsLayer();
    listEl.innerHTML = '<div class="travel-stations-title">Nearby stations</div>'
      + '<div class="travel-stations-empty">Couldn’t load stations</div>';
  }
}

function renderStationList(stations) {
  var listEl = document.getElementById('travel-stations');
  if (!listEl) return;
  listEl.innerHTML = '';
  var title = document.createElement('div');
  title.className = 'travel-stations-title';
  title.textContent = 'Nearby stations';
  listEl.appendChild(title);

  stations.forEach(function(st) {
    var mins = Math.max(1, Math.round(st.dist / 80));
    var row = document.createElement('div');
    row.className = 'travel-station-row';

    // Left: station name (truncates when long).
    var nameEl = document.createElement('div');
    nameEl.className = 'travel-station-name';
    nameEl.textContent = st.name;

    // Right: walk time as a pill coloured by the station's isochrone bucket —
    // outlined + faintly tinted to match the 5/10/15/20 travel-slot buttons.
    var bc = bucketColor(mins);
    var timeEl = document.createElement('div');
    timeEl.className = 'travel-station-time';
    timeEl.textContent = mins + ' min';
    timeEl.style.color = bc;
    timeEl.style.borderColor = hexToRgba(bc, 0.55);
    timeEl.style.background = hexToRgba(bc, 0.12);

    row.appendChild(nameEl);
    row.appendChild(timeEl);
    row.addEventListener('click', (function(s) {
      return function() { map.flyTo({ center: [s.lng, s.lat], zoom: 15, duration: 800 }); };
    })(st));
    listEl.appendChild(row);
  });
}

function stationsToGeoJSON(stations) {
  return {
    type: 'FeatureCollection',
    features: stations.map(function(st) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [st.lng, st.lat] },
        properties: { name: st.name }
      };
    })
  };
}

function addStationsLayer(geojson) {
  whenStyleReady(function() {
    if (map.getLayer('stations-circle')) map.removeLayer('stations-circle');
    if (map.getSource('stations')) map.removeSource('stations');
    map.addSource('stations', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'stations-circle', type: 'circle', source: 'stations',
      paint: {
        'circle-radius': 5,
        'circle-color': '#5b8dee',
        'circle-stroke-width': 2,
        'circle-stroke-color': isDark ? '#0a0a0a' : '#ffffff'
      }
    });
  });
}

function renderStationMarkers(stations) {
  stationsData = stationsToGeoJSON(stations);
  addStationsLayer(stationsData);
}

function clearStationsLayer() {
  if (map.getLayer('stations-circle')) map.removeLayer('stations-circle');
  if (map.getSource('stations')) map.removeSource('stations');
}

function clearStations() {
  stationsData = null;
  clearStationsLayer();
  var listEl = document.getElementById('travel-stations');
  if (listEl) listEl.innerHTML = '';
}
/* ===== END NEARBY STATIONS ===== */

/* ===== FUEL PRICES ===== */
// Postcode lookup (functions/api/fuel.js), which asks the uk-fuel MCP server for the
// cheapest stations near a place. Results are listed in the panel and plotted as the
// 'fuel' GeoJSON source. It opens from the postcode card's Fuel Prices button, the
// travel card's fuel button, or "Fuel prices near me" on the search screen; these
// only appear when GET /api/fuel says the endpoint is enabled. Places and your own
// location are looked up by coordinates, which the function turns into the nearest
// postcode.
var FUEL_URL = '/api/fuel';
var FUEL_LAST_KEY = 'ldnmap:fuelLast';  // { location, fuel } remembered per browser
var fuelSeq = 0;           // the newest lookup; answers to older ones are dropped
var fuelType = 'E10';
var fuelEnabled = false;
var fuelPoint = null;      // { lat, lng } when searching around a point; the input then shows its label
var fuelData = null;       // GeoJSON FeatureCollection currently plotted (null when none)
var fuelStations = {};     // node_id → station, for popups
var fuelPopup = null;
var FUEL_NAMES = { E10: 'E10 petrol', E5: 'E5 super', B7_STANDARD: 'Diesel', B7_PREMIUM: 'Premium diesel', B10: 'B10 diesel', HVO: 'HVO' };
var FUEL_EXAMPLES = ['SW1A 1AA', 'Hackney', 'Croydon'];

var fuelPanel = document.getElementById('fuel-panel');
var fuelResults = document.getElementById('fuel-results');
var fuelInput = document.getElementById('fuel-input');

function isMobileView() { return window.matchMedia('(max-width: 768px)').matches; }

function probeFuel() {
  fetch(FUEL_URL, { method: 'GET' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) {
      if (!d || !d.enabled) return;
      fuelEnabled = true;
      document.getElementById('postcode-fuel-btn').hidden = false;
      document.getElementById('travel-fuel-btn').hidden = false;
    })
    .catch(function() {});
}

function loadFuelLast() {
  try {
    var v = JSON.parse(localStorage.getItem(FUEL_LAST_KEY) || 'null');
    if (v && typeof v.location === 'string') fuelInput.value = v.location;
    if (v && FUEL_NAMES[v.fuel]) setFuelType(v.fuel);
  } catch (e) {}
}

function saveFuelLast(location) {
  try { localStorage.setItem(FUEL_LAST_KEY, JSON.stringify({ location: location, fuel: fuelType })); } catch (e) {}
}

function openFuel() {
  if (parkingOn) toggleParking(false);  // [parking] the two panels share a spot
  if (!fuelResults.children.length) renderFuelEmpty();
  fuelPanel.classList.add('open');
  document.body.classList.add('fuel-open');
  if (window.__fuelSheet) window.__fuelSheet.open();
  // On mobile, only focus an empty box: re-opening to read results shouldn't raise the keyboard.
  if (!isMobileView() || !fuelInput.value) requestAnimationFrame(function() { fuelInput.focus(); });
}

// Postcode card button: look up prices for the place the user just picked.
function fuelFromPostcode() {
  if (!pendingPlace || !pendingPlace.postcode) return;
  fuelPoint = null;
  fuelInput.value = pendingPlace.postcode;
  openFuel();
  if (isMobileView()) fuelInput.blur();
  lookupFuel();
}

// Search around a point (a place on the map, or the user's location), shown as `label`.
function fuelNear(lat, lng, label) {
  fuelPoint = { lat: lat, lng: lng };
  fuelInput.value = label;
  if (!fuelPanel.classList.contains('open')) openFuel();
  if (isMobileView()) fuelInput.blur();
  lookupFuel();
}

// Travel card button: prices around the place whose travel times are showing.
function fuelFromTravel() {
  if (!lastRunArgs) return;
  fuelNear(lastRunArgs.lat, lastRunArgs.lng, lastRunArgs.label || 'This place');
}

// "Near me": ask the browser for the user's location.
function fuelNearMe() {
  if (!fuelPanel.classList.contains('open')) openFuel();
  if (isMobileView()) fuelInput.blur();
  if (!navigator.geolocation) { fuelMessage('error', 'Your browser can’t share your location. Enter a postcode instead.'); return; }
  var btn = document.getElementById('fuel-locate');
  btn.disabled = true;
  fuelMessage('pending', 'Finding your location');
  navigator.geolocation.getCurrentPosition(function(pos) {
    btn.disabled = false;
    fuelNear(pos.coords.latitude, pos.coords.longitude, 'Your location');
  }, function(err) {
    btn.disabled = false;
    fuelMessage('error', err.code === 1
      ? 'Location access is off for this site. Allow it in your browser settings, or enter a postcode.'
      : 'Couldn’t find your location. Enter a postcode instead.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60000 });
}

// Typing a new place replaces any point search.
fuelInput.addEventListener('input', function() { fuelPoint = null; });

function closeFuel() {
  fuelInput.blur();
  fuelPanel.classList.remove('open');
  document.body.classList.remove('fuel-open');
  if (window.__fuelSheet) window.__fuelSheet.close();
}

// On mobile the sheet is a draggable bottom sheet: typing pulls it to full height so
// the box stays above the keyboard, and the map views shrink it to show the pins.
function fuelSheetTo(snap) {
  if (isMobileView() && window.__fuelSheet) window.__fuelSheet.snap(snap);
}
function fuelSheetVisible() {
  return isMobileView() && window.__fuelSheet ? window.__fuelSheet.visibleAt(window.__fuelSheet.snapName()) : 0;
}
fuelInput.addEventListener('focus', function() { fuelSheetTo('full'); });

function setFuelType(code) {
  fuelType = code;
  document.querySelectorAll('#fuel-types .fuel-type').forEach(function(b) {
    b.setAttribute('aria-checked', b.dataset.fuel === code ? 'true' : 'false');
  });
}

document.getElementById('fuel-types').addEventListener('click', function(e) {
  var b = e.target.closest('.fuel-type');
  if (!b || b.dataset.fuel === fuelType) return;
  setFuelType(b.dataset.fuel);
  if (fuelInput.value.trim() || fuelPoint) lookupFuel();  // re-run the current search for the new fuel
});

function renderFuelEmpty() {
  fuelResults.innerHTML = '';
  var wrap = document.createElement('div');
  wrap.className = 'search-helper fuel-empty';
  var hint = document.createElement('p');
  hint.className = 'search-helper-hint';
  hint.textContent = 'Enter a UK postcode or area to see the cheapest fuel within 5 miles.';
  var chips = document.createElement('div');
  chips.className = 'search-helper-chips';
  FUEL_EXAMPLES.forEach(function(q) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-helper-chip';
    b.textContent = q;
    b.addEventListener('click', function() { fuelInput.value = q; lookupFuel(); });
    chips.appendChild(b);
  });
  wrap.appendChild(hint);
  wrap.appendChild(chips);
  fuelResults.appendChild(wrap);
}

function fuelMessage(kind, text) {
  fuelResults.innerHTML = '';
  var el = document.createElement('div');
  el.className = 'fuel-msg fuel-msg--' + kind;
  el.textContent = text;
  fuelResults.appendChild(el);
  return el;
}

async function lookupFuel(e) {
  if (e) e.preventDefault();
  var location = fuelInput.value.trim();
  var point = fuelPoint;
  if (!location && !point) return false;
  // The newest lookup wins: changing fuel or place while one is running starts another,
  // and the earlier one's answer is dropped when it arrives.
  var seq = ++fuelSeq;
  var sendBtn = document.getElementById('fuel-send');
  sendBtn.disabled = true;
  if (isMobileView()) fuelInput.blur();               // drop the iOS keyboard so the results are visible
  if (!point) saveFuelLast(location);                 // a point's label isn't a searchable place

  var pending = fuelMessage('pending', 'Checking prices');
  var slowTimer = setTimeout(function() {
    pending.textContent = 'Still checking. The first lookup after a quiet spell can take up to 30 seconds';
  }, 4000);

  try {
    var q = (point
      ? '?lat=' + point.lat.toFixed(5) + '&lon=' + point.lng.toFixed(5)
      : '?location=' + encodeURIComponent(location)) + '&fuel=' + encodeURIComponent(fuelType);
    var r = await fetch(FUEL_URL + q);
    var d = null;
    try { d = await r.json(); } catch (err) {}
    if (seq !== fuelSeq) return false;
    if (!r.ok || !d || !Array.isArray(d.stations)) {
      throw new Error((d && d.error) || 'Couldn’t reach the fuel price service.');
    }
    // For a point search, name the place as the user saw it and put the origin pin on the point
    // itself (the server only knows the nearest postcode).
    renderFuelResults(d, point ? location : ((d.location && d.location.label) || location));
    if (window.__fuelSheet && window.__fuelSheet.snapName() === 'full') fuelSheetTo('half');
    var origin = point ? { latitude: point.lat, longitude: point.lng } : d.location;
    // The prices are already showing; a problem drawing the pins mustn't replace them with an error.
    try { plotFuelResults(d, origin); }
    catch (err) { console.warn('fuel: couldn’t plot the stations', err); }
  } catch (err) {
    if (seq === fuelSeq) fuelMessage('error', err.message || 'Something went wrong.');
  } finally {
    clearTimeout(slowTimer);
    if (seq === fuelSeq) sendBtn.disabled = false;
  }
  return false;
}

// `place` is the name to show for where the search was.
function renderFuelResults(d, place) {
  fuelResults.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'fuel-summary';
  var where = document.createElement('div');
  where.className = 'fuel-summary-text';
  where.textContent = d.stations.length
    ? (FUEL_NAMES[d.fuel] || d.fuel) + ' within ' + d.radius_miles + ' mi of ' + place
    : 'No stations selling ' + (FUEL_NAMES[d.fuel] || d.fuel) + ' within ' + d.radius_miles + ' mi of ' + place + '.';
  head.appendChild(where);
  if (d.stations.length) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fuel-map-btn';
    btn.textContent = 'Map';
    btn.addEventListener('click', function() { fuelSheetTo('peek'); fitFuelBounds(); });
    head.appendChild(btn);
  }
  fuelResults.appendChild(head);
  // The server flags data older than its 15-minute cache and refreshes it in the
  // background; only mention it once the prices are really old.
  var fetched = Date.parse(d.data_fetched_at);
  if (isFinite(fetched) && Date.now() - fetched > 60 * 60000) {
    fuelResults.appendChild(fuelNote('Prices were last checked ' + timeAgo(d.data_fetched_at) + ', so they may have changed.'));
  }

  var list = document.createElement('ol');
  list.className = 'fuel-list';
  var min = d.stations.length ? d.stations[0].price_ppl : null;
  d.stations.forEach(function(s) {
    var li = document.createElement('li');
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'fuel-row' + (s.price_ppl === min ? ' fuel-row--cheapest' : '');
    var main = document.createElement('span');
    main.className = 'fuel-row-main';
    var name = document.createElement('span');
    name.className = 'fuel-row-name';
    name.textContent = s.name || 'Fuel station';
    var meta = document.createElement('span');
    meta.className = 'fuel-row-meta';
    // Some stations' brand is just their name again; skip it then.
    var brand = s.brand && (s.name || '').toLowerCase().indexOf(s.brand.toLowerCase()) === -1 ? s.brand : '';
    meta.textContent = [brand, s.distance_miles.toFixed(1) + ' mi', s.price_updated ? 'updated ' + timeAgo(s.price_updated) : '']
      .filter(Boolean).join(' · ');
    main.appendChild(name);
    main.appendChild(meta);
    var price = document.createElement('span');
    price.className = 'fuel-row-price';
    price.textContent = s.price_ppl.toFixed(1) + 'p';
    row.appendChild(main);
    row.appendChild(price);
    row.addEventListener('click', function() {
      fuelSheetTo('compact');
      // Centre the station in the map area above the sheet.
      map.flyTo({ center: [s.longitude, s.latitude], zoom: 15, offset: [0, -fuelSheetVisible() / 2] });
      showFuelPopup(s.node_id, [s.longitude, s.latitude]);
    });
    li.appendChild(row);
    list.appendChild(li);
  });
  fuelResults.appendChild(list);
}

function fuelNote(text) {
  var el = document.createElement('div');
  el.className = 'fuel-msg fuel-msg--warn';
  el.textContent = text;
  return el;
}

fuelInput.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeFuel(); });
loadFuelLast();

// "2026-11-05T09:00:00Z" → "4h ago"
function timeAgo(iso) {
  var t = Date.parse(iso);
  if (!isFinite(t)) return '';
  var mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 48 * 60) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
}

// A lookup's stations and its origin ({ latitude, longitude }) as GeoJSON for the map, plus a
// node_id → station lookup for popups. The cheapest price gets the green pin.
function fuelFeatures(d, origin) {
  var stations = {};
  var list = d.stations.filter(function(s) { return s && s.node_id && isFinite(s.latitude) && isFinite(s.longitude); });
  var min = Infinity;
  list.forEach(function(s) { if (typeof s.price_ppl === 'number' && s.price_ppl < min) min = s.price_ppl; });
  var features = list.map(function(s) {
    var priced = typeof s.price_ppl === 'number';
    stations[s.node_id] = s;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
      properties: {
        kind: 'station', id: s.node_id,
        label: priced ? s.price_ppl.toFixed(1) + 'p' : '',
        priced: priced ? 1 : 0,
        cheapest: priced && s.price_ppl === min ? 1 : 0
      }
    };
  });
  if (origin && isFinite(origin.latitude) && isFinite(origin.longitude)) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [origin.longitude, origin.latitude] },
      properties: { kind: 'origin', label: '' }
    });
  }
  return { geojson: { type: 'FeatureCollection', features: features }, stations: stations };
}

function plotFuelResults(d, origin) {
  var built = fuelFeatures(d, origin);
  clearFuel();
  if (!built.geojson.features.length) return;
  fuelData = built.geojson;
  fuelStations = built.stations;
  addFuelLayer(fuelData);
  fitFuelBounds();
}

function addFuelLayer(geojson) {
  whenStyleReady(function() {
    removeFuelLayers();
    map.addSource('fuel', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'fuel-origin', type: 'circle', source: 'fuel', filter: ['==', ['get', 'kind'], 'origin'],
      paint: { 'circle-radius': 8, 'circle-color': 'rgba(139,92,246,0.15)', 'circle-stroke-width': 3, 'circle-stroke-color': '#8b5cf6' }
    });
    map.addLayer({
      id: 'fuel-circle', type: 'circle', source: 'fuel', filter: ['==', ['get', 'kind'], 'station'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'cheapest'], 1], 9, 6],
        'circle-color': ['case', ['==', ['get', 'cheapest'], 1], '#2ecc71', ['==', ['get', 'priced'], 1], '#f39c12', '#9a9a9a'],
        'circle-stroke-width': 2,
        'circle-stroke-color': isDark ? '#0a0a0a' : '#ffffff'
      }
    });
    map.addLayer({
      id: 'fuel-label', type: 'symbol', source: 'fuel', filter: ['==', ['get', 'kind'], 'station'],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': ['case', ['==', ['get', 'cheapest'], 1], 13, 11],
        'text-offset': [0, 1.1], 'text-anchor': 'top'
      },
      paint: {
        'text-color': isDark ? '#ffffff' : '#1a1a1a',
        'text-halo-color': isDark ? 'rgba(10,10,10,0.85)' : 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.5
      }
    });
  });
}

function removeFuelLayers() {
  ['fuel-label', 'fuel-circle', 'fuel-origin'].forEach(function(id) { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource('fuel')) map.removeSource('fuel');
}

function clearFuel() {
  fuelData = null;
  fuelStations = {};
  if (fuelPopup) { fuelPopup.remove(); fuelPopup = null; }
  removeFuelLayers();
}

function fitFuelBounds() {
  if (!fuelData || !fuelData.features.length) return;
  var coords = fuelData.features.map(function(f) { return f.geometry.coordinates; });
  if (coords.length === 1) { map.flyTo({ center: coords[0], zoom: 14 }); return; }
  var b = new mapboxgl.LngLatBounds(coords[0], coords[0]);
  coords.forEach(function(c) { b.extend(c); });
  var pad = isMobileView()
    ? { top: 80, right: 32, bottom: fuelSheetVisible() + 24, left: 32 }   // keep pins above the sheet
    : { top: 60, right: 390, bottom: 60, left: 60 };   // keep pins clear of the fuel panel
  map.fitBounds(b, { padding: fitPadding(pad), maxZoom: 14 });
}

function showFuelPopup(id, lngLat) {
  var s = fuelStations[id];
  if (!s) return;
  var el = document.createElement('div');
  el.className = 'fuel-pop';
  var name = document.createElement('div');
  name.className = 'fuel-pop-name';
  name.textContent = s.name || 'Fuel station';
  el.appendChild(name);
  var meta = document.createElement('div');
  meta.className = 'fuel-pop-meta';
  meta.textContent = [s.brand, s.address, s.postcode].filter(Boolean).join(' · ');
  el.appendChild(meta);
  if (typeof s.price_ppl === 'number') {
    var row = document.createElement('div');
    row.className = 'fuel-pop-row';
    var left = document.createElement('span');
    left.textContent = FUEL_NAMES[s.fuel] || s.fuel || '';
    var right = document.createElement('span');
    right.className = 'fuel-pop-price';
    right.textContent = s.price_ppl.toFixed(1) + 'p';
    row.appendChild(left);
    row.appendChild(right);
    if (s.price_updated) {
      var ago = document.createElement('span');
      ago.className = 'fuel-pop-ago';
      ago.textContent = timeAgo(s.price_updated);
      row.appendChild(ago);
    }
    el.appendChild(row);
  }
  if (fuelPopup) fuelPopup.remove();
  fuelPopup = new mapboxgl.Popup({ className: 'fuel-popup', closeButton: false, maxWidth: '260px', offset: 12 })
    .setLngLat(lngLat).setDOMContent(el).addTo(map);
}

// Layer-scoped listeners are kept across setStyle(), so register them once.
map.on('click', 'fuel-circle', function(e) {
  var f = e.features && e.features[0];
  if (f) showFuelPopup(f.properties.id, f.geometry.coordinates.slice());
});
map.on('mouseenter', 'fuel-circle', function() { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'fuel-circle', function() { map.getCanvas().style.cursor = ''; });

probeFuel();
/* ===== END FUEL PRICES ===== */

/* ===== PARKING ===== */
// Controlled parking zones across London's boroughs, coloured by whether parking is
// controlled, free or permit-only at a chosen London day and time, or grey when the
// council's hours aren't in a form the map can read (never guessed). Zone outlines and
// rules (data/parking/, see its README) are fetched once, the first time the layer goes
// on; each borough's streets, kerbs and ticket machines are fetched when the map is over
// it at street level. The status logic lives in parking-rules.js (isControlled), so it
// can be unit-tested. The P map button and the postcode card's P button turn it on; the
// panel's close button turns it off. Below street level a tap zooms in; at street level
// it opens a card.
var PARKING_URL = '/data/parking/';
var PARKING_ATTRIB = 'Parking data: London borough councils; streets © OpenStreetMap contributors';
var PARKING_COVER = [[-0.52, 51.28], [0.34, 51.70]];   // Greater London, SW and NE corners
var PARKING_STREET_ZOOM = 15;
var PARKING_DETAIL_ZOOM = 14.5;                        // start loading a borough's streets a little early
var PARKING_COLORS = { ctrl: '#e74c3c', free: '#2ecc71', permit: '#8e44ad', unknown: '#9ca3af', tfl: '#7f1d1d' };
var PARKING_PILLS = { ctrl: 'Controlled', free: 'Free', permit: 'Permit only', unknown: 'Hours unknown' };
var PARKING_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var PARKING_STAYS = [30, 60, 90, 120, 180, 240];
var PARKING_YELLOW = {   // used when a borough's own wording isn't in the data
  single: 'No waiting during the times on nearby signs. With no sign, the zone’s controlled hours usually apply.',
  double: 'No waiting at any time.',
  loading: 'You can usually stop briefly to pick up or drop off passengers on either, unless kerb marks or signs ban loading.'
};
var parkingOn = false;
var parkingData = null;        // { zones, labels } once loaded; borough detail is in parkingDetail
var parkingLoading = null;     // the in-flight load, so double taps share it
var parkingDetail = {};        // borough id → 'loading' | { streets, kerb, machines } (feature arrays)
var parkingNote = '';          // a one-off message above the hint, until the user moves the map or opens a card
var parkingNow = true;         // follow the clock, or a day/time picked in the panel
var parkingWhen = londonDayTime(new Date());
var parkingEvent = false;
var parkingSel = null;         // the open card: { kind: 'zone'|'street', b, zone, rule, name, tfl, lngLat }
var parkingTimer = null;

var parkingPanel = document.getElementById('parking-panel');
var parkingBody = document.getElementById('parking-body');
var parkingArea = document.getElementById('parking-area');
var parkingDay = document.getElementById('parking-day');
var parkingTime = document.getElementById('parking-time');
var parkingNowBtn = document.getElementById('parking-now');
var parkingEventBox = document.getElementById('parking-event');
var parkingCalc = { band: null, minutes: 60, surcharge: false };

// The P button under the zoom buttons.
map.addControl({
  onAdd: function() {
    var wrap = document.createElement('div');
    wrap.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'parking-ctrl';
    b.className = 'parking-ctrl';
    b.title = 'Parking';
    b.setAttribute('aria-label', 'Parking');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<span class="pk-sign" aria-hidden="true">P</span>';
    b.addEventListener('click', function() { toggleParking(!parkingOn); });
    wrap.appendChild(b);
    return wrap;
  },
  onRemove: function() {}
}, 'top-right');

function parkingGet(name) {
  return fetch(PARKING_URL + name).then(function(r) {
    if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
    return r.json();
  });
}

function loadParkingData() {
  if (parkingData) return Promise.resolve(parkingData);
  if (parkingLoading) return parkingLoading;
  parkingLoading = Promise.all([parkingGet('rules.json'), parkingGet('zones.geojson')])
    .then(function(d) {
      setParkingRules(d[0]);
      parkingData = {
        zones: d[1],
        labels: { type: 'FeatureCollection', features: d[1].features.filter(function(f) { return !f.properties.outline; }).map(function(f) {
          return { type: 'Feature', properties: { zone: f.properties.zone, rule: f.properties.rule },
            geometry: { type: 'Point', coordinates: [f.properties.lx, f.properties.ly] } };
        }) }
      };
      return parkingData;
    })
    .catch(function(e) { parkingLoading = null; throw e; });
  return parkingLoading;
}

// Boroughs whose zones overlap the current view.
function parkingBoroughsInView() {
  if (!parkingRules) return [];
  var v = map.getBounds();
  return Object.keys(parkingRules.boroughs).filter(function(id) {
    var bb = parkingRules.boroughs[id].bbox;
    return bb[0] <= v.getEast() && bb[2] >= v.getWest() && bb[1] <= v.getNorth() && bb[3] >= v.getSouth();
  });
}

// Fetch the streets, kerbs and machines of each borough in view once the map is at street level.
function loadParkingDetail() {
  if (!parkingOn || !parkingRules || map.getZoom() < PARKING_DETAIL_ZOOM) return;
  parkingBoroughsInView().forEach(function(id) {
    if (parkingDetail[id] || !parkingRules.boroughs[id].detail) return;
    parkingDetail[id] = 'loading';
    Promise.all(['streets', 'kerb', 'machines'].map(function(n) { return parkingGet(id + '/' + n + '.geojson'); }))
      .then(function(d) {
        parkingDetail[id] = { streets: d[0].features, kerb: splitKerbSides(d[1].features), machines: d[2].features };
        refreshParkingDetailSources();
        if (parkingSel && parkingSel.b === id) renderParkingBody();   // its card was waiting for the machines
      })
      .catch(function() { delete parkingDetail[id]; });
  });
}

// The detail sources hold every loaded borough together.
function parkingDetailCollection(name) {
  var features = [];
  Object.keys(parkingDetail).forEach(function(id) {
    var d = parkingDetail[id];
    if (d !== 'loading') features = features.concat(d[name]);
  });
  return { type: 'FeatureCollection', features: features };
}

function refreshParkingDetailSources() {
  ['streets', 'kerb', 'machines'].forEach(function(n) {
    var src = map.getSource('parking-' + n);
    if (src) src.setData(parkingDetailCollection(n));
  });
}

// Kerb lines are drawn beside the street: 'both' becomes a left and a right copy,
// and `o` is the side as an offset sign (Mapbox offsets positive values to the right).
function splitKerbSides(features) {
  var out = [];
  features.forEach(function(f) {
    (f.properties.side === 'both' ? ['left', 'right'] : [f.properties.side]).forEach(function(side) {
      out.push({ type: 'Feature', geometry: f.geometry,
        properties: { kind: f.properties.kind, o: side === 'left' ? -1 : 1 } });
    });
  });
  return out;
}

function toggleParking(on) {
  if (on === parkingOn) { if (on) openParkingPanel(); return; }
  parkingOn = on;
  document.getElementById('parking-ctrl').setAttribute('aria-pressed', on ? 'true' : 'false');
  if (!on) {
    closeParkingPanel();
    removeParkingLayers();
    parkingSel = null;
    parkingNote = '';
    clearInterval(parkingTimer);
    return;
  }
  if (fuelPanel.classList.contains('open')) closeFuel();
  openParkingPanel();
  parkingMessage('pending', 'Loading parking zones');
  loadParkingData().then(function() {
    if (!parkingOn) return;
    if (parkingNow) parkingWhen = londonDayTime(new Date());
    syncParkingWhen();
    addParkingLayers();
    loadParkingDetail();
    renderParkingBody();
    clearInterval(parkingTimer);
    parkingTimer = setInterval(function() {
      if (!parkingNow) return;
      var w = londonDayTime(new Date());
      if (w.day === parkingWhen.day && w.minutes === parkingWhen.minutes) return;
      parkingWhen = w;
      syncParkingWhen();
      recolourParking();
    }, 30000);
  }).catch(function() {
    parkingMessage('error', 'Couldn’t load the parking data. Try again.');
  });
}

function openParkingPanel() {
  parkingPanel.classList.add('open');
  document.body.classList.add('parking-open');
  if (window.__parkingSheet) window.__parkingSheet.open();
}

function closeParkingPanel() {
  parkingPanel.classList.remove('open');
  document.body.classList.remove('parking-open');
  if (window.__parkingSheet) window.__parkingSheet.close();
}

// The borough at a point, or null: the zone or borough outline drawn there (or nearest it, when the
// point is on screen), else the first borough whose zones' bounding box holds it. Bounding boxes of
// neighbouring boroughs overlap, so they are only the fallback.
function parkingBoroughAt(lng, lat) {
  if (!parkingRules) return null;
  if (map.getBounds().contains([lng, lat]) && map.getLayer('parking-zones-fill')) {
    var p = map.project([lng, lat]);
    var layers = ['parking-zones-fill', 'parking-borough-fill'].filter(function(l) { return map.getLayer(l); });
    for (var r = 0; r <= 160; r += 40) {
      var hit = map.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers: layers })
        .filter(function(f) { return parkingRules.boroughs[f.properties.b]; })[0];
      if (hit) return hit.properties.b;
    }
  }
  var ids = Object.keys(parkingRules.boroughs).filter(function(id) {
    var bb = parkingRules.boroughs[id].bbox;
    return lng >= bb[0] && lng <= bb[2] && lat >= bb[1] && lat <= bb[3];
  });
  return ids[0] || null;
}

// Postcode card button: parking around the place the user just picked.
function parkingFromPostcode() {
  var p = pendingPlace;
  toggleParking(true);
  loadParkingData().then(function() {
    if (!parkingOn) return;
    if (p && p.lat && parkingBoroughAt(p.lng, p.lat)) {
      map.flyTo({ center: [p.lng, p.lat], zoom: 16, offset: paddingOffset(parkingMapPadding()) });
    } else {
      map.fitBounds(PARKING_COVER, { padding: parkingMapPadding() });
      parkingNote = 'No parking data for that place yet. The coloured areas are the boroughs covered.';
      renderParkingBody();
    }
  }).catch(function() {});   // toggleParking() has already said the data couldn't be loaded
}

// Keep the place clear of the panel (desktop) or the sheet (mobile).
function parkingMapPadding() {
  if (isMobileView()) {
    var vis = window.__parkingSheet ? window.__parkingSheet.visibleAt('compact') : 200;
    return fitPadding({ top: 60, right: 20, bottom: vis + 20, left: 20 });
  }
  return fitPadding({ top: 40, right: 380, bottom: 40, left: 40 });
}

/* --- time controls --- */
function syncParkingWhen() {
  parkingDay.value = String(parkingWhen.day);
  var h = Math.floor(parkingWhen.minutes / 60), m = parkingWhen.minutes % 60;
  parkingTime.value = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  parkingNowBtn.setAttribute('aria-pressed', parkingNow ? 'true' : 'false');
  parkingEventBox.checked = parkingEvent;
}

function onParkingWhenChange() {
  var t = parkingTime.value ? hhmmToMinutes(parkingTime.value) : parkingWhen.minutes;
  parkingWhen = { day: Number(parkingDay.value), minutes: t };
  parkingNow = false;
  syncParkingWhen();
  recolourParking();
}
parkingDay.addEventListener('change', onParkingWhenChange);
parkingTime.addEventListener('change', onParkingWhenChange);
parkingNowBtn.addEventListener('click', function() {
  parkingNow = true;
  parkingWhen = londonDayTime(new Date());
  syncParkingWhen();
  recolourParking();
});
parkingEventBox.addEventListener('change', function() {
  parkingEvent = parkingEventBox.checked;
  recolourParking();
});

function parkingStatus(rule) {
  return isControlled(rule, parkingWhen.day, parkingWhen.minutes, parkingEvent);
}

// 'Controlled now' or 'Controlled at Sat 10:00'.
function parkingWhenLabel() {
  if (parkingNow) return 'now';
  return 'at ' + PARKING_DAYS[parkingWhen.day] + ' ' + parkingTime.value;
}

/* --- map layers --- */
// A paint expression colouring each feature by its rule's status at the chosen time.
function parkingRuleColor() {
  var expr = ['match', ['get', 'rule']];
  Object.keys(parkingRules.rules).forEach(function(k) { expr.push(k, PARKING_COLORS[parkingStatus(k)]); });
  expr.push(PARKING_COLORS.unknown);
  return expr;
}
function parkingStreetColor() {
  return ['case', ['has', 'tfl'], PARKING_COLORS.tfl, parkingRuleColor()];
}

function addParkingLayers() {
  if (!parkingData) return;
  whenStyleReady(function() {
    if (!parkingOn || map.getSource('parking-zones')) return;
    // Zone tints go under the roads; outlines and street colours above the roads but under
    // the road names; kerbs, machines and zone letters on top.
    var styleLayers = map.getStyle().layers;
    var underRoads = (styleLayers.filter(function(l) { return l.type === 'symbol'; })[0] || {}).id;
    var underLabels = map.getLayer('road-label') ? 'road-label'
      : (styleLayers.filter(function(l) { return l.type === 'symbol' && /label/.test(l.id); })[0] || {}).id;
    var ruleColor = parkingRuleColor();
    map.addSource('parking-zones', { type: 'geojson', data: parkingData.zones, attribution: PARKING_ATTRIB });
    map.addSource('parking-zone-labels', { type: 'geojson', data: parkingData.labels });
    map.addSource('parking-streets', { type: 'geojson', data: parkingDetailCollection('streets') });
    map.addSource('parking-kerb', { type: 'geojson', data: parkingDetailCollection('kerb') });
    map.addSource('parking-machines', { type: 'geojson', data: parkingDetailCollection('machines') });
    // Boroughs that publish no zone boundaries: a faint outline you can tap for their zone list.
    map.addLayer({ id: 'parking-borough-fill', type: 'fill', source: 'parking-zones', filter: ['has', 'outline'],
      paint: { 'fill-color': PARKING_COLORS.unknown, 'fill-opacity': 0.06 } }, underRoads);
    map.addLayer({ id: 'parking-borough-outline', type: 'line', source: 'parking-zones', filter: ['has', 'outline'],
      paint: { 'line-color': PARKING_COLORS.unknown, 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 } }, underLabels);
    map.addLayer({ id: 'parking-zones-fill', type: 'fill', source: 'parking-zones', filter: ['!', ['has', 'outline']],
      paint: { 'fill-color': ruleColor,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.35, 12, 0.28, 15, 0.12, 17, 0.06] } }, underRoads);
    map.addLayer({ id: 'parking-zones-line', type: 'line', source: 'parking-zones', filter: ['!', ['has', 'outline']],
      paint: { 'line-color': ruleColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 12, 1, 16, 2.5],
        'line-opacity': 0.8 } }, underLabels);
    map.addLayer({ id: 'parking-streets', type: 'line', source: 'parking-streets', minzoom: PARKING_STREET_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': parkingStreetColor(), 'line-opacity': 0.75,
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 18, 9] } }, underLabels);
    map.addLayer({ id: 'parking-streets-sel', type: 'line', source: 'parking-streets', minzoom: PARKING_STREET_ZOOM,
      filter: parkingSelFilter(), layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': isDark ? '#ffffff' : '#111111', 'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 3], 'line-gap-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 18, 9] } }, underLabels);
    var kerbOffset = ['interpolate', ['linear'], ['zoom'], 16, ['*', ['get', 'o'], 4], 19, ['*', ['get', 'o'], 12]];
    map.addLayer({ id: 'parking-kerb-bay', type: 'line', source: 'parking-kerb', minzoom: 16,
      filter: ['==', ['get', 'kind'], 'bay'],
      paint: { 'line-color': '#2563eb', 'line-width': 3, 'line-offset': kerbOffset } });
    map.addLayer({ id: 'parking-kerb-single', type: 'line', source: 'parking-kerb', minzoom: 16,
      filter: ['==', ['get', 'kind'], 'single_yellow'],
      paint: { 'line-color': '#facc15', 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-offset': kerbOffset } });
    map.addLayer({ id: 'parking-kerb-double', type: 'line', source: 'parking-kerb', minzoom: 16,
      filter: ['==', ['get', 'kind'], 'double_yellow'],
      paint: { 'line-color': '#f59e0b', 'line-width': 4.5, 'line-offset': kerbOffset } });
    map.addLayer({ id: 'parking-machines', type: 'circle', source: 'parking-machines', minzoom: PARKING_STREET_ZOOM,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 4, 18, 7],
        'circle-color': ['match', ['get', 'type'], 'Card only', '#1f2937', 'Card & cash', '#2563eb', '#6b7280'],
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff' } });
    map.addLayer({ id: 'parking-zones-label', type: 'symbol', source: 'parking-zone-labels', minzoom: 11, maxzoom: 17,
      layout: { 'text-field': ['get', 'zone'], 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 13, 13, 16, 20], 'text-allow-overlap': false },
      paint: { 'text-color': ruleColor, 'text-halo-color': isDark ? 'rgba(10,10,10,0.9)' : 'rgba(255,255,255,0.95)',
        'text-halo-width': 2 } });
  });
}

var PARKING_LAYERS = ['parking-zones-label', 'parking-machines', 'parking-kerb-double', 'parking-kerb-single',
  'parking-kerb-bay', 'parking-streets-sel', 'parking-streets', 'parking-zones-line', 'parking-zones-fill',
  'parking-borough-outline', 'parking-borough-fill'];
function removeParkingLayers() {
  PARKING_LAYERS.forEach(function(id) { if (map.getLayer(id)) map.removeLayer(id); });
  ['parking-zones', 'parking-zone-labels', 'parking-streets', 'parking-kerb', 'parking-machines'].forEach(function(id) {
    if (map.getSource(id)) map.removeSource(id);
  });
}

function recolourParking() {
  if (!parkingOn || !parkingData || !map.getLayer('parking-zones-fill')) return;
  var rc = parkingRuleColor();
  map.setPaintProperty('parking-zones-fill', 'fill-color', rc);
  map.setPaintProperty('parking-zones-line', 'line-color', rc);
  map.setPaintProperty('parking-zones-label', 'text-color', rc);
  map.setPaintProperty('parking-streets', 'line-color', parkingStreetColor());
  renderParkingBody();
}

// The selected street is outlined: all pieces with its name in its zone.
function parkingSelFilter() {
  if (!parkingSel || parkingSel.kind !== 'street' || !parkingSel.name) return ['==', ['get', 'name'], '\u0000'];
  return ['all', ['==', ['get', 'name'], parkingSel.name], ['==', ['get', 'zone'], parkingSel.zone],
    ['in', ['get', 'rule'], ['literal', Object.keys(parkingRules.rules).filter(function(k) { return k.indexOf(parkingSel.b + ':') === 0; })]]];
}

/* --- taps --- */
map.on('click', function(e) {
  if (!parkingOn || !map.getLayer('parking-zones-fill')) return;
  if (map.getLayer('fuel-circle') && map.queryRenderedFeatures(e.point, { layers: ['fuel-circle'] }).length) return;
  var zone = map.queryRenderedFeatures(e.point, { layers: ['parking-zones-fill'] })[0];
  if (!zone) {
    // Inside a borough that publishes no zone boundaries: open its zone list at any zoom.
    var outline = map.queryRenderedFeatures(e.point, { layers: ['parking-borough-fill'] })[0];
    if (outline) {
      setParkingSel({ kind: 'borough', b: outline.properties.b, zone: '', rule: outline.properties.rule, lngLat: e.lngLat });
      openParkingPanel();
      if (isMobileView() && window.__parkingSheet) window.__parkingSheet.snap('half');
      parkingBody.scrollTop = 0;
      return;
    }
  }
  if (map.getZoom() < PARKING_STREET_ZOOM - 0.01) {
    // Below street level the first tap zooms in to the zone.
    if (zone) map.flyTo({ center: e.lngLat, zoom: PARKING_STREET_ZOOM + 0.5 });
    return;
  }
  var box = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
  var streets = map.queryRenderedFeatures(box, { layers: ['parking-streets'] });
  var street = nearestRendered(streets, e.lngLat);
  if (street) {
    var p = street.properties;
    setParkingSel({ kind: 'street', b: p.rule.split(':')[0], zone: p.zone, rule: p.rule, name: p.name, tfl: !!p.tfl, lngLat: e.lngLat });
  } else if (zone) {
    setParkingSel({ kind: 'zone', b: zone.properties.b, zone: zone.properties.zone, rule: zone.properties.rule, lngLat: e.lngLat });
  } else {
    return;
  }
  openParkingPanel();
  if (isMobileView() && window.__parkingSheet && window.__parkingSheet.snapName() === 'peek') window.__parkingSheet.snap('compact');
  parkingBody.scrollTop = 0;
});

// Open a card (or, with null, close it): the selected street's outline and the panel follow.
function setParkingSel(sel) {
  parkingSel = sel;
  if (sel) parkingNote = '';
  if (map.getLayer('parking-streets-sel')) map.setFilter('parking-streets-sel', parkingSelFilter());
  renderParkingBody();
}

// Of the street pieces under a tap, the one whose line passes closest to it.
function nearestRendered(features, lngLat) {
  var best = null, bestD = Infinity;
  var p = map.project(lngLat);
  features.forEach(function(f) {
    var lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    lines.forEach(function(line) {
      for (var i = 1; i < line.length; i++) {
        var d = segDist(p, map.project(line[i - 1]), map.project(line[i]));
        if (d < bestD) { bestD = d; best = f; }
      }
    });
  });
  return best;
}
function segDist(p, a, b) {
  var dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  var t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  var x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
  return Math.sqrt(x * x + y * y);
}

['parking-streets', 'parking-zones-fill', 'parking-borough-fill'].forEach(function(id) {
  map.on('mouseenter', id, function() { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', id, function() { map.getCanvas().style.cursor = ''; });
});

function parkingMachines(b) {
  var d = parkingDetail[b];
  return d && d !== 'loading' ? d.machines : [];
}

function nearestMachines(b, lngLat, max, within) {
  return parkingMachines(b)
    .map(function(f) {
      var c = f.geometry.coordinates;
      return { p: f.properties, d: haversineMetres(lngLat.lat, lngLat.lng, c[1], c[0]) };
    })
    .filter(function(m) { return m.d <= within; })
    .sort(function(a, b) { return a.d - b.d; })
    .slice(0, max);
}

/* --- panel content --- */
function pkEl(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pkLink(text, href) {
  var a = pkEl('a', '', text);
  a.href = href; a.target = '_blank'; a.rel = 'noopener';
  return a;
}

function parkingMessage(kind, text) {
  parkingBody.innerHTML = '';
  parkingBody.appendChild(pkEl('div', 'fuel-msg fuel-msg--' + kind, text));
}

// The borough the panel is about: the open card's, else the one under the map centre.
function parkingCurrentBorough() {
  if (parkingSel) return parkingSel.b;
  var c = map.getCenter();
  return parkingBoroughAt(c.lng, c.lat);
}

function renderParkingBody() {
  if (!parkingRules) return;
  var bid = parkingCurrentBorough();
  var borough = bid && parkingRules.boroughs[bid];
  parkingArea.textContent = borough ? borough.name : 'London';
  parkingBody.innerHTML = '';
  if (parkingSel) parkingBody.appendChild(renderParkingCard(parkingSel));
  else {
    if (parkingNote) parkingBody.appendChild(pkEl('div', 'fuel-msg fuel-msg--warn', parkingNote));
    var hint = pkEl('div', 'pk-hint');
    hint.appendChild(pkEl('p', '', map.getZoom() < PARKING_STREET_ZOOM
      ? 'Tap a zone to zoom in, then tap a street to see its rules.'
      : 'Tap a street to see its rules, or tap inside a zone for the zone’s.'));
    var ids = Object.keys(parkingRules.boroughs);
    var mapped = ids.filter(function(id) { return !parkingRules.boroughs[id].listOnly; });
    var known = mapped.reduce(function(n, id) { return n + parkingRules.boroughs[id].knownHours; }, 0);
    var total = mapped.reduce(function(n, id) { return n + parkingRules.boroughs[id].zoneCount; }, 0);
    var partial = mapped.filter(function(id) { return parkingRules.boroughs[id].partial; }).length;
    hint.appendChild(pkEl('p', 'pk-small', 'Zone maps for ' + mapped.length + ' boroughs (' + total + ' zones, ' + known +
      ' with hours this map can read; grey zones show their council’s wording instead). The other ' + (ids.length - mapped.length) +
      ' boroughs publish no zone map this can use: they’re outlined in grey and tapping one lists its zones.' +
      (partial ? ' Where only some of a borough’s zones could be drawn, it’s outlined too: tap outside the drawn zones for the full list.' : '')));
    hint.appendChild(pkEl('p', 'pk-small', 'Yellow lines and bays show only where OpenStreetMap has them (a few percent of streets). A blank kerb doesn’t mean parking is allowed.'));
    hint.appendChild(pkEl('p', 'pk-small', 'Street signs always override the map.'));
    parkingBody.appendChild(hint);
  }
  if (borough && borough.charges) parkingBody.appendChild(renderParkingCharges(borough));
}

function parkingRow(parent, label, value) {
  if (!value) return;
  var r = pkEl('div', 'pk-row');
  r.appendChild(pkEl('span', 'pk-row-label', label));
  r.appendChild(pkEl('span', 'pk-row-value', value));
  parent.appendChild(r);
}

// A card's title, subtitle and close button.
function parkingCardHead(title, sub) {
  var head = pkEl('div', 'pk-card-head');
  var titles = pkEl('div', 'pk-card-titles');
  titles.appendChild(pkEl('div', 'pk-card-title', title));
  titles.appendChild(pkEl('div', 'pk-card-sub', sub));
  head.appendChild(titles);
  var close = pkEl('button', 'pk-card-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close card');
  close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  close.addEventListener('click', function() { setParkingSel(null); });
  head.appendChild(close);
  return head;
}

function renderParkingCard(sel) {
  var borough = parkingRules.boroughs[sel.b] || {};
  if (sel.kind === 'borough') return renderBoroughCard(sel, borough);
  var rule = parkingRule(sel.rule) || {};
  var zoneRule = parkingRule(sel.b + ':' + sel.zone) || {};
  var special = rule.streets ? rule : null;
  var card = pkEl('div', 'pk-card');

  var sub = (sel.kind === 'zone' ? 'Controlled parking zone' : 'Zone ' + sel.zone + (special ? ' · ' + special.name : ''))
    + (borough.name ? ' · ' + borough.name : '');
  card.appendChild(parkingCardHead(sel.kind === 'zone' ? 'Zone ' + sel.zone : (sel.name || 'Unnamed street'), sub));

  if (sel.tfl) {
    card.appendChild(pkEl('div', 'pk-pill pk-pill--tfl', 'TfL red route'));
    card.appendChild(pkEl('p', 'pk-note', 'TfL red route: red route signs apply, not zone times.'));
  } else {
    var status = parkingStatus(sel.rule);
    card.appendChild(pkEl('div', 'pk-pill pk-pill--' + status, PARKING_PILLS[status] + ' ' + parkingWhenLabel()));
    var usingEvent = parkingEvent && rule.event;
    parkingRow(card, usingEvent ? 'Event-day hours' : 'Hours', usingEvent ? rule.event.hours : rule.hours);
    if (rule.event && !usingEvent) parkingRow(card, 'Event days', rule.event.hours.replace(/^Event days: /, ''));
    if (rule.event && usingEvent) parkingRow(card, 'Other days', rule.hours);
    if (status === 'unknown') {
      var u = pkEl('p', 'pk-note');
      u.appendChild(document.createTextNode('This map couldn’t turn the council’s hours into a colour, so check the signs' + (borough.hoursUrl ? ' or ' : '.')));
      if (borough.hoursUrl) { u.appendChild(pkLink('the council’s parking page', borough.hoursUrl)); u.appendChild(document.createTextNode('.')); }
      card.appendChild(u);
    }
    parkingRow(card, 'Max stay', (usingEvent ? rule.event.maxStay : rule.maxStay) || (rule.periods ? 'No limit listed' : ''));
    if (special) parkingRow(card, 'Rest of zone ' + sel.zone, zoneRule.hours);
    if (rule.note) card.appendChild(pkEl('p', 'pk-note', rule.note));
    if (rule.event && borough.eventDaysUrl) {
      var ev = pkEl('p', 'pk-small');
      ev.appendChild(document.createTextNode('Event days are set by the council. '));
      ev.appendChild(pkLink('List of event days', borough.eventDaysUrl));
      card.appendChild(ev);
    }
    if (sel.kind === 'zone') {
      Object.keys(parkingRules.rules).forEach(function(k) {
        var r = parkingRules.rules[k];
        if (r.borough === sel.b && r.zone === sel.zone && r.streets) parkingRow(card, r.name, r.hours);
      });
    }
    var yellow = borough.yellowLines || PARKING_YELLOW;
    var yl = pkEl('div', 'pk-yellow');
    var single = pkEl('p', '');
    single.appendChild(pkEl('b', '', 'Single yellow: '));
    single.appendChild(document.createTextNode(yellow.single + (rule.periods && rule.hours ? ' Here: ' + rule.hours.split('. ')[0].split(': ')[0].replace(/\.$/, '') + '.' : '')));
    var dbl = pkEl('p', '');
    dbl.appendChild(pkEl('b', '', 'Double yellow: '));
    dbl.appendChild(document.createTextNode(yellow.double));
    yl.appendChild(single);
    yl.appendChild(dbl);
    if (yellow.loading) yl.appendChild(pkEl('p', 'pk-small', yellow.loading));
    card.appendChild(yl);
  }

  card.appendChild(pkEl('div', 'pk-section', 'Ticket machines within 150 m'));
  var detail = parkingDetail[sel.b];
  var near = nearestMachines(sel.b, sel.lngLat, 5, 150);
  if (near.length) {
    var list = pkEl('ul', 'pk-machines');
    near.forEach(function(m) {
      var li = pkEl('li', '');
      li.appendChild(pkEl('span', 'pk-m-dot pk-m-' + m.p.type.replace(/\W+/g, '').toLowerCase()));
      li.appendChild(pkEl('span', 'pk-m-id', m.p.id));
      li.appendChild(pkEl('span', 'pk-m-type', m.p.type === 'Unknown' ? 'Payment type unknown' : m.p.type));
      li.appendChild(pkEl('span', 'pk-m-dist', Math.round(m.d) + ' m'));
      list.appendChild(li);
    });
    card.appendChild(list);
  } else {
    card.appendChild(pkEl('p', 'pk-small', detail === 'loading' ? 'Loading…' : 'None mapped nearby. Most councils also take payment by phone.'));
  }
  if (sel.kind === 'zone') {
    var counts = {};
    parkingMachines(sel.b).forEach(function(f) {
      if (f.properties.zone === sel.zone) counts[f.properties.type] = (counts[f.properties.type] || 0) + 1;
    });
    var total = Object.keys(counts).reduce(function(n, k) { return n + counts[k]; }, 0);
    parkingRow(card, 'Machines mapped in zone', total
      ? Object.keys(counts).sort().map(function(k) { return counts[k] + ' ' + (k === 'Unknown' ? 'payment type unknown' : k.toLowerCase()); }).join(', ')
      : 'None');
  }
  card.appendChild(pkEl('p', 'pk-small', 'The map shows only the machines in OpenStreetMap, so most are missing.'));

  var pdf = zoneRule.pdf || rule.pdf;
  if (pdf) card.appendChild(pkLink('Zone ' + sel.zone + ' map (council PDF)', pdf)).className = 'pk-pdf';
  else if (zoneRule.url || rule.url) card.appendChild(pkLink('Zone ' + sel.zone + ' on the council site', zoneRule.url || rule.url)).className = 'pk-pdf';
  else if (borough.hoursUrl) card.appendChild(pkLink(borough.name + ' parking zones (council site)', borough.hoursUrl)).className = 'pk-pdf';
  if (borough.checked) card.appendChild(pkEl('p', 'pk-small', 'Hours checked against the council on ' + borough.checked + '.'));
  card.appendChild(pkEl('p', 'pk-signs', 'Street signs always override the map.'));
  return card;
}

// A borough with no zone boundaries: its council's zone list, each with a status pill.
function renderBoroughCard(sel, borough) {
  var card = pkEl('div', 'pk-card');
  card.appendChild(parkingCardHead(borough.name, borough.partial ? 'Not every zone is drawn' : 'No zone boundaries published'));
  if (borough.notes) card.appendChild(pkEl('p', 'pk-note', borough.notes));
  var keys = Object.keys(parkingRules.rules).filter(function(k) { return parkingRules.rules[k].borough === sel.b; })
    .sort(function(a, b) { return parkingRules.rules[a].zone.localeCompare(parkingRules.rules[b].zone, 'en', { numeric: true }); });
  if (keys.length) {
    card.appendChild(pkEl('div', 'pk-section', keys.length + ' zones ' + parkingWhenLabel()));
    var list = pkEl('ul', 'pk-zone-list');
    keys.forEach(function(k) {
      var r = parkingRules.rules[k];
      var status = parkingStatus(k);
      var li = pkEl('li', '');
      var top = pkEl('div', 'pk-zone-top');
      top.appendChild(pkEl('span', 'pk-mini-pill pk-pill--' + status, PARKING_PILLS[status]));
      top.appendChild(pkEl('span', 'pk-zone-code', r.zone));
      if (r.name && r.name !== r.zone) top.appendChild(pkEl('span', 'pk-zone-name', r.name));
      li.appendChild(top);
      var hours = pkEl('div', 'pk-small', r.hours);
      if (r.url) { hours.appendChild(document.createTextNode(' ')); hours.appendChild(pkLink('Council page', r.url)); }
      li.appendChild(hours);
      list.appendChild(li);
    });
    card.appendChild(list);
  }
  if (borough.hoursUrl) card.appendChild(pkLink(borough.name + ' parking zones (council site)', borough.hoursUrl)).className = 'pk-pdf';
  if (borough.checked) card.appendChild(pkEl('p', 'pk-small', 'Checked against the council on ' + borough.checked + '.'));
  card.appendChild(pkEl('p', 'pk-signs', 'Street signs always override the map.'));
  return card;
}

function renderParkingCharges(borough) {
  var c = borough.charges;
  var box = pkEl('details', 'pk-charges');
  if (parkingCalc.open) box.open = true;
  box.addEventListener('toggle', function() { parkingCalc.open = box.open; });
  box.appendChild(pkEl('summary', '', 'Charges · ' + borough.name));
  if (!c.bands || !c.bands.length) {
    if (c.note) box.appendChild(pkEl('p', 'pk-small', c.note));
    if (c.url) box.appendChild(pkLink('Council parking charges', c.url)).className = 'pk-pdf';
    return box;
  }
  var band = c.bands.filter(function(b) { return b.band === parkingCalc.band; })[0] || c.bands[Math.min(2, c.bands.length - 1)];
  var surchargeName = c.surchargeName || 'Diesel';
  var table = pkEl('table', 'pk-bands');
  var thead = pkEl('tr', '');
  ['Band', c.bandLabel || 'CO2', 'Per hour'].forEach(function(h) { thead.appendChild(pkEl('th', '', h)); });
  table.appendChild(thead);
  c.bands.forEach(function(b) {
    var tr = pkEl('tr', b === band ? 'is-on' : '');
    tr.appendChild(pkEl('td', '', String(b.band)));
    tr.appendChild(pkEl('td', '', b.co2 || b.label || ''));
    tr.appendChild(pkEl('td', '', '£' + (b.perHour + (parkingCalc.surcharge && c.dieselPerHour ? c.dieselPerHour : 0)).toFixed(2)));
    tr.addEventListener('click', function() { parkingCalc.band = b.band; renderParkingBody(); });
    table.appendChild(tr);
  });
  box.appendChild(table);

  if (c.dieselPerHour) {
    var surcharge = pkEl('label', 'pk-diesel');
    var cb = pkEl('input', '');
    cb.type = 'checkbox';
    cb.checked = parkingCalc.surcharge;
    cb.addEventListener('change', function() { parkingCalc.surcharge = cb.checked; renderParkingBody(); });
    surcharge.appendChild(cb);
    surcharge.appendChild(document.createTextNode(' ' + surchargeName + ' (+£' + c.dieselPerHour.toFixed(2) + ' an hour)'));
    box.appendChild(surcharge);
  }

  var calc = pkEl('div', 'pk-calc');
  calc.appendChild(pkEl('span', '', 'Band ' + band.band + ' for'));
  var stay = pkEl('select', 'parking-day');
  stay.setAttribute('aria-label', 'How long');
  PARKING_STAYS.forEach(function(m) {
    var o = pkEl('option', '', m < 60 ? m + ' min' : (m / 60) + (m === 60 ? ' hour' : ' hours'));
    o.value = String(m);
    if (m === parkingCalc.minutes) o.selected = true;
    stay.appendChild(o);
  });
  stay.addEventListener('change', function() { parkingCalc.minutes = Number(stay.value); renderParkingBody(); });
  calc.appendChild(stay);
  calc.appendChild(pkEl('span', 'pk-cost', '£' + parkingCost(band.perHour, parkingCalc.minutes, parkingCalc.surcharge, c.dieselPerHour || 0).toFixed(2)));
  box.appendChild(calc);
  var max = parkingSel && !parkingSel.tfl && (parkingRule(parkingSel.rule) || {}).maxStay;
  if (max) box.appendChild(pkEl('p', 'pk-small', 'Max stay here: ' + max + '.'));
  if (c.note) box.appendChild(pkEl('p', 'pk-small', c.note + ' Tap a band to use it.'));
  if (borough.bankHolidayUrl) {
    var bh = pkEl('p', 'pk-small');
    bh.appendChild(pkLink('Bank holidays', borough.bankHolidayUrl));
    bh.appendChild(document.createTextNode(': see the council’s rules.'));
    box.appendChild(bh);
  }
  return box;
}

// Load borough detail as the map moves; the hint and borough name follow the view.
map.on('moveend', function(e) {
  if (!parkingOn || !parkingRules) return;
  loadParkingDetail();
  if (e && e.originalEvent) parkingNote = '';   // the user moved the map themselves: the note has been seen
  if (!parkingSel) renderParkingBody();
});
/* ===== END PARKING ===== */

function setStatus(msg, isError) {
  var el = document.getElementById('st');
  if (el) {
    el.textContent = msg;
    el.className = 'travel-card-title' + (isError ? ' error' : '');
  }
  var pcEl = document.getElementById('pc-st');
  if (pcEl && postcodeChipVisible) {
    pcEl.textContent = msg;
  }
}

/* ===== SHARE / PERMALINK ===== */
// Encodes the active travel view in location.hash so it can be copied/shared,
// and restores that view on load. Hash scheme: #p=<lat>,<lng>&m=<mode>&b=<bucket>&q=<label>

// Last-view persistence. iOS Safari does not reliably restore a history.replaceState
// fragment when it relaunches a purged tab, so we also mirror the active view into
// localStorage and restore from it on cold start when the hash is absent.
var LAST_VIEW_KEY = 'ldnmap:lastView';

// Snapshot of the active travel view, or null when not in a shareable state.
function currentViewState() {
  if (appState !== 'travel' || !center) return null;
  return {
    lat: center[1], lng: center[0],
    mode: mode || 'walking',
    bucket: (selectedMin !== null && selectedMin !== undefined) ? selectedMin : null,
    name: (pendingPlace && pendingPlace.name) ? pendingPlace.name : ''
  };
}

function updatePermalink() {
  var s = currentViewState();
  if (!s) return;
  try {
    var parts = ['p=' + s.lat.toFixed(5) + ',' + s.lng.toFixed(5)];
    parts.push('m=' + s.mode);
    if (s.bucket !== null) parts.push('b=' + s.bucket);
    if (s.name) parts.push('q=' + encodeURIComponent(s.name));
    history.replaceState(null, '', location.pathname + location.search + '#' + parts.join('&'));
  } catch (e) {}
  try { localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ v: s, ts: Date.now() })); } catch (e) {}
}

function clearPermalink() {
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  try { localStorage.removeItem(LAST_VIEW_KEY); } catch (e) {}
}

function parsePermalink() {
  var hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  var out = {};
  hash.split('&').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  });
  if (!out.p) return null;
  var coords = out.p.split(',');
  var lat = parseFloat(coords[0]);
  var lng = parseFloat(coords[1]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  var mode = (out.m === 'walking' || out.m === 'cycling' || out.m === 'driving') ? out.m : 'walking';
  var bucket = out.b !== undefined ? parseInt(out.b, 10) : null;
  if (bucket !== null && MINS.indexOf(bucket) === -1) bucket = null;
  var name = '';
  if (out.q) { try { name = decodeURIComponent(out.q); } catch (e) { name = out.q; } }
  return { lat: lat, lng: lng, mode: mode, bucket: bucket, name: name };
}

// Read the persisted last view from localStorage (used when no hash is present,
// e.g. after iOS Safari relaunches a purged tab). Returns the same shape as parsePermalink.
function readLastView() {
  try {
    var raw = localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    var entry = JSON.parse(raw);
    if (!entry || !entry.v || (Date.now() - entry.ts) > CACHE_TTL) return null;
    var v = entry.v;
    if (!isFinite(v.lat) || !isFinite(v.lng)) return null;
    var mode = (v.mode === 'walking' || v.mode === 'cycling' || v.mode === 'driving') ? v.mode : 'walking';
    var bucket = (v.bucket !== null && v.bucket !== undefined && MINS.indexOf(v.bucket) !== -1) ? v.bucket : null;
    return { lat: v.lat, lng: v.lng, mode: mode, bucket: bucket, name: v.name || '' };
  } catch (e) { return null; }
}

function restoreFromPermalink() {
  try {
    var p = parsePermalink() || readLastView();
    if (!p) return;
    mode = p.mode;
    updateModeButtons();
    pendingPlace = { lng: p.lng, lat: p.lat, name: p.name, address: '', postcode: null };
    placeMarker(p.lat, p.lng);
    setState('travel');
    run(p.lng, p.lat, p.name).then(function() {
      if (p.bucket !== null && selectedMin !== p.bucket) selectBucket(p.bucket);
    });
  } catch (e) {}
}

function shareLink() {
  updatePermalink();
  copyText(location.href, function() {
    flashCopied(document.getElementById('share-btn'), 'share-btn--copied');
  });
}

// Copy text, then call done(). Where the clipboard API is missing (an http page, an older
// browser) or refuses, a hidden textarea and execCommand do the job.
function copyText(text, done) {
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    done();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

// Tint a button for a moment to confirm the copy.
function flashCopied(btn, cls) {
  btn.classList.add(cls);
  setTimeout(function() { btn.classList.remove(cls); }, 1800);
}

// Startup restore — run once after the map and all functions are ready.
whenStyleReady(function() { restoreFromPermalink(); });
/* ===== end permalink ===== */

/* ===== DRAGGABLE BOTTOM SHEET (mobile snap points) ===== */
/* Apple/Google-Maps-style sheet: peek (grabber + title), compact, half (~50%), full (~92%).
   Mobile only (<=768px). On desktop the cards keep their original CSS, so we never
   touch inline transform there. Used by the travel card and the fuel price panel. */
function makeSnapSheet(opts) {
  var card = document.getElementById(opts.card);
  var grabber = document.getElementById(opts.grabber);
  if (!card || !grabber) return null;
  var header = card.querySelector(opts.header);
  var snaps = { full: 0, half: 0, compact: 0, peek: 0 };
  var current = opts.initial || 'compact';
  var curT = 0;                 // current translateY in px
  var dragging = false, startY = 0, startT = 0, moved = false, suppressClick = false;

  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function vh() { return (window.visualViewport && window.visualViewport.height) || window.innerHeight; }

  function compute() {
    var H = card.offsetHeight;
    var peekVisible = (header ? header.offsetHeight : 52) + grabber.offsetHeight + 8;
    // Compact = show everything down through opts.compact (measured, so it's exact
    // and independent of whether the list below has loaded yet).
    var compactEl = opts.compact ? card.querySelector(opts.compact) : null;
    var compactVisible = compactEl ? (compactEl.offsetTop + compactEl.offsetHeight + 16) : (peekVisible + 110);
    snaps.full = 0;                                  // top of sheet near top of screen
    snaps.half = Math.max(0, H - vh() * 0.5);        // header sits at ~50%
    snaps.compact = Math.max(0, H - compactVisible);
    snaps.peek = Math.max(0, H - peekVisible);       // only grabber + header visible
  }

  function setT(t, animate) {
    curT = t;
    if (animate) {
      card.classList.remove('no-anim');
      card.style.transform = 'translateY(' + t + 'px)';
    } else {
      card.classList.add('no-anim');
      card.style.transform = 'translateY(' + t + 'px)';
      void card.offsetWidth;                         // flush, so the next change can animate
      card.classList.remove('no-anim');
    }
  }

  function applySnap(name, animate) {
    current = name;
    compute();
    setT(snaps[name], animate);
    if (opts.onSnap) opts.onSnap(name);
  }

  function hide(animate) {
    setT(card.offsetHeight + 40, animate);           // fully below the viewport
  }

  function nearest(t) {
    var arr = [['full', snaps.full], ['half', snaps.half], ['compact', snaps.compact], ['peek', snaps.peek]];
    var best = arr[0], bd = Math.abs(t - arr[0][1]);
    for (var i = 1; i < arr.length; i++) {
      var d = Math.abs(t - arr[i][1]);
      if (d < bd) { bd = d; best = arr[i]; }
    }
    return best[0];
  }

  function onStart(e) {
    if (!isMobile()) return;
    dragging = true; moved = false;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startT = curT;
    card.classList.add('no-anim');
  }
  function onMove(e) {
    if (!dragging) return;
    var y = e.touches ? e.touches[0].clientY : e.clientY;
    var dy = y - startY;
    if (!moved && Math.abs(dy) > 5) moved = true;
    if (!moved) return;
    if (e.cancelable) e.preventDefault();            // stop page from scrolling/refresh
    var t = Math.max(snaps.full, Math.min(snaps.peek, startT + dy));
    curT = t;
    card.style.transform = 'translateY(' + t + 'px)';
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('no-anim');
    if (!moved) return;                              // a tap — let the click through
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 350);
    applySnap(nearest(curT), true);
  }

  var dragEls = [grabber, header];
  for (var i = 0; i < dragEls.length; i++) {
    if (!dragEls[i]) continue;
    dragEls[i].addEventListener('touchstart', onStart, { passive: true });
    dragEls[i].addEventListener('touchmove', onMove, { passive: false });
    dragEls[i].addEventListener('touchend', onEnd);
    dragEls[i].addEventListener('touchcancel', onEnd);
  }
  // Tap the grabber to step up through the snaps: peek -> compact -> half -> full.
  // From full, wrap back to compact (a tap never collapses all the way to peek).
  grabber.addEventListener('click', function () {
    if (!isMobile() || suppressClick) return;
    var order = ['peek', 'compact', 'half', 'full'];
    var idx = order.indexOf(current);
    var next = (idx < 0 || idx >= order.length - 1) ? 'compact' : order[idx + 1];
    applySnap(next, true);
  });
  // Keep the active snap correct across rotation / viewport changes.
  window.addEventListener('resize', function () {
    if (isMobile() && opts.isOpen()) applySnap(current, false);
    else if (!isMobile()) card.style.transform = '';
  });

  if (isMobile()) hide(false);                       // start parked below the viewport

  return {
    open: function (snap) {
      if (!isMobile()) { card.style.transform = ''; return; }
      applySnap(snap || opts.initial || 'compact', true);
    },
    close: function () {
      if (!isMobile()) { card.style.transform = ''; return; }
      hide(true);
    },
    snap: function (name) { if (isMobile()) applySnap(name, true); },
    snapName: function () { return current; },
    // Pixels of the sheet showing above the bottom of the screen at a snap.
    visibleAt: function (name) { compute(); return card.offsetHeight - snaps[name]; }
  };
}

// The travel card opens showing the time toggles, map dominant.
window.__sheet = makeSnapSheet({
  card: 'travel-card', grabber: 'sheet-grabber', header: '.travel-card-header',
  compact: '.travel-slots', initial: 'compact',
  isOpen: function () { return document.body.dataset.state === 'travel'; }
});

// The fuel panel opens at half height so the pins show above it.
window.__fuelSheet = makeSnapSheet({
  card: 'fuel-panel', grabber: 'fuel-grabber', header: '.fuel-header',
  compact: '.fuel-types', initial: 'half',
  isOpen: function () { return fuelPanel.classList.contains('open'); }
});

// The parking panel opens showing the time controls and legend, so the colours show above it.
window.__parkingSheet = makeSnapSheet({
  card: 'parking-panel', grabber: 'parking-grabber', header: '.fuel-header',
  compact: '.parking-legend', initial: 'compact',
  isOpen: function () { return parkingPanel.classList.contains('open'); }
});
/* ===== END DRAGGABLE BOTTOM SHEET ===== */
