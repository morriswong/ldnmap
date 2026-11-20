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
  document.getElementById('postcode-park-btn').disabled = false;
  if (pendingPlace) cczCheckPlace(pendingPlace.lng, pendingPlace.lat); // [ccz]
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
  syncParkingColors();   // [parking] before setStyle, so rehydrateLayers() draws with the new theme's set
  syncCczColors();       // [ccz] likewise
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
  if (cczOn) addCczLayers(); // [ccz]
  var saved = isoLayers;
  isoLayers = [];
  saved.forEach(function(l) { addIsoLayer(l.data); });
  if (selectedMin !== null) updateIsoHighlight();

  if (postcodeLayer) addPostcodeLayers(postcodeLayer);

  if (stationsData) addStationsLayer(stationsData); // [stations]
  if (fuelData) addFuelLayer(fuelData); // [fuel]
  if (parkingOn) addParkingLayers(); // [parking]
  if (parkData) addParkResultsLayers(); // [park] its zone outlines and streets, after the parking layers so they draw over them
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
  document.getElementById('postcode-park-btn').disabled = !pendingPlace.lat;
  document.getElementById('postcode-chip').classList.add('postcode-chip-active');
  postcodeChipVisible = true;
}

function hidePostcodeChip() {
  postcodeSeq++;   // a boundary still loading is no longer wanted
  closeParkNear(); // [park] it belongs to the card's place
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
  closeParkNear(); // [park] it was for the previous place
  pendingPlace = place;
  map.flyTo({ center: [place.lng, place.lat], zoom: 12, duration: 1000 });
  placeMarker(place.lat, place.lng);
  cczCheckPlace(place.lng, place.lat); // [ccz]
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
  closeParkNear(); // [park]
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
  if (parkPlace) closeParkNear();       // [park] the panels share a spot
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
// can be unit-tested. The P map button turns it on; the
// panel's close button turns it off. Below street level a tap zooms in; at street level
// it opens a card.
var PARKING_URL = '/data/parking/';
var PARKING_ATTRIB = 'Parking data: London borough councils; streets © OpenStreetMap contributors';
var PARKING_STREET_ZOOM = 15;
var PARKING_DETAIL_ZOOM = 14.5;                        // start loading a borough's streets a little early
// Red means only "you can't park here" (TfL red routes); paying is the blue of UK parking
// signs; permit-only is magenta, well away from that blue. Each theme has its own shades so the
// lines keep their contrast on the beige light map and the near-black dark one. The .pk-dot
// swatches in style.css (--pk-*) match. PARKING_COLORS holds the current theme's set and is
// refilled in place by syncParkingColors() when the theme changes.
var PARKING_PALETTES = {
  light: { ctrl: '#1d4ed8', free: '#15803d', permit: '#a21caf', unknown: '#6b7280', tfl: '#dc2626' },
  dark:  { ctrl: '#60a5fa', free: '#4ade80', permit: '#e879f9', unknown: '#9ca3af', tfl: '#f87171' }
};
var PARKING_COLORS = {};
function syncParkingColors() {
  var p = PARKING_PALETTES[isDark ? 'dark' : 'light'];
  Object.keys(p).forEach(function(k) { PARKING_COLORS[k] = p[k]; });
  // Park near here's copies (declared further down; undefined on the first call).
  if (typeof PARK_STATE_COLORS === 'object') {
    PARK_STATE_COLORS.free = p.free; PARK_STATE_COLORS.paid = p.ctrl; PARK_STATE_COLORS.unknown = p.unknown;
  }
  if (typeof PARK_SEG_COLORS === 'object') {
    PARK_SEG_COLORS.free = p.free; PARK_SEG_COLORS.ctrl = p.ctrl; PARK_SEG_COLORS.permit = p.permit; PARK_SEG_COLORS.unknown = p.unknown;
  }
}
syncParkingColors();
var PARKING_PILLS = { ctrl: 'Pay to park', free: 'Free', permit: 'Permit holders only', unknown: 'Hours unknown' };
var PARKING_NEXT = { ctrl: 'pay to park', free: 'free', permit: 'permit holders only' };
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
var parkingNow = true;         // follow the clock, or a day/time picked in the panel
var parkingWhen = londonDayTime(new Date());
var parkingEvent = false;
var parkingBH = false;          // false, true (ticked by hand) or today's 'MM-DD' when following the clock on a bank holiday
var parkingSel = null;         // the open card: { kind: 'zone'|'street', b, zone, rule, name, tfl, lngLat }
var parkingTimer = null;

var parkingPanel = document.getElementById('parking-panel');
var parkingBody = document.getElementById('parking-body');
var parkingArea = document.getElementById('parking-area');
var parkingDay = document.getElementById('parking-day');
var parkingTime = document.getElementById('parking-time');
var parkingNowBtn = document.getElementById('parking-now');
var parkingEventBox = document.getElementById('parking-event');
var parkingBHBox = document.getElementById('parking-bh');
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
    loadParkingBorough(id).catch(function() {});
  });
}

// One borough's streets, kerbs and machines, fetched once: callers share the load in flight,
// and a failed one can be tried again. Park near here uses it too.
var parkingDetailLoads = {};   // borough id → the promise of its load
function loadParkingBorough(id) {
  var d = parkingDetail[id];
  if (d && d !== 'loading') return Promise.resolve(d);
  if (parkingDetailLoads[id]) return parkingDetailLoads[id];
  parkingDetail[id] = 'loading';
  parkingDetailLoads[id] = Promise.all(['streets', 'kerb', 'machines'].map(function(n) { return parkingGet(id + '/' + n + '.geojson'); }))
    .then(function(d) {
      delete parkingDetailLoads[id];
      parkingDetail[id] = { streets: d[0].features, kerb: splitKerbSides(d[1].features), machines: d[2].features };
      refreshParkingDetailSources();
      if (parkingSel && parkingSel.b === id) renderParkingBody();   // its card was waiting for the machines
      return parkingDetail[id];
    }, function(e) {
      delete parkingDetailLoads[id];
      delete parkingDetail[id];
      throw e;
    });
  return parkingDetailLoads[id];
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
  if (parkPlace) {                      // [park] its view rides on the layer: it goes first
    closeParkNear();
    if (!on && !parkingOn) return;
  }
  if (on === parkingOn) { if (on) openParkingPanel(); return; }
  parkingOn = on;
  document.getElementById('parking-ctrl').setAttribute('aria-pressed', on ? 'true' : 'false');
  if (!on) {
    closeParkingPanel();
    removeParkingLayers();
    parkingSel = null;
    clearInterval(parkingTimer);
    return;
  }
  if (fuelPanel.classList.contains('open')) closeFuel();
  openParkingPanel();
  parkingMessage('pending', 'Loading parking zones');
  loadParkingData().then(function() {
    if (!parkingOn) return;
    if (parkingNow) followParkingClock();
    syncParkingWhen();
    addParkingLayers();
    loadParkingDetail();
    renderParkingBody();
    clearInterval(parkingTimer);
    parkingTimer = setInterval(function() {
      if (!parkingNow) return;
      if (!followParkingClock()) return;
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

/* --- time controls --- */
// Set the day, time and bank holiday from the clock; true when anything changed.
function followParkingClock() {
  var now = new Date();
  var w = londonDayTime(now), bh = bankHolidayOn(now);
  if (w.day === parkingWhen.day && w.minutes === parkingWhen.minutes && bh === parkingBH) return false;
  parkingWhen = w;
  parkingBH = bh;
  return true;
}

function syncParkingWhen() {
  parkingDay.value = String(parkingWhen.day);
  var h = Math.floor(parkingWhen.minutes / 60), m = parkingWhen.minutes % 60;
  parkingTime.value = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  parkingNowBtn.setAttribute('aria-pressed', parkingNow ? 'true' : 'false');
  parkingEventBox.checked = parkingEvent;
  parkingBHBox.checked = !!parkingBH;
}

function onParkingWhenChange() {
  var t = parkingTime.value ? hhmmToMinutes(parkingTime.value) : parkingWhen.minutes;
  var day = Number(parkingDay.value);
  if (typeof parkingBH === 'string' && day !== parkingWhen.day) parkingBH = false;   // today's holiday, not the picked day's
  parkingWhen = { day: day, minutes: t };
  parkingNow = false;
  syncParkingWhen();
  recolourParking();
}
parkingDay.addEventListener('change', onParkingWhenChange);
parkingTime.addEventListener('change', onParkingWhenChange);
parkingNowBtn.addEventListener('click', function() {
  parkingNow = true;
  followParkingClock();
  syncParkingWhen();
  recolourParking();
});
parkingBHBox.addEventListener('change', function() {
  // A "what if": stop following the clock, which would reset it.
  parkingBH = parkingBHBox.checked;
  parkingNow = false;
  syncParkingWhen();
  recolourParking();
});
parkingEventBox.addEventListener('change', function() {
  parkingEvent = parkingEventBox.checked;
  recolourParking();
});

function parkingStatus(rule) {
  return isControlled(rule, parkingWhen.day, parkingWhen.minutes, parkingEvent, parkingBH);
}

// 'Controlled now' or 'Controlled at Sat 10:00'.
function parkingWhenLabel() {
  var bh = parkingBH ? ' (bank holiday)' : '';
  if (parkingNow) return 'now' + bh;
  return 'at ' + PARKING_DAYS[parkingWhen.day] + ' ' + parkingTime.value + bh;
}

// '10pm', '8:30am', '12pm', 'midnight'.
function parkingClock(minutes) {
  if (minutes === 0) return 'midnight';
  var h = Math.floor(minutes / 60), m = minutes % 60;
  var ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return h + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ap;
}

// '£2.80', '£4'.
function parkingMoney(x) {
  return '£' + (Math.round(x * 100) % 100 ? x.toFixed(2) : String(Math.round(x)));
}

// The hourly price for a rule: its own `price`, else the borough's charges (lowest rate). '' if unknown.
function parkingPriceLabel(rule, borough) {
  if (rule.price && rule.price.perHour != null) return parkingMoney(rule.price.perHour) + '/hour';
  var c = borough.charges;
  if (!c) return '';
  if (c.model === 'flat' && c.perHour != null) return parkingMoney(c.perHour) + '/hour';
  var rates = [];
  if (c.bands) rates = c.bands.map(function(b) { return b.perHour; });
  else if (c.model === 'fuel' && c.byFuel) rates = Object.keys(c.byFuel).map(function(k) { return c.byFuel[k]; });
  rates = rates.filter(function(x) { return typeof x === 'number'; });
  if (!rates.length) return '';
  var lo = Math.min.apply(null, rates), hi = Math.max.apply(null, rates);
  return (lo === hi ? '' : 'from ') + parkingMoney(lo) + '/hour';
}

var PARKING_HOLIDAY_NAMES = { '12-25': 'Christmas Day', '12-26': 'Boxing Day', '01-01': 'New Year’s Day' };

// ', except Christmas Day and Boxing Day' for a rule's free bank holidays; '' if none.
function parkingHolidayExcept(list) {
  var names = (list || []).map(function(d) { return PARKING_HOLIDAY_NAMES[d] || d; });
  if (!names.length) return '';
  return ', except ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]);
}

// A rule's max stay, or the borough's default ('8 hours (council default)'); '' if neither.
function parkingMaxStay(rule, borough, usingEvent) {
  var own = usingEvent ? rule.event.maxStay : rule.maxStay;
  if (own) return own;
  return borough.maxStayDefault ? borough.maxStayDefault + ' (council default)' : '';
}

// The line under a card's pill: 'Up to 2 hours · from £2.80/hour · free from 10pm'.
function parkingHeadline(ruleKey, rule, borough, status, usingEvent) {
  var bits = [];
  if (status === 'ctrl') {
    var max = parkingMaxStay(rule, borough, usingEvent).replace(/ \(council default\)$/, '');
    if (max && max.length <= 16) bits.push('up to ' + max);
    var price = parkingPriceLabel(rule, borough);
    if (price) bits.push(price);
  }
  if (status !== 'unknown') {
    var nx = nextChange(ruleKey, parkingWhen.day, parkingWhen.minutes, parkingEvent, parkingBH);
    if (nx && PARKING_NEXT[nx.status]) {
      bits.push(PARKING_NEXT[nx.status] + ' from ' + (nx.inDays ? PARKING_DAYS[nx.day] + ' ' : '') + parkingClock(nx.minutes));
    }
  }
  var s = bits.join(' · ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
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
        'line-opacity': parkingLineOpacity().zones } }, underLabels);
    map.addLayer({ id: 'parking-streets', type: 'line', source: 'parking-streets', minzoom: PARKING_STREET_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': parkingStreetColor(), 'line-opacity': parkingLineOpacity().streets,
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

// While Park near here's results are on the map (parkData), the general layer steps back so
// the result streets stand out over it; otherwise it's drawn at full strength.
function parkingLineOpacity() {
  return parkData ? { zones: 0.35, streets: 0.3 } : { zones: 0.8, streets: 0.85 };
}
function parkingSetDimmed() {
  var o = parkingLineOpacity();
  if (map.getLayer('parking-zones-line')) map.setPaintProperty('parking-zones-line', 'line-opacity', o.zones);
  if (map.getLayer('parking-streets')) map.setPaintProperty('parking-streets', 'line-opacity', o.streets);
}

// The selected street is outlined: all pieces with its name in its zone.
function parkingSelFilter() {
  if (!parkingSel || parkingSel.kind !== 'street' || !parkingSel.name) return ['==', ['get', 'name'], '\u0000'];
  return ['all', ['==', ['get', 'name'], parkingSel.name], ['==', ['get', 'zone'], parkingSel.zone],
    ['in', ['get', 'rule'], ['literal', Object.keys(parkingRules.rules).filter(function(k) { return k.indexOf(parkingSel.b + ':') === 0; })]]];
}

/* --- taps --- */
map.on('click', function(e) {
  if (!parkingOn || parkPlace || !map.getLayer('parking-zones-fill')) return;   // [park] its own taps
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
    var headline = parkingHeadline(sel.rule, rule, borough, status, usingEvent);
    if (headline) card.appendChild(pkEl('p', 'pk-headline', headline));
    parkingRow(card, usingEvent ? 'Event-day hours' : 'Hours', usingEvent ? rule.event.hours : rule.hours);
    if (rule.event && !usingEvent) parkingRow(card, 'Event days', rule.event.hours.replace(/^Event days: /, ''));
    if (rule.event && usingEvent) parkingRow(card, 'Other days', rule.hours);
    if (status === 'unknown') {
      var u = pkEl('p', 'pk-note');
      u.appendChild(document.createTextNode('This map couldn’t turn the council’s hours into a colour, so check the signs' + (borough.hoursUrl ? ' or ' : '.')));
      if (borough.hoursUrl) { u.appendChild(pkLink('the council’s parking page', borough.hoursUrl)); u.appendChild(document.createTextNode('.')); }
      card.appendChild(u);
    }
    parkingRow(card, 'Max stay', parkingMaxStay(rule, borough, usingEvent) || (rule.periods ? 'No limit listed' : ''));
    var bhPolicy = bankHolidayPolicy(rule);
    if (bhPolicy) parkingRow(card, 'Bank holidays', bhPolicy === 'free' ? 'Free'
      : bhPolicy === 'charged' ? 'Normal hours' + parkingHolidayExcept(rule.bankHolidayExcept)
      : 'Varies: check the signs');
    var pay = rule.payCode || zoneRule.payCode;
    if (pay && pay.code) parkingRow(card, 'Pay by ' + pay.provider, 'Location ' + pay.code);
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
    // Flat rate or by fuel type (as RingGo lists them): a small table, no band picker.
    var rows = [];
    if (c.model === 'flat' && c.perHour != null) rows.push(['Per hour', c.perHour]);
    if (c.model === 'fuel' && c.byFuel) {
      [['electric', 'Electric'], ['petrol', 'Petrol'], ['diesel', 'Diesel'], ['other', 'Other vehicles']].forEach(function(f) {
        if (c.byFuel[f[0]] != null) rows.push([f[1], c.byFuel[f[0]]]);
      });
    }
    var own = parkingSel && !parkingSel.tfl && (parkingRule(parkingSel.rule) || {}).price;
    if (own && own.perHour != null) rows.unshift(['This zone', own.perHour]);
    if (rows.length) {
      var t = pkEl('table', 'pk-bands');
      rows.forEach(function(r) {
        var tr = pkEl('tr', '');
        tr.appendChild(pkEl('td', '', r[0]));
        tr.appendChild(pkEl('td', '', parkingMoney(r[1]) + ' an hour'));
        t.appendChild(tr);
      });
      box.appendChild(t);
    }
    if (c.dieselPerHour) box.appendChild(pkEl('p', 'pk-small', 'Diesel: +' + parkingMoney(c.dieselPerHour) + ' an hour.'));
    if (c.visitorFromPerHour) box.appendChild(pkEl('p', 'pk-small', 'Resident visitor permits from ' + parkingMoney(c.visitorFromPerHour) + ' an hour.'));
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
    bh.appendChild(document.createTextNode(borough.bankHolidays === 'free'
      ? ': pay and display is free in most zones; the card says where it isn’t.'
      : ': see the council’s rules.'));
    box.appendChild(bh);
  }
  return box;
}

// Load borough detail as the map moves; the hint and borough name follow the view.
map.on('moveend', function(e) {
  if (!parkingOn || !parkingRules) return;
  loadParkingDetail();
  if (!parkingSel) renderParkingBody();
});
/* ===== END PARKING ===== */

/* ===== PARK NEAR HERE ===== */
// For drivers: from a place's card, straight to the controlled parking zones within a 20 min walk
// where you can park now and for how long (no stay chosen: stayFromNow() in parking-rules.js;
// permit-only-now rules go), with the hourly rate, nearest or cheapest first. "Change" opens a
// plan (arrival day and time, and how long to stay); with a stay chosen the list is where the
// whole stay is allowed (no permit-only time, no paid stretch over the max stay), with what it
// costs (planStay()). Candidates come from the named, non-red-route pieces of each nearby
// borough's streets.geojson: one row per zone (the streets that follow the zone's own rule), and
// one per "odd" street whose rule differs from its zone's, so nothing is hidden. Walks are
// straight-line estimates, refined for the nearest 24 with one Mapbox Matrix call. The parking
// layer goes on too, set to the arrival time, for context; the listed zones' outlines (the
// `park-zones` source) and odd streets (`park-results`) are drawn over it, and a zone's card
// frames the zone and colours its streets. closeParkNear() is the one way out: it puts the
// parking layer back as it was. Every lookup takes a number from parkSeq.
var PARK_STAYS = [[null, 'Any'], [30, '30m'], [60, '1h'], [120, '2h'], [180, '3h'], [240, '4h'], ['day', 'All day']];
var PARK_REACH_M = 1800;       // boroughs with a zone this close to the place are searched
var PARK_EST_MAX = 25;         // minutes: the straight-line estimate a street must be within
var PARK_WALK_MAX = 20;        // minutes: the walk a listed street must be within
var PARK_MATRIX_MAX = 24;      // streets whose walks are refined (25 coordinates with the place)
var PARK_STATE_COLORS = { free: PARKING_COLORS.free, paid: PARKING_COLORS.ctrl, unknown: PARKING_COLORS.unknown };
var PARK_SEG_COLORS = { free: PARKING_COLORS.free, ctrl: PARKING_COLORS.ctrl, permit: PARKING_COLORS.permit, unknown: PARKING_COLORS.unknown };
var PARK_SEG_WORDS = { free: 'free', ctrl: 'paid', permit: 'permit only', unknown: 'unclear' };
var PARK_LAYERS = ['park-results-sel', 'park-results-line', 'park-results-casing', 'park-zones-line', 'park-zones-fill'];
var parkSeq = 0;               // the newest lookup; closing, editing or a new search moves it on
var parkPlace = null;          // { name, lat, lng } while the view is open, else null
var parkPlan = null;           // { dayIdx, minutes, stay (minutes, 'day', or null for any length), now }
var parkPrevPlan = null;       // the plan of the results the plan screen was opened from (its Back)
var parkView = null;           // 'loading' | 'results' | 'detail' | 'plan' | 'error'
var parkResults = [];          // see parkResult(); `i` on the map features is the index here
var parkInfo = null;           // { arrival, inZone, outline, covered } for the results showing
var parkSort = 'nearest';
var parkSelIdx = -1;
var parkData = null;           // the park-results GeoJSON on the map, or null
var parkZoneData = null;       // the park-zones GeoJSON (the listed zones' outlines), or null
var parkPrevParking = null;    // the parking layer's own day and time, when it was on before
var parkOwnsParking = false;   // true when this view turned the parking layer on
var parkZoneIndex = null;      // zone features with their bounding boxes, built once per load

var parkPanel = document.getElementById('park-panel');
var parkBody = document.getElementById('park-body');
var parkTitle = document.getElementById('park-title');
var parkBackBtn = document.getElementById('park-back');

/* --- the plan: arrival day, time and stay --- */
function parkNowMinutes() { return londonDayTime(new Date()).minutes; }

// Today and the next six days, as London dates (noon UTC is the same London date all year).
function parkDays() {
  var t = londonDate(new Date()).split('-').map(Number);
  var out = [];
  for (var i = 0; i < 7; i++) {
    var date = new Date(Date.UTC(t[0], t[1] - 1, t[2] + i, 12));
    out.push({ date: date, day: date.getUTCDay(), label: i === 0 ? 'Today' : PARKING_DAYS[date.getUTCDay()] });
  }
  return out;
}

// Now, with no stay chosen: where you can park now, and for how long.
function parkDefaultPlan() {
  return { dayIdx: 0, minutes: parkNowMinutes(), stay: null, now: true };
}

// The plan as planStay() and stayFromNow() take it. Bank holidays as the parking panel works them
// out for a date; event days can't be known ahead, so they're never assumed. `any` is true (and
// `stayMin` null) when no stay is chosen; `now` when the arrival is now.
function parkArrival() {
  var d = parkDays()[parkPlan.dayIdx];
  var minutes = parkPlan.minutes, any = parkPlan.stay == null;
  return { day: d.day, minutes: minutes, label: PARKING_DAYS[d.day], dayIdx: parkPlan.dayIdx,
    bh: parkingRules ? bankHolidayOn(d.date) : false, eventDay: false, now: !!parkPlan.now,
    any: any, stay: parkPlan.stay, stayMin: any ? null : parkPlan.stay === 'day' ? 1440 - minutes : parkPlan.stay };
}

// 'Now · any length', 'Fri 3:45pm · 2h', 'Now · all day'.
function parkPlanSummary(a) {
  return (a.now ? 'Now' : a.label + ' ' + parkClock(a.minutes)) + ' · '
    + (a.any ? 'any length' : a.stay === 'day' ? 'all day' : parkDur(a.stayMin));
}

/* --- words --- */
// '5:00pm', 'midnight'.
function parkClock(m) {
  m = ((m % 1440) + 1440) % 1440;
  if (m === 0) return 'midnight';
  var h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? 'am' : 'pm');
}
// '5:00–8:00pm', '11:00am–2:00pm', '5:00pm–midnight'; `short` gives '5–7pm' (parkingClock()).
function parkRange(a, b, short) {
  var fmt = short ? function(m) { return parkingClock(((m % 1440) + 1440) % 1440); } : parkClock;
  var x = fmt(a), y = fmt(b), sx = x.slice(-2);
  if ((sx === 'am' || sx === 'pm') && sx === y.slice(-2)) x = x.slice(0, -2);
  return x + '–' + y;
}
// '30m', '2h', '1h 30m'.
function parkDur(m) {
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60), r = m % 60;
  return h + 'h' + (r ? ' ' + r + 'm' : '');
}
// '30 minutes', '2 hours', '1 hour 30 min'.
function parkDurLong(m) {
  if (m < 60) return m + ' minutes';
  var h = Math.floor(m / 60), r = m % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
}
function parkMoney(x) { return '£' + x.toFixed(2); }
// The time `off` minutes after arrival `a`: '7pm', '8:30am tomorrow', 'Mon 8:30am', 'midnight'.
function parkAt(a, off) {
  var abs = a.minutes + off, days = Math.floor(abs / 1440), m = abs % 1440;
  if (m === 0 && days > 0) { days--; m = 1440; }        // the midnight that ends a day is that day's
  var clock = m === 1440 ? 'midnight' : parkingClock(m);
  if (!days) return clock;
  if (days === 1 && a.dayIdx === 0) return clock + ' tomorrow';
  return PARKING_DAYS[(a.day + days) % 7] + ' ' + clock;
}
// An hourly rate: '£2.32/hr', '£4.78–£10.58/hr', 'from £2.32/hr'; '' when the price isn't known.
function parkRate(t) {
  return t ? parkAmount(t.min, t.max) + '/hr' : '';
}

/* --- geometry --- */
// Metres east and north of `o` ([lng, lat]): flat is near enough at walking distances.
function parkXY(c, o) {
  return [(c[0] - o[0]) * 111320 * Math.cos(o[1] * Math.PI / 180), (c[1] - o[1]) * 110540];
}
// The point of a line closest to `o`, and how far it is in metres: { c: [lng, lat], d }.
function parkNearestOnLine(coords, o) {
  var best = { c: coords[0], d: Infinity };
  for (var i = 0; i < coords.length; i++) {
    var j = Math.min(i + 1, coords.length - 1);
    var a = parkXY(coords[i], o), b = parkXY(coords[j], o);
    var dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    var t = len ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len)) : 0;
    var x = a[0] + t * dx, y = a[1] + t * dy, d = Math.sqrt(x * x + y * y);
    if (d < best.d) {
      best = { d: d, c: [coords[i][0] + t * (coords[j][0] - coords[i][0]), coords[i][1] + t * (coords[j][1] - coords[i][1])] };
    }
  }
  return best;
}
function parkInRing(pt, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function parkPolygons(g) {
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
}
function parkInGeometry(pt, g) {
  return parkPolygons(g).some(function(p) {
    return parkInRing(pt, p[0]) && !p.slice(1).some(function(hole) { return parkInRing(pt, hole); });
  });
}
function parkZones() {
  if (parkZoneIndex && parkZoneIndex.src === parkingData) return parkZoneIndex.list;
  var list = parkingData.zones.features.map(function(f) {
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    parkPolygons(f.geometry).forEach(function(p) {
      p[0].forEach(function(c) {
        if (c[0] < bb[0]) bb[0] = c[0]; if (c[1] < bb[1]) bb[1] = c[1];
        if (c[0] > bb[2]) bb[2] = c[0]; if (c[1] > bb[3]) bb[3] = c[1];
      });
    });
    return { f: f, bb: bb };
  });
  var byRule = {};
  list.forEach(function(z) { if (!z.f.properties.outline) byRule[z.f.properties.rule] = z; });
  parkZoneIndex = { src: parkingData, list: list, byRule: byRule };
  return list;
}
// A zone's polygon and bounding box ({ f, bb }) by its rule key, or null when it has no outline.
function parkZoneEntry(rule) {
  if (!parkingData) return null;
  parkZones();
  return parkZoneIndex.byRule[rule] || null;
}

// Around a place: the boroughs with a zone (or, for boroughs with no zone map, an outline)
// within reach, whether the place is inside a zone (`inRules`: the rule keys of the zones it's in),
// and the outline it's inside, if any.
function parkArea(lng, lat) {
  var dLat = PARK_REACH_M / 110540, dLng = PARK_REACH_M / (111320 * Math.cos(lat * Math.PI / 180));
  var near = {}, inZone = false, outline = null, inRules = {};
  parkZones().forEach(function(z) {
    var bb = z.bb, p = z.f.properties;
    if (lng < bb[0] - dLng || lng > bb[2] + dLng || lat < bb[1] - dLat || lat > bb[3] + dLat) return;
    near[p.b] = true;
    if (lng < bb[0] || lng > bb[2] || lat < bb[1] || lat > bb[3] || !parkInGeometry([lng, lat], z.f.geometry)) return;
    if (p.outline) outline = p.b; else { inZone = true; inRules[p.rule] = true; }
  });
  return { boroughs: Object.keys(near).filter(function(id) { return parkingRules.boroughs[id]; }), inZone: inZone, outline: outline,
    inRules: inRules };
}

/* --- candidates and results --- */
// One candidate per controlled parking zone, and one per "odd" street (a street whose rule isn't
// its zone's: a pay-by-phone strip, a different max stay), in the loaded boroughs. A zone
// (`kind` 'zone', rule `<borough>:<zone>`) takes in every named, non-red-route piece that follows
// the zone's rule: its walk is from the nearest of them (`street`, `point`), or about a minute
// when the place is inside the zone (`inside`, from `inRules`, parkArea()'s). An odd street
// (`kind` 'street') is one per street name and rule, as before, so nothing is hidden.
// Each has an estimated walk and the stay planned under its rule. Permit-only and over-max stays
// go. With no stay chosen, `now` is stayFromNow()'s answer (rules that are permit-only at the
// arrival go) and `plan` covers the time it allows, up to 24 hours (parkWindow()), for the card.
function parkCandidates(ids, o, a, inRules) {
  var groups = {};
  inRules = inRules || {};
  ids.forEach(function(id) {
    var d = parkingDetail[id];
    if (!d || d === 'loading') return;
    d.streets.forEach(function(f) {
      var p = f.properties;
      if (p.tfl || !p.name || !p.rule || !f.geometry || f.geometry.type !== 'LineString') return;
      var zoneRule = p.zone != null && p.rule === id + ':' + p.zone;
      var key = zoneRule ? 'zone|' + p.rule : 'street|' + p.name + '|' + p.rule;
      var g = groups[key] || (groups[key] = { kind: zoneRule ? 'zone' : 'street', name: zoneRule ? 'Zone ' + p.zone : p.name,
        rule: p.rule, zone: p.zone, b: id, d: Infinity, point: null, street: null, lines: [], inside: zoneRule && !!inRules[p.rule] });
      g.lines.push(f.geometry.coordinates);
      var near = parkNearestOnLine(f.geometry.coordinates, o);
      if (near.d < g.d) { g.d = near.d; g.point = near.c; g.street = p.name; }
    });
  });
  var plans = {}, nows = {};
  return Object.keys(groups).map(function(k) { return groups[k]; }).filter(function(g) {
    if (g.inside) g.d = 0;                               // the place is in the zone: about a minute
    g.walk = Math.max(1, Math.ceil(g.d * 1.3 / 80));
    if (g.walk > PARK_EST_MAX) return false;
    if (a.any) {
      var n = nows[g.rule];
      if (!n) {
        n = nows[g.rule] = stayFromNow(g.rule, a.day, a.minutes, a.eventDay, a.bh);
        n.plan = planStay(g.rule, a.day, a.minutes, parkWindow(n), a.eventDay, a.bh);
      }
      if (n.now === 'permit') return false;
      g.now = n;
      g.plan = n.plan;
      return true;
    }
    var plan = plans[g.rule] || (plans[g.rule] = planStay(g.rule, a.day, a.minutes, a.stayMin, a.eventDay, a.bh));
    if (!plan || plan.status === 'permit' || plan.status === 'maxstay') return false;
    g.plan = plan;
    return true;
  });
}

// The minutes from the arrival a card's time bar covers with no stay chosen: until you must leave,
// or 24 hours when that's later or never.
function parkWindow(n) {
  return n.untilMin != null && n.untilMin < 1440 ? n.untilMin : 1440;
}

// Walking times for the nearest candidates from one Matrix call. Any failure keeps the estimates.
// A zone the place is inside keeps its minute.
function parkRefineWalks(cands, o) {
  var best = cands.filter(function(c) { return !c.inside; }).sort(function(a, b) { return a.d - b.d; }).slice(0, PARK_MATRIX_MAX);
  if (!best.length) return Promise.resolve();
  var coords = [o].concat(best.map(function(c) { return c.point; }))
    .map(function(c) { return c[0].toFixed(6) + ',' + c[1].toFixed(6); });
  var url = 'https://api.mapbox.com/directions-matrix/v1/mapbox/walking/' + coords.join(';')
    + '?sources=0&annotations=duration&access_token=' + MAPBOX_TOKEN;
  return fetch(url)
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d) {
      var row = d && d.durations && d.durations[0];
      if (!row) return;
      best.forEach(function(c, i) {
        var s = row[i + 1];
        if (typeof s === 'number' && isFinite(s)) { c.walk = Math.max(1, Math.ceil(s / 60)); c.refined = true; }
      });
    })
    .catch(function() {});
}

// A listed zone or odd street (`kind`, as parkCandidates()): 'free' (nothing to pay), 'paid', or
// 'unknown' (hours couldn't be read).
// `price` is what the stay costs when that's exact (0 when free), else null. `costMin`/`costMax`
// are its lowest and highest cost (a range when it depends on the car; costMax null for a 'from'
// price), both null when the price isn't known. `tariff` is planStay()'s (ruleTariff()).
// With no stay chosen (`now` set), the state is the street's at the arrival, the costs are for
// the time the card covers (parkWindow()), and `rateMin`/`rateMax` are the hourly rate the list
// shows and sorts by (0 when free now; null when unknown).
function parkResult(c) {
  var plan = c.plan, n = c.now || null;
  var num = function(x) { return typeof x === 'number' ? x : null; };
  if (n) {
    var nowState = n.now === 'free' ? 'free' : n.now === 'ctrl' ? 'paid' : 'unknown';
    var known = plan.status !== 'unknown', t = n.tariff || null;
    var cMin = known ? num(plan.costMin) : null;
    return { kind: c.kind, name: c.name, rule: c.rule, zone: c.zone, b: c.b, d: c.d, walk: c.walk, refined: !!c.refined,
      street: c.street, inside: !!c.inside,
      point: c.point, lines: c.lines, plan: plan, now: n, window: parkWindow(n), state: nowState, tariff: t,
      price: known ? num(plan.cost) : null, costMin: cMin, costMax: cMin !== null ? num(plan.costMax) : null,
      rateMin: nowState === 'free' ? 0 : nowState === 'paid' && t ? t.min : null,
      rateMax: nowState === 'free' ? 0 : nowState === 'paid' && t ? t.max : null };
  }
  var state = plan.status === 'unknown' ? 'unknown' : (plan.freeAll || plan.paidMin === 0) ? 'free' : 'paid';
  var paid = state === 'paid', free = state === 'free';
  return { kind: c.kind, name: c.name, rule: c.rule, zone: c.zone, b: c.b, d: c.d, walk: c.walk, refined: !!c.refined,
    street: c.street, inside: !!c.inside,
    point: c.point, lines: c.lines, plan: plan, state: state, tariff: plan.tariff || null,
    price: free ? 0 : paid ? num(plan.cost) : null,
    costMin: free ? 0 : paid ? num(plan.costMin) : null,
    costMax: free ? 0 : paid && num(plan.costMin) !== null ? num(plan.costMax) : null };
}

// Nearest: by walk. Cheapest: free first, then by the lowest cost (a range or 'from' price by its
// bottom; with no stay chosen, the lowest hourly rate now), then by walk; unknown prices after
// known ones. Streets whose hours couldn't be read go last in both.
function parkSorted() {
  var key = function(r) { return r.now ? r.rateMin : r.costMin; };
  return parkResults.map(function(r, i) { return { r: r, i: i }; }).sort(function(x, y) {
    var a = x.r, b = y.r;
    var u = (a.state === 'unknown') - (b.state === 'unknown');
    if (u) return u;
    if (parkSort === 'cheapest') {
      var ka = key(a), kb = key(b);
      var n = (ka === null) - (kb === null);
      if (n) return n;
      if (ka !== null && ka !== kb) return ka - kb;
    }
    return a.walk - b.walk || a.d - b.d || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

// '£4.64', '£9.56–£21.16', or 'from £4.64' (max null) for amounts min..max; '' when min is unknown.
function parkAmount(min, max) {
  if (typeof min !== 'number') return '';
  if (typeof max !== 'number') return 'from ' + parkMoney(min);
  return min === max ? parkMoney(min) : parkMoney(min) + '–' + parkMoney(max);
}

// What a price that isn't exact depends on: 'by car emissions', 'by fuel type'; '' for one price.
function parkBasisWords(t) {
  if (!t || t.exact) return '';
  return t.by === 'fuel' ? 'by fuel type' : 'by car emissions';
}

// A council's charges note cut to its first sentence or two (about `max` characters), never mid-bracket.
function parkShortNote(text, max) {
  max = max || 180;
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  var cut = 0, depth = 0;
  for (var i = 0; i < text.length && i < max; i++) {
    var ch = text.charAt(i);
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if ((ch === '.' || ch === '!' || ch === '?') && depth === 0 && text.charAt(i + 1) === ' ' &&
      !/(^|\s)(e\.g|i\.e|etc|approx|St|Rd|No|Ave)$/.test(text.slice(0, i))) cut = i + 1;
  }
  if (cut) return text.slice(0, cut);
  var sp = text.lastIndexOf(' ', max - 1);
  return text.slice(0, sp > 40 ? sp : max - 1).replace(/[\s,;:(–-]+$/, '') + '…';
}

// A plan's segments, each run of one status as one piece.
function parkSegments(r) {
  var out = [];
  (r.plan.segments || []).forEach(function(s) {
    var last = out[out.length - 1];
    if (last && last.status === s.status && last.end === s.start) last.end = s.end;
    else out.push({ start: s.start, end: s.end, status: s.status });
  });
  if (!out.length) out.push({ start: 0, end: parkSpan(r), status: r.state === 'unknown' ? 'unknown' : r.state === 'free' ? 'free' : 'ctrl' });
  return out;
}

// The small line under a price: 'paid 5–7pm, free after'.
function parkSegLine(r) {
  if (r.state !== 'paid') return '';
  var segs = parkSegments(r), m0 = parkInfo.arrival.minutes;
  if (segs.length < 2) return 'paid all stay';
  return segs.map(function(s, i) {
    var w = PARK_SEG_WORDS[s.status] || s.status;
    return i === segs.length - 1 ? w + ' after' : w + ' ' + parkRange(m0 + s.start, m0 + s.end, true);
  }).join(', ');
}

// 'Zone E · Rushey Green West'.
function parkZoneLine(r) {
  var zr = parkingRule(r.b + ':' + r.zone) || {};
  return 'Zone ' + r.zone + (zr.name && zr.name !== r.zone ? ' · ' + zr.name : '');
}

// A row's title and the line under it. A zone: 'Zone E · Rushey Green West', then where its
// nearest street is (or that the place is in it) and the borough. An odd street: its name, then its zone.
function parkRowTitle(r) {
  return r.kind === 'zone' ? parkZoneLine(r) : r.name;
}
function parkRowSub(r) {
  if (r.kind !== 'zone') return parkZoneLine(r);
  var bn = (parkingRules.boroughs[r.b] || {}).name;
  return (r.inside ? parkPlace.name + ' is in this zone' : 'Nearest: ' + r.street) + (bn ? ' · ' + bn : '');
}
// The odd streets listed in a zone row's zone, in the list's order.
function parkOddStreets(r) {
  return parkSorted().filter(function(x) { return x.r.kind === 'street' && x.r.b === r.b && x.r.zone === r.zone; });
}

// The minutes a street's card covers: the stay, or with none chosen, parkWindow().
function parkSpan(r) {
  return r.now ? r.window : parkInfo.arrival.stayMin;
}

// With no stay chosen, how long you can stay: 'Free until 7pm, then paid until 11pm', 'Up to 4h,
// until 2:15pm', 'Paid until 6:30pm, then free', 'Free until 8:30am tomorrow, then permit holders
// only', 'Free, no time limit'. Times are from parkAt(); within stayFromNow()'s week.
var PARK_LIMIT_WORDS = { permit: 'permit holders only', unknown: 'check the signs' };
function parkStayLine(r) {
  var n = r.now, a = parkInfo.arrival, segs = n.segments;
  var at = function(off) { return parkAt(a, off); };
  if (r.state === 'unknown') return 'Hours couldn’t be read';
  var two = segs.length === 2 && n.limit ? ' until ' + at(n.untilMin) : '';
  if (r.state === 'free') {
    if (segs.length > 1) return 'Free until ' + at(segs[0].end) + ', then paid' + two;
    return n.limit ? 'Free until ' + at(n.untilMin) + ', then ' + PARK_LIMIT_WORDS[n.limit] : 'Free, no time limit';
  }
  if (segs.length > 1) return 'Paid until ' + at(segs[0].end) + ', then free' + two;
  if (n.limit === 'maxstay') return 'Up to ' + parkDur(n.maxStayMin) + ', until ' + at(n.untilMin);
  if (n.limit) return 'Paid until ' + at(n.untilMin) + ', then ' + PARK_LIMIT_WORDS[n.limit];
  return 'No max stay listed';
}

// '4h max · fits 3h', when the max stay is known and the stay has paid time.
function parkFitLine(r) {
  if (r.state === 'unknown') return 'Hours couldn’t be read';
  if (r.plan.maxStayMin == null || !r.plan.paidMin) return '';
  return parkDur(r.plan.maxStayMin) + ' max · fits ' + parkDur(parkInfo.arrival.stayMin);
}

/* --- map --- */
// Every listed row's street pieces, `i` its index in parkResults and `kind` 'zone' or 'street'.
// A zone's streets show only while its card is open (parkShownFilter()); odd streets always.
function parkResultsGeoJSON() {
  var features = [];
  parkResults.forEach(function(r, i) {
    r.lines.forEach(function(line) {
      features.push({ type: 'Feature', properties: { i: i, state: r.state, kind: r.kind }, geometry: { type: 'LineString', coordinates: line } });
    });
  });
  return { type: 'FeatureCollection', features: features };
}

// The listed zones' outlines (zones.geojson's polygons), coloured by their row's state; null with none.
function parkZonesGeoJSON() {
  var features = [];
  parkResults.forEach(function(r, i) {
    var z = r.kind === 'zone' ? parkZoneEntry(r.rule) : null;
    if (z) features.push({ type: 'Feature', properties: { i: i, state: r.state }, geometry: z.f.geometry });
  });
  return features.length ? { type: 'FeatureCollection', features: features } : null;
}

// [west, south, east, north] around a list of [lng, lat] points (or lines' points), extending `bb`.
function parkExtend(bb, pts) {
  bb = bb || [Infinity, Infinity, -Infinity, -Infinity];
  pts.forEach(function(c) {
    if (c[0] < bb[0]) bb[0] = c[0]; if (c[1] < bb[1]) bb[1] = c[1];
    if (c[0] > bb[2]) bb[2] = c[0]; if (c[1] > bb[3]) bb[3] = c[1];
  });
  return bb;
}
// A zone row's extent: its outline, or (a zone with no polygon) its streets.
function parkZoneBounds(r) {
  var z = parkZoneEntry(r.rule);
  if (z) return z.bb.slice();
  var bb = null;
  r.lines.forEach(function(line) { bb = parkExtend(bb, line); });
  return bb;
}
// What the results view frames: the place, every listed zone and every odd street's nearest point.
function parkResultsBounds() {
  var bb = parkExtend(null, [[parkPlace.lng, parkPlace.lat]]);
  parkResults.forEach(function(r) {
    if (r.kind === 'zone') { var z = parkZoneBounds(r); bb = parkExtend(bb, [[z[0], z[1]], [z[2], z[3]]]); }
    else bb = parkExtend(bb, [r.point]);
  });
  return bb;
}

function parkSelFilter() { return ['all', ['==', ['get', 'i'], parkSelIdx], ['==', ['get', 'kind'], 'street']]; }
function parkShownFilter() { return ['any', ['==', ['get', 'kind'], 'street'], ['==', ['get', 'i'], parkSelIdx]]; }
// The open zone stands out: a stronger tint and a thicker line, the others step back.
function parkZoneFillOpacity() {
  return ['case', ['==', ['get', 'i'], parkSelIdx], 0.16, parkSelIdx >= 0 ? 0.03 : 0.07];
}
function parkZoneLineWidth() {
  return ['case', ['==', ['get', 'i'], parkSelIdx], 4.5, 2.5];
}
function parkZoneLineOpacity() {
  return ['case', ['==', ['get', 'i'], parkSelIdx], 1, parkSelIdx >= 0 ? 0.45 : 0.9];
}
function parkStateColor() {
  return ['match', ['get', 'state'], 'free', PARK_STATE_COLORS.free, 'paid', PARK_STATE_COLORS.paid, PARK_STATE_COLORS.unknown];
}

// Point the map's layers at the selected row (parkSelIdx): a street's outline, or a zone's
// streets and its highlighted outline.
function parkApplySel() {
  if (map.getLayer('park-results-casing')) map.setFilter('park-results-casing', parkShownFilter());
  if (map.getLayer('park-results-line')) map.setFilter('park-results-line', parkShownFilter());
  if (map.getLayer('park-results-sel')) map.setFilter('park-results-sel', parkSelFilter());
  if (map.getLayer('park-zones-fill')) map.setPaintProperty('park-zones-fill', 'fill-opacity', parkZoneFillOpacity());
  if (map.getLayer('park-zones-line')) {
    map.setPaintProperty('park-zones-line', 'line-width', parkZoneLineWidth());
    map.setPaintProperty('park-zones-line', 'line-opacity', parkZoneLineOpacity());
  }
}

function addParkResultsLayers() {
  whenStyleReady(function() {
    if (!parkData) return;
    removeParkResultsLayers();
    // The listed zones' outlines in their state's colour, a faint tint under the roads, then the
    // streets: about twice the general layer's street width, on a casing in the map's background
    // colour, with the general layer dimmed underneath (parkingSetDimmed()), so the matches stand out.
    if (parkZoneData) {
      var underRoads = (map.getStyle().layers.filter(function(l) { return l.type === 'symbol'; })[0] || {}).id;
      map.addSource('park-zones', { type: 'geojson', data: parkZoneData });
      map.addLayer({ id: 'park-zones-fill', type: 'fill', source: 'park-zones',
        paint: { 'fill-color': parkStateColor(), 'fill-opacity': parkZoneFillOpacity() } }, underRoads);
      map.addLayer({ id: 'park-zones-line', type: 'line', source: 'park-zones', layout: { 'line-join': 'round' },
        paint: { 'line-color': parkStateColor(), 'line-width': parkZoneLineWidth(), 'line-opacity': parkZoneLineOpacity() } });
    }
    var width = ['interpolate', ['linear'], ['zoom'], 13, 4, 15, 6, 16, 7, 18, 12];
    map.addSource('park-results', { type: 'geojson', data: parkData });
    map.addLayer({ id: 'park-results-casing', type: 'line', source: 'park-results', filter: parkShownFilter(),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': isDark ? '#0a0a0a' : '#ffffff', 'line-opacity': 1,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 8, 15, 10.5, 16, 12, 18, 18] } });
    map.addLayer({ id: 'park-results-line', type: 'line', source: 'park-results', filter: parkShownFilter(),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': parkStateColor(), 'line-width': width } });
    map.addLayer({ id: 'park-results-sel', type: 'line', source: 'park-results', filter: parkSelFilter(),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': isDark ? '#ffffff' : '#111111', 'line-width': 2.5, 'line-gap-width': width } });
    parkingSetDimmed();
  });
}

function removeParkResultsLayers() {
  PARK_LAYERS.forEach(function(id) { if (map.getLayer(id)) map.removeLayer(id); });
  if (map.getSource('park-results')) map.removeSource('park-results');
  if (map.getSource('park-zones')) map.removeSource('park-zones');
  parkingSetDimmed();   // back to full strength once parkData is gone
}

function clearParkResults() {
  parkData = null;
  parkZoneData = null;
  removeParkResultsLayers();
}

// Clear of the panel (desktop) or the sheet at half height (mobile).
function parkMapPadding() {
  if (isMobileView()) {
    var vis = window.__parkSheet ? window.__parkSheet.visibleAt('half') : 360;
    return fitPadding({ top: 60, right: 24, bottom: vis + 20, left: 24 });
  }
  return fitPadding({ top: 60, right: 390, bottom: 60, left: 60 });
}

function parkFitBounds(bb) {
  map.fitBounds(new mapboxgl.LngLatBounds([bb[0], bb[1]], [bb[2], bb[3]]), { padding: parkMapPadding(), maxZoom: 17 });
}

// The place, the listed zones and the odd streets.
function parkFitResults() {
  parkFitBounds(parkResultsBounds());
}

// The parking layer, at the arrival time, for context. Its panel stays shut while this is open.
function parkUseParkingLayer() {
  parkOwnsParking = !parkingOn;
  parkPrevParking = parkingOn ? { now: parkingNow, when: parkingWhen, bh: parkingBH, event: parkingEvent } : null;
  if (parkingOn) {
    closeParkingPanel();
  } else {
    parkingOn = true;
    document.getElementById('parking-ctrl').setAttribute('aria-pressed', 'true');
  }
  loadParkingData().then(function() {
    if (!parkPlace || !parkingOn) return;
    parkSyncParkingTime();
    addParkingLayers();
    loadParkingDetail();
  }).catch(function() {});   // parkFind() says so if the data can't be loaded
}

// Colour the parking layer for the plan's arrival.
function parkSyncParkingTime() {
  if (!parkPlace || !parkPlan || !parkingRules || !parkingOn) return;
  var a = parkArrival();
  parkingNow = false;
  parkingWhen = { day: a.day, minutes: a.minutes };
  parkingBH = a.bh;
  parkingEvent = false;
  syncParkingWhen();
  recolourParking();
}

/* --- opening, closing, the views --- */
// The place card's Park near here button: straight to where you can park now, and for how long.
function openParkNear() {
  var p = pendingPlace;
  if (!p || !p.lat) return;
  if (parkPlace) closeParkNear();
  if (fuelPanel.classList.contains('open')) closeFuel();
  parkPlace = { name: p.name, lat: p.lat, lng: p.lng };
  parkPlan = parkDefaultPlan();
  parkSort = 'nearest';
  parkResults = [];
  parkSelIdx = -1;
  parkInfo = null;
  parkPrevPlan = null;
  parkUseParkingLayer();
  parkPanel.classList.add('open');
  document.body.classList.add('park-open');
  parkSheetTo('half');
  return parkFind();
}

// Close the view: results off the map, any lookup dropped, the parking layer as it was.
function closeParkNear() {
  if (!parkPlace) return;
  parkSeq++;
  parkPlace = null;
  parkPlan = null;
  parkPrevPlan = null;
  parkView = null;
  parkResults = [];
  parkInfo = null;
  parkSelIdx = -1;
  clearParkResults();
  parkPanel.classList.remove('open');
  document.body.classList.remove('park-open');
  if (window.__parkSheet) window.__parkSheet.close();
  parkBody.innerHTML = '';
  var prev = parkPrevParking, owned = parkOwnsParking;
  parkPrevParking = null;
  parkOwnsParking = false;
  if (owned) {
    if (parkingOn) toggleParking(false);
  } else if (prev && parkingOn) {
    parkingNow = prev.now;
    parkingWhen = prev.when;
    parkingBH = prev.bh;
    parkingEvent = prev.event;
    if (parkingNow) followParkingClock();
    syncParkingWhen();
    recolourParking();
    openParkingPanel();
  }
}

// The header's back button: a street's card → the list; the plan → the results it was opened
// from, looked up again (a "now" list is for the time it's shown); an error → the plan.
function parkBack() {
  if (parkView === 'detail') parkShowList();
  else if (parkView === 'plan') {
    if (!parkPrevPlan) return;
    parkPlan = parkPrevPlan;
    return parkFind();
  }
  else if (parkView === 'error') parkShowPlan();
}

function parkSheetTo(snap) {
  if (isMobileView() && window.__parkSheet) window.__parkSheet.open(snap);
}

// The plan: arrival and stay ("Change" on the results). It remembers the plan it was opened from
// for its Back button.
function parkShowPlan() {
  if (!parkPlace) return;
  parkSeq++;                   // a search still on its way was for the old plan
  if (parkView !== 'plan' && parkPlan) {
    parkPrevPlan = { dayIdx: parkPlan.dayIdx, minutes: parkPlan.minutes, stay: parkPlan.stay, now: parkPlan.now };
  }
  parkView = 'plan';
  parkSelIdx = -1;
  parkResults = [];
  clearParkResults();
  parkRender();
  parkSheetTo('compact');
  parkSyncParkingTime();
}

function parkShowList() {
  parkSelIdx = -1;
  parkApplySel();
  parkView = 'results';
  parkRender();
  parkSheetTo('half');
}

// A row's card. A zone: the map frames its outline, highlighted, with its streets coloured. A
// street: the map flies to it, outlined.
function parkShowDetail(i) {
  var r = parkResults[i];
  if (!r || !parkPlace) return;
  parkSelIdx = i;
  parkView = 'detail';
  parkApplySel();
  parkRender();
  parkSheetTo('half');
  if (r.kind === 'zone') parkFitBounds(parkZoneBounds(r));
  else map.flyTo({ center: r.point, zoom: Math.max(map.getZoom(), 16.5), offset: paddingOffset(parkMapPadding()) });
}

// A tap on a result on the map: its card, unless it's already open.
function parkTapResult(i) {
  if (!parkPlace || (parkView !== 'results' && parkView !== 'detail')) return;
  if (parkView === 'detail' && parkSelIdx === i) return;
  parkShowDetail(i);
}

function parkSetSort(s) {
  parkSort = s;
  parkRender();
}

// Find parking: load what's needed, list the zones and odd streets, draw them.
function parkFind() {
  if (!parkPlace || !parkPlan) return Promise.resolve();
  var seq = ++parkSeq;
  parkPrevPlan = null;
  if (parkPlan.now) { parkPlan.dayIdx = 0; parkPlan.minutes = parkNowMinutes(); }
  var place = parkPlace, o = [place.lng, place.lat], area = null, arrival = null;
  parkView = 'loading';
  parkSelIdx = -1;
  parkResults = [];
  clearParkResults();
  parkRender();
  return loadParkingData().then(function() {
    if (seq !== parkSeq) return null;
    parkSyncParkingTime();
    arrival = parkArrival();
    area = parkArea(place.lng, place.lat);
    var ids = area.boroughs.filter(function(id) { return parkingRules.boroughs[id].detail; });
    return Promise.all(ids.map(function(id) { return loadParkingBorough(id).catch(function() { return null; }); }))
      .then(function() { return ids; });
  }).then(function(ids) {
    if (!ids || seq !== parkSeq) return null;
    var cands = parkCandidates(ids, o, arrival, area.inRules);
    return parkRefineWalks(cands, o).then(function() { return cands; });
  }).then(function(cands) {
    if (!cands || seq !== parkSeq) return;
    parkResults = cands.filter(function(c) { return c.walk <= PARK_WALK_MAX; }).map(parkResult);
    parkInfo = { arrival: arrival, inZone: area.inZone, outline: area.outline, covered: area.boroughs.length > 0 };
    parkView = 'results';
    parkData = parkResults.length ? parkResultsGeoJSON() : null;
    parkZoneData = parkResults.length ? parkZonesGeoJSON() : null;
    if (parkData) addParkResultsLayers();
    parkRender();
    parkSheetTo('half');
    if (parkResults.length) parkFitResults();
  }).catch(function() {
    if (seq !== parkSeq) return;
    parkView = 'error';
    parkRender();
  });
}

/* --- panel content --- */
function parkButton(cls, text, onClick, label) {
  var b = pkEl('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}
function parkChip(text, on, onClick, label) {
  var b = parkButton('park-chip', text, onClick, label);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  return b;
}
function parkGroup(cls, label) {
  var g = pkEl('div', cls);
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', label);
  return g;
}

function parkRender() {
  if (!parkPlace) return;
  parkTitle.textContent = (parkView === 'plan' ? 'Park near ' : 'Parking near ') + parkPlace.name;
  parkBackBtn.hidden = !(parkView === 'detail' || parkView === 'error' || (parkView === 'plan' && parkPrevPlan));
  parkBackBtn.setAttribute('aria-label', parkView === 'detail' ? 'Back to list'
    : parkView === 'plan' ? 'Back to results' : 'Change arrival or stay');
  parkBody.innerHTML = '';
  parkBody.scrollTop = 0;
  if (parkView === 'plan') parkRenderPlan();
  else if (parkView === 'loading') parkBody.appendChild(pkEl('div', 'fuel-msg fuel-msg--pending', 'Finding streets near ' + parkPlace.name));
  else if (parkView === 'error') {
    parkBody.appendChild(pkEl('div', 'fuel-msg fuel-msg--error', 'Couldn’t load the parking data. Try again.'));
    parkBody.appendChild(parkButton('park-primary', 'Try again', parkFind));
  }
  else if (parkView === 'results') parkRenderResults();
  else if (parkView === 'detail') parkRenderDetail();
}

function parkPlanChanged() {
  parkRender();
  parkSyncParkingTime();
}

function parkRenderPlan() {
  var a = parkArrival();
  parkBody.appendChild(pkEl('div', 'park-label', 'Arrival'));
  var days = parkGroup('park-chips park-days', 'Arrival day');
  parkDays().forEach(function(d, i) {
    days.appendChild(parkChip(d.label, i === parkPlan.dayIdx, function() {
      parkPlan.dayIdx = i;
      parkPlan.now = false;
      parkPlanChanged();
    }, i === 0 ? 'Today, ' + PARKING_DAYS[d.day] : null));
  });
  parkBody.appendChild(days);

  var row = pkEl('div', 'park-time-row');
  row.appendChild(parkButton('park-step', '−', function() {
    parkPlan.minutes = Math.max(0, Math.ceil(parkPlan.minutes / 15) * 15 - 15);
    parkPlan.now = false;
    parkPlanChanged();
  }, '15 minutes earlier'));
  var input = pkEl('input', 'park-time');
  input.type = 'time';
  input.step = '900';
  var h = Math.floor(a.minutes / 60), m = a.minutes % 60;
  input.value = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  input.setAttribute('aria-label', 'Arrival time');
  input.addEventListener('change', function() {
    if (!input.value) return;
    parkPlan.minutes = hhmmToMinutes(input.value);
    parkPlan.now = false;
    parkPlanChanged();
  });
  row.appendChild(input);
  row.appendChild(parkButton('park-step', '+', function() {
    parkPlan.minutes = Math.min(1425, Math.floor(parkPlan.minutes / 15) * 15 + 15);
    parkPlan.now = false;
    parkPlanChanged();
  }, '15 minutes later'));
  row.appendChild(parkChip('Now', parkPlan.now, function() {
    parkPlan.dayIdx = 0;
    parkPlan.minutes = parkNowMinutes();
    parkPlan.now = true;
    parkPlanChanged();
  }, 'Arrive now'));
  parkBody.appendChild(row);

  parkBody.appendChild(pkEl('div', 'park-label', 'Stay'));
  var stays = parkGroup('park-chips park-stays', 'How long');
  PARK_STAYS.forEach(function(s) {
    stays.appendChild(parkChip(s[1], parkPlan.stay === s[0], function() {
      parkPlan.stay = s[0];
      parkPlanChanged();
    }, s[0] === 'day' ? 'All day, until midnight' : s[0] === null ? 'Any length: how long you can stay' : null));
  });
  parkBody.appendChild(stays);

  var sum = pkEl('div', 'park-summary');
  if (a.any) {
    sum.appendChild(pkEl('div', 'park-summary-main', (a.now ? 'Now' : a.label + ' ' + parkClock(a.minutes)) + ' · any length'));
    sum.appendChild(pkEl('div', 'pk-small', 'Where you can park, and for how long · within a ' + PARK_WALK_MAX + ' min walk'));
  } else {
    sum.appendChild(pkEl('div', 'park-summary-main', a.label + ' ' + parkClock(a.minutes) + ' – ' + parkClock(a.minutes + a.stayMin)));
    sum.appendChild(pkEl('div', 'pk-small', (parkPlan.stay === 'day' ? 'Until midnight (' + parkDurLong(a.stayMin) + ')' : parkDurLong(a.stayMin))
      + ' · within a ' + PARK_WALK_MAX + ' min walk'));
  }
  parkBody.appendChild(sum);
  parkBody.appendChild(parkButton('park-primary park-compact', 'Find parking', parkFind));
}

function parkRenderResults() {
  var a = parkInfo.arrival;
  // 'Now · any length  [Change]', 'Fri 3:45pm · 2h  [Change]': Change opens the plan.
  var head = pkEl('div', 'park-res-head');
  head.appendChild(pkEl('div', 'park-res-when', parkPlanSummary(a)));
  head.appendChild(parkButton('park-edit', 'Change', parkShowPlan, 'Change arrival time or stay length'));
  parkBody.appendChild(head);

  var name = parkPlace.name;
  if (!parkInfo.covered && !parkInfo.inZone) {
    parkBody.appendChild(pkEl('div', 'pk-note park-compact', 'No parking data near ' + name + ' yet. This covers London’s controlled parking zones.'));
    return;
  }
  if (!parkInfo.inZone && !parkInfo.outline) {
    parkBody.appendChild(pkEl('p', 'pk-note', name + ' isn’t in a controlled parking zone: most streets nearby have no parking controls. Watch for yellow lines and signs.'));
  }
  if (!parkResults.length) {
    var empty = pkEl('div', 'park-empty park-compact');
    if (!parkInfo.inZone && parkInfo.outline) {
      var bn = (parkingRules.boroughs[parkInfo.outline] || {}).name || 'This borough';
      empty.appendChild(pkEl('p', 'park-empty-title', bn + ' publishes no zone map this can use, so its streets can’t be listed.'));
      empty.appendChild(pkEl('p', 'pk-small', 'Check the signs where you park.'));
    } else if (!parkInfo.inZone) {
      empty.appendChild(pkEl('p', 'pk-small', 'No controlled-zone streets within a ' + PARK_WALK_MAX + ' min walk.'));
    } else if (a.any) {
      empty.appendChild(pkEl('p', 'park-empty-title', 'Nowhere within a ' + PARK_WALK_MAX + ' min walk you can park '
        + (a.now ? 'now' : 'at ' + a.label + ' ' + parkClock(a.minutes))));
      empty.appendChild(pkEl('p', 'pk-small', 'The streets nearby are for permit holders only then.'));
      empty.appendChild(parkButton('park-primary', 'Plan for later', parkShowPlan));
    } else {
      empty.appendChild(pkEl('p', 'park-empty-title', 'No streets within a ' + PARK_WALK_MAX + ' min walk allow this stay'));
      empty.appendChild(pkEl('p', 'pk-small', a.label + ' ' + parkClock(a.minutes) + ' · ' + parkDur(a.stayMin) + ' stay.'));
      empty.appendChild(parkButton('park-primary', 'Shorten stay', parkShowPlan));
    }
    parkBody.appendChild(empty);
    return;
  }

  var seg = parkGroup('park-seg park-compact', 'Sort zones and streets');
  [['nearest', 'Nearest'], ['cheapest', 'Cheapest']].forEach(function(s) {
    var b = parkButton('park-seg-btn', s[1], function() { parkSetSort(s[0]); });
    b.setAttribute('aria-pressed', parkSort === s[0] ? 'true' : 'false');
    seg.appendChild(b);
  });
  parkBody.appendChild(seg);

  var list = pkEl('ul', 'park-list');
  parkSorted().forEach(function(x) { list.appendChild(parkRowEl(x)); });
  parkBody.appendChild(list);
  parkBody.appendChild(pkEl('p', 'pk-small park-foot', 'Shows where you’re allowed to park, not whether a space is free. Check the signs.'));
}

// One row of the list ({ r, i } from parkSorted()): walk, title, the line under it, how long you
// can stay (or whether the stay fits) and the price. It opens the row's card.
function parkRowEl(x) {
  var r = x.r;
  var li = pkEl('li', '');
  var row = parkButton('park-row' + (r.kind === 'zone' ? ' park-row--zone' : ''), undefined, function() { parkShowDetail(x.i); });
  parkRowSwatch(row, r);
  var walk = pkEl('span', 'park-walk');
  walk.appendChild(pkEl('b', '', String(r.walk)));
  walk.appendChild(pkEl('span', '', 'min'));
  row.appendChild(walk);
  var main = pkEl('span', 'park-main');
  main.appendChild(pkEl('span', 'park-name', parkRowTitle(r)));
  main.appendChild(pkEl('span', 'park-zone', parkRowSub(r)));
  if (r.now) main.appendChild(pkEl('span', 'park-stay', parkStayLine(r)));
  else {
    var fit = parkFitLine(r);
    if (fit) main.appendChild(pkEl('span', 'park-fit', fit));
  }
  row.appendChild(main);
  row.appendChild(parkCostEl(r));
  li.appendChild(row);
  return li;
}

// A result row's left edge in its street's colour on the map, so the list and the map's result
// lines match up. The colour comes from style.css (.park-row--free / --paid / --unknown, the
// theme's --pk-* swatches), so it follows a theme change.
function parkRowSwatch(row, r) {
  row.classList.add('park-row--line');
  row.classList.add('park-row--' + (PARK_STATE_COLORS[r.state] ? r.state : 'unknown'));
}

// The price column: 'Free'; '£4.64', '£9.56–£21.16' or 'from £4.64' with when it's paid and, for
// a price that depends on the car, 'by car emissions' / 'by fuel type'; 'Price unknown'; or
// 'Check signs'. A range may wrap after its dash, so the street name keeps its room.
// With no stay chosen it's the hourly rate now ('£2.32/hr', '£4.78–£10.58/hr', 'from £2.32/hr'),
// and a street that's free now but paid later says 'then £2.32/hr' under 'Free'.
function parkCostEl(r) {
  var box = pkEl('span', 'park-cost');
  var price, basis = '', any = !!r.now, unit = any ? '/hr' : '';
  var lo = any ? r.rateMin : r.costMin, hi = any ? r.rateMax : r.costMax;
  var exact = any ? (r.tariff && r.tariff.exact ? r.rateMin : null) : r.price;
  if (r.state === 'unknown') price = pkEl('span', 'park-price park-price--unknown', 'Check signs');
  else if (r.state === 'free') price = pkEl('span', 'park-price park-price--free', 'Free');
  else {
    price = pkEl('span', 'park-price');
    price.appendChild(pkEl('i', 'pk-dot pk-ctrl'));
    var amt = pkEl('span', 'park-amt');
    if (exact !== null) amt.textContent = parkMoney(exact) + unit;
    else if (lo === null) { amt.textContent = 'Price unknown'; price.className += ' park-price--none'; }
    else if (hi === null) {
      amt.appendChild(pkEl('span', 'park-from', 'from '));
      amt.appendChild(document.createTextNode(parkMoney(lo) + unit));
    } else if (hi === lo) amt.textContent = parkMoney(lo) + unit;
    else {
      amt.appendChild(document.createTextNode(parkMoney(lo) + '–'));
      amt.appendChild(document.createElement('wbr'));
      amt.appendChild(document.createTextNode(parkMoney(hi) + unit));
    }
    price.appendChild(amt);
    if (exact === null && lo !== null) basis = parkBasisWords(r.tariff);
  }
  box.appendChild(price);
  var when = !any ? parkSegLine(r)
    : r.state === 'free' && r.now.segments.length > 1 && r.tariff ? 'then ' + parkRate(r.tariff) : '';
  if (when) box.appendChild(pkEl('span', 'park-when', when));
  if (basis) box.appendChild(pkEl('span', 'park-when park-basis', basis));
  return box;
}

// The pill on a street's card: 'Pay to park until 7pm', 'Free for your stay'; with no stay
// chosen, how long you can stay (parkStayLine()).
function parkPillText(r) {
  if (r.now) return parkStayLine(r);
  if (r.state === 'unknown') return 'Hours unclear: check the signs';
  if (r.state === 'free') return 'Free for your stay';
  var segs = parkSegments(r), m0 = parkInfo.arrival.minutes, first = segs[0];
  if (segs.length === 1) return 'Pay to park all stay';
  if (first.status === 'ctrl') return 'Pay to park until ' + parkingClock((m0 + first.end) % 1440);
  return PARK_SEG_WORDS[first.status].charAt(0).toUpperCase() + PARK_SEG_WORDS[first.status].slice(1)
    + ' until ' + parkingClock((m0 + first.end) % 1440) + ', then pay';
}

function parkRenderDetail() {
  var r = parkResults[parkSelIdx], a = parkInfo.arrival, plan = r.plan;
  var rule = parkingRule(r.rule) || {}, zoneRule = parkingRule(r.b + ':' + r.zone) || {};
  var borough = parkingRules.boroughs[r.b] || {};
  var card = pkEl('div', 'pk-card park-detail');

  var zone = r.kind === 'zone';
  var titles = pkEl('div', 'pk-card-titles');
  titles.appendChild(pkEl('div', 'pk-card-title', parkRowTitle(r)));
  titles.appendChild(pkEl('div', 'pk-card-sub', zone ? borough.name || '' : parkZoneLine(r) + (borough.name ? ' · ' + borough.name : '')));
  card.appendChild(titles);

  var pill = pkEl('div', 'park-pill');
  var dot = pkEl('i', 'pk-dot');
  dot.style.background = PARK_STATE_COLORS[r.state];
  pill.appendChild(dot);
  pill.appendChild(document.createTextNode(parkPillText(r)));
  card.appendChild(pill);
  card.appendChild(pkEl('p', 'park-walkline', r.inside ? parkPlace.name + ' is in this zone'
    : r.walk + ' min walk to ' + parkPlace.name + (zone ? ' from ' + r.street : '') + (r.refined ? '' : ' (estimate)')));

  // With no stay chosen the bar covers the time you can stay, up to 24 hours (parkWindow()).
  var span = parkSpan(r), limited = r.now && r.now.untilMin === span;
  card.appendChild(pkEl('div', 'pk-section', !r.now ? 'Your stay · ' + a.label + ' ' + parkRange(a.minutes, a.minutes + a.stayMin)
    : (a.now ? 'From now' : 'From ' + a.label + ' ' + parkClock(a.minutes)) + ' · '
      + (limited ? 'until ' + parkAt(a, span) : 'next ' + parkDur(span))));
  var segs = parkSegments(r);
  var bar = pkEl('div', 'park-bar');
  bar.setAttribute('aria-hidden', 'true');
  var ticks = pkEl('div', 'park-ticks');
  ticks.setAttribute('aria-hidden', 'true');
  segs.forEach(function(s) {
    var piece = pkEl('span', 'park-bar-seg park-bar-seg--' + s.status);
    piece.style.flex = String(s.end - s.start);
    piece.style.background = hexToRgba(PARK_SEG_COLORS[s.status] || PARKING_COLORS.unknown, 0.35);
    piece.style.borderColor = PARK_SEG_COLORS[s.status] || PARKING_COLORS.unknown;
    bar.appendChild(piece);
    var t = pkEl('span', '', parkingClock((a.minutes + s.start) % 1440));
    t.style.flex = String(s.end - s.start);
    ticks.appendChild(t);
  });
  ticks.appendChild(pkEl('span', 'park-tick-end', parkingClock((a.minutes + span) % 1440)));
  card.appendChild(bar);
  card.appendChild(ticks);

  var costs = pkEl('ul', 'park-costs');
  var t = r.tariff;
  segs.forEach(function(s) {
    var dur = s.end - s.start, detail, amount;
    if (s.status === 'ctrl') {
      // '2h × £2.00' → £4.00; '2h × £4.78–£10.58' → £9.56–£21.16; '2h × from £2.32' → from £4.64
      detail = t ? parkDur(dur) + ' × ' + parkAmount(t.min, t.max) : parkDur(dur) + ', price unknown';
      amount = t ? parkAmount(parkingCost(t.min, dur), t.max === null ? null : parkingCost(t.max, dur)) : '?';
    } else if (s.status === 'free') {
      detail = parkDur(dur) + ', no charge'; amount = 'Free';
    } else if (s.status === 'permit') {
      detail = 'permit holders only'; amount = '–';
    } else {
      detail = 'hours unclear: check the signs'; amount = '?';
    }
    var li = pkEl('li', 'park-cost-row');
    var left = pkEl('span', 'park-cost-label');
    left.appendChild(pkEl('b', '', parkRange(a.minutes + s.start, a.minutes + s.end, true)));
    left.appendChild(pkEl('span', '', detail));
    li.appendChild(left);
    li.appendChild(pkEl('span', 'park-cost-amount' + (amount === 'Free' ? ' park-price--free' : ''), amount));
    costs.appendChild(li);
  });
  var total = pkEl('li', 'park-cost-row park-cost-total');
  total.appendChild(pkEl('span', 'park-cost-label', !r.now ? 'Total'
    : 'Total, ' + (limited ? 'until ' + parkAt(a, span) : parkDur(span))));
  total.appendChild(pkEl('span', 'park-cost-amount', r.state === 'unknown' || r.costMin === null ? 'Unknown'
    : r.costMin === 0 ? 'Free' : parkAmount(r.costMin, r.costMax)));
  costs.appendChild(total);
  card.appendChild(costs);
  if (r.state !== 'unknown' && plan.paidMin > 0) parkPriceDetail(card, r, borough);

  var max = rule.maxStay || zoneRule.maxStay || (borough.maxStayDefault ? borough.maxStayDefault + ' (council default)' : '')
    || (plan.maxStayMin != null ? parkDurLong(plan.maxStayMin) : '');
  parkingRow(card, 'Max stay', max ? max + (!r.now && plan.maxStayMin != null && plan.paidMin ? ' · your ' + parkDur(a.stayMin) + ' stay fits' : '') : 'No limit listed');
  parkingRow(card, 'Controlled', rule.hours || zoneRule.hours);
  if (rule.event) parkingRow(card, 'Event days', rule.event.hours.replace(/^Event days: /, ''));
  var pay = rule.payCode || zoneRule.payCode;
  if (pay && pay.code) parkingRow(card, 'Pay by phone', pay.provider + ' location ' + pay.code);
  if (zone) parkingRow(card, 'Nearest street', r.street);
  parkingRow(card, 'Walk', r.inside ? 'About 1 min: ' + parkPlace.name + ' is in this zone' : r.walk + ' min to ' + parkPlace.name);
  card.appendChild(pkEl('p', 'pk-small', 'Check the signs on the street: bays can be suspended.'));
  // A zone's streets with rules of their own, listed in the results too.
  var odd = zone ? parkOddStreets(r) : [];
  if (odd.length) {
    card.appendChild(pkEl('div', 'pk-section', 'Streets here with their own rules'));
    var sub = pkEl('ul', 'park-list park-sublist');
    odd.forEach(function(x) { sub.appendChild(parkRowEl(x)); });
    card.appendChild(sub);
  }

  var actions = pkEl('div', 'park-actions park-compact');
  var dir = pkLink('Directions', 'https://www.google.com/maps/dir/?api=1&destination='
    + r.point[1].toFixed(6) + ',' + r.point[0].toFixed(6) + '&travelmode=driving');
  dir.className = 'park-primary';
  actions.appendChild(dir);
  actions.appendChild(parkButton('park-secondary', 'Back to list', parkShowList));
  card.appendChild(actions);
  parkBody.appendChild(card);
}

// Under a paid stay's costs: what the stay costs in each emissions band or fuel type, what a
// 'from' price means, or (no prices in the data) the council's own note; then a link to its prices.
function parkPriceDetail(card, r, borough) {
  var t = r.tariff, charges = borough.charges || {}, paidMin = r.plan.paidMin;
  if (t && t.bands && !t.exact) {
    card.appendChild(pkEl('div', 'pk-section', (t.by === 'fuel' ? 'By fuel type' : 'By emissions band')
      + ' · ' + parkDur(paidMin) + ' paid'));
    var list = pkEl('ul', 'park-bands');
    t.bands.forEach(function(b) {
      var li = pkEl('li', 'park-band-row');
      li.appendChild(pkEl('span', 'park-band-label', b.label));
      li.appendChild(pkEl('span', 'park-cost-amount', parkMoney(parkingCost(b.perHour, paidMin))));
      list.appendChild(li);
    });
    card.appendChild(list);
  } else if (t && t.basis === 'from') {
    card.appendChild(pkEl('p', 'pk-small', parkAmount(r.costMin, null) + ': the lowest rate published for this zone. '
      + 'The price depends on your car\u2019s ' + (t.by === 'fuel' ? 'fuel type' : 'emissions') + ', so yours may be higher.'));
  } else if (!t && charges.note) {
    card.appendChild(pkEl('p', 'pk-small park-price-note', parkShortNote(charges.note)));
  }
  var url = (t && t.url) || charges.url;
  if (url) {
    var row = pkEl('div', 'pk-row');
    row.appendChild(pkEl('span', 'pk-row-label', 'Prices'));
    var value = pkEl('span', 'pk-row-value');
    value.appendChild(pkLink((borough.short || borough.name || 'Council') + ' parking charges', url)).className = 'pk-pdf';
    row.appendChild(value);
    card.appendChild(row);
  }
}

// Tapping a result street or a listed zone on the map opens its card; a street drawn over a zone
// wins. Layer listeners outlive setStyle().
map.on('click', 'park-results-casing', function(e) {
  var f = e.features && e.features[0];
  if (f) parkTapResult(f.properties.i);
});
map.on('click', 'park-zones-fill', function(e) {
  var f = e.features && e.features[0];
  if (!f) return;
  if (map.getLayer('park-results-casing') && map.queryRenderedFeatures(e.point, { layers: ['park-results-casing'] }).length) return;
  parkTapResult(f.properties.i);
});
map.on('mouseenter', 'park-results-casing', function() { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'park-results-casing', function() { map.getCanvas().style.cursor = ''; });
/* ===== END PARK NEAR HERE ===== */

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

/* ===== CONGESTION CHARGE ===== */
// The London Congestion Charge zone: the C button under the P button turns on an orange outline
// of the zone (data/ccz.geojson, TfL's boundary; see data/README.md) and a chip saying whether
// the charge applies now, refreshed every minute. The rules live in congestion.js
// (ccStatusAt, ccStatusText, ccInZone, ccChargeForTrip, ccFreeAlternative) so they can be
// unit-tested. Picking a place inside the zone turns the layer on.
var CCZ_URL = '/data/ccz.geojson';
var CCZ_HOLIDAYS_URL = '/data/bank-holidays.json';
var CCZ_ATTRIB = 'Congestion Charge zone: Powered by TfL Open Data';
// Each theme has its own shades, refilled into CCZ_COLORS by syncCczColors() on theme toggle.
var CCZ_PALETTES = {
  light: { line: '#ea580c', fill: '#f97316', fillOpacity: 0.08 },
  dark:  { line: '#fb923c', fill: '#fb923c', fillOpacity: 0.10 }
};
var CCZ_COLORS = {};
function syncCczColors() {
  var p = CCZ_PALETTES[isDark ? 'dark' : 'light'];
  Object.keys(p).forEach(function(k) { CCZ_COLORS[k] = p[k]; });
}
syncCczColors();
var cczOn = false;
var cczData = null;         // the zone's GeoJSON once loaded
var cczLoading = null;      // the in-flight load, so a tap and a pick share it
var cczTimer = null;
var cczPickSeq = 0;         // the newest place picked; an older one's answer is dropped
var cczBtn = null;
var cczChip = document.getElementById('ccz-chip');
var cczChipStatus = document.getElementById('ccz-chip-status');

// The C button, under the P button.
map.addControl({
  onAdd: function() {
    var wrap = document.createElement('div');
    wrap.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'ccz-ctrl';
    b.className = 'ccz-ctrl';
    b.title = 'Congestion Charge zone';
    b.setAttribute('aria-label', 'Congestion Charge zone');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<span class="ccz-sign" aria-hidden="true">C</span>';
    b.addEventListener('click', function() { toggleCcz(!cczOn); });
    wrap.appendChild(b);
    cczBtn = b;
    return wrap;
  },
  onRemove: function() {}
}, 'top-right');

function cczGet(url) {
  return fetch(url).then(function(r) {
    if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
    return r.json();
  });
}

// The zone and the bank holidays (for weekend hours on them). Without the holidays the chip still
// works, treating a bank holiday as an ordinary day.
function loadCczData() {
  if (cczData) return Promise.resolve(cczData);
  if (cczLoading) return cczLoading;
  cczLoading = Promise.all([
    cczGet(CCZ_URL),
    cczGet(CCZ_HOLIDAYS_URL).catch(function() { return null; })
  ]).then(function(d) {
    ccSetZone(d[0]);
    if (d[1] && d[1].dates) ccSetBankHolidays(d[1].dates);
    cczData = d[0];
    return cczData;
  }).catch(function(e) { cczLoading = null; throw e; });
  return cczLoading;
}

function toggleCcz(on) {
  if (on === cczOn) return;
  cczOn = on;
  (cczBtn || document.getElementById('ccz-ctrl')).setAttribute('aria-pressed', on ? 'true' : 'false');
  clearInterval(cczTimer);
  if (!on) {
    removeCczLayers();
    cczChip.classList.remove('open');
    return;
  }
  updateCczChip();
  cczChip.classList.add('open');
  cczTimer = setInterval(updateCczChip, 60000);
  loadCczData().then(function() {
    if (!cczOn) return;
    updateCczChip();                                   // the bank holidays may change it
    addCczLayers();
  }).catch(function() {
    if (cczOn) cczChipStatus.textContent = 'Couldn’t load the zone';
  });
}

function updateCczChip() {
  var now = new Date();
  cczChip.classList.toggle('is-charging', ccStatusAt(now).charging);
  cczChipStatus.textContent = ccStatusText(now);
}

function removeCczLayers() {
  if (map.getLayer('ccz-line')) map.removeLayer('ccz-line');
  if (map.getLayer('ccz-fill')) map.removeLayer('ccz-fill');
  if (map.getSource('ccz')) map.removeSource('ccz');
}

// The tint goes under the roads and the outline above them but under their names, like the
// parking zones. Safe to run twice (rehydrateLayers()).
function addCczLayers() {
  if (!cczData) return;
  whenStyleReady(function() {
    if (!cczOn) return;
    removeCczLayers();
    var styleLayers = map.getStyle().layers;
    var underRoads = (styleLayers.filter(function(l) { return l.type === 'symbol'; })[0] || {}).id;
    var underLabels = map.getLayer('road-label') ? 'road-label'
      : (styleLayers.filter(function(l) { return l.type === 'symbol' && /label/.test(l.id); })[0] || {}).id;
    map.addSource('ccz', { type: 'geojson', data: cczData, attribution: CCZ_ATTRIB });
    map.addLayer({ id: 'ccz-fill', type: 'fill', source: 'ccz',
      paint: { 'fill-color': CCZ_COLORS.fill, 'fill-opacity': CCZ_COLORS.fillOpacity } }, underRoads);
    map.addLayer({ id: 'ccz-line', type: 'line', source: 'ccz',
      layout: { 'line-join': 'round' },
      paint: { 'line-color': CCZ_COLORS.line, 'line-opacity': 0.9, 'line-dasharray': [3, 1.5],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.5, 17, 4] } }, underLabels);
  });
}

// A place was picked: if it's in the zone, show the zone. Places with no coordinates yet (a bare
// postcode before its boundary loads) are skipped; postcodeReady() asks again.
function cczCheckPlace(lng, lat) {
  if (!isFinite(lng) || !isFinite(lat) || (lng === 0 && lat === 0)) return;
  var seq = ++cczPickSeq;
  loadCczData().then(function() {
    if (seq !== cczPickSeq) return;
    if (ccInZone(lng, lat)) toggleCcz(true);
  }).catch(function() {});
}
/* ===== END CONGESTION CHARGE ===== */

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
// Park near here: the list (it opens on it) and a street's card at half height; the plan with Find parking showing.
window.__parkSheet = makeSnapSheet({
  card: 'park-panel', grabber: 'park-grabber', header: '.fuel-header',
  compact: '.park-compact', initial: 'half',
  isOpen: function () { return parkPanel.classList.contains('open'); }
});
/* ===== END DRAGGABLE BOTTOM SHEET ===== */
