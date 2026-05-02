var MAPBOX_TOKEN = '__MAPBOX_TOKEN__';
var OS_TOKEN = '__OS_TOKEN__';
var COLORS = ['#2ecc71','#3498db','#f39c12','#e74c3c'];
var MINS = [5,10,15,20];
var PC_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

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

var map = L.map('map', { zoomControl: false }).setView([51.5007, -0.1246], 13);
L.control.zoom({ position: 'topright' }).addTo(map);

var isDark = false;
var tileLayer = null;

var prevState = null;
var appState = 'idle';
function setState(newState) {
  if (newState === appState) return;
  prevState = appState;
  appState = newState;
  document.body.dataset.state = newState;
  if (location.hostname === 'localhost' || location.port) {
    console.log('[state] ' + prevState + ' → ' + newState);
  }
}

function searchPostcode(pc) {
  pc = pc.trim().toUpperCase();
  if (!pc) return;
  setStatus('Fetching ' + pc + '…');

  var cached = localStorage.getItem('pc:' + pc);
  if (cached) {
    var entry = JSON.parse(cached);
    if (Date.now() - entry.ts < 30 * 24 * 60 * 60 * 1000) {
      renderPostcode(entry.geojson, pc); return;
    }
  }

  var url = 'https://api.os.uk/features/ngd/ofa/v1/collections/asu-gbpcd-postcodeunitarea-1/items'
    + '?filter=' + encodeURIComponent("postcode='" + pc + "'") + '&key=' + OS_TOKEN;

  fetch(url)
    .then(function(res) {
      if (!res.ok) return res.text().then(function(t) { throw new Error('HTTP ' + res.status + ': ' + t); });
      return res.json();
    })
    .then(function(geo) {
      if (!geo.features || geo.features.length === 0) {
        setStatus(pc + ' has no polygon — likely a Large User postcode.', true);
        return;
      }
      try { localStorage.setItem('pc:' + pc, JSON.stringify({ geojson: geo, ts: Date.now() })); } catch(e) {}
      renderPostcode(geo, pc);
    })
    .catch(function(e) {
      var msg = e.message || '';
      setStatus((msg.toLowerCase().includes('load') || msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network'))
        ? 'Network error — OS API key may not be configured yet.'
        : 'Error: ' + msg, true);
    });
}
function renderPostcode(geo, pc) {
  if (postcodeLayer) { map.removeLayer(postcodeLayer); }
  postcodeLayer = L.geoJSON(geo, {
    style: { color: '#8b5cf6', weight: 2.5, fillColor: '#8b5cf6', fillOpacity: 0.18 }
  }).addTo(map);
  map.fitBounds(postcodeLayer.getBounds(), { padding: [24, 24], maxZoom: 16 });
  var props = geo.features[0].properties;
  var info = props.postcodetype + ' · '
    + props.postcodedeliverypointcount_total + ' delivery points · '
    + geo.features.length + ' polygon part' + (geo.features.length > 1 ? 's' : '');
  setStatus(info);
  var pcStEl = document.getElementById('pc-st');
  if (pcStEl) pcStEl.textContent = info;
  var boundsCenter = postcodeLayer.getBounds().getCenter();
  if (pendingPlace && pendingPlace.postcode) {
    pendingPlace.lat = boundsCenter.lat;
    pendingPlace.lng = boundsCenter.lng;
    document.querySelectorAll('.postcode-cta-btns .travel-mode-btn').forEach(function(b) { b.disabled = false; });
  }
}

setState('idle');

function initTile() {
  var style = isDark ? 'dark-v11' : 'streets-v12';
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer('https://api.mapbox.com/styles/v1/mapbox/' + style + '/tiles/{z}/{x}/{y}@2x?access_token=' + MAPBOX_TOKEN, {
    tileSize: 512, zoomOffset: -1, maxZoom: 18,
    attribution: '&copy; <a href="https://www.mapbox.com/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
  }).addTo(map);
}
function toggleTheme() {
  isDark = !isDark;
  document.body.classList.toggle('light', !isDark);
  var iconHtml = isDark
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
  var fab = document.getElementById('theme-icon-fab');
  if (fab) fab.innerHTML = iconHtml;
  initTile();
}
initTile();

var marker = null;
var isoLayers = [];
var mode = 'walking';
var center = null;
var postcodeLayer = null;
var pendingPlace = null;
var lastSearchQuery = '';

function placeMarker(lat, lng) {
  if (marker) map.removeLayer(marker);
  var markerFill = isDark ? '#fff' : '#1a1a1a';
  var markerRing = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)';
  marker = L.circleMarker([lat, lng], {
    radius: 6, fillColor: markerFill, fillOpacity: 1,
    color: markerRing, weight: 8
  }).addTo(map);
}

map.on('mousemove', function(e) {
  document.getElementById('coords').textContent = e.latlng.lat.toFixed(4) + '°N, ' + e.latlng.lng.toFixed(4) + '°E';
});

function showModePicker() {
  if (!pendingPlace) return;
  document.getElementById('mp-name').textContent = pendingPlace.name;
  document.getElementById('mp-addr').textContent = pendingPlace.address;
  var pcTile = document.getElementById('tile-postcode');
  if (pcTile) {
    pcTile.disabled = !pendingPlace.postcode;
    pcTile.classList.toggle('mode-tile-soon', !pendingPlace.postcode);
  }
  setState('modepicker');
}

function activateMode(modeKey) {
  if (!pendingPlace) return;
  if (modeKey === 'walking' || modeKey === 'cycling' || modeKey === 'driving') {
    mode = modeKey;
    updateModeButtons();
    setState('travel');
    run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
  } else if (modeKey === 'postcode' && pendingPlace.postcode) {
    document.getElementById('pc-label').textContent = pendingPlace.postcode;
    document.querySelectorAll('.postcode-cta-btns .travel-mode-btn').forEach(function(b) { b.disabled = true; });
    setState('postcode');
    searchPostcode(pendingPlace.postcode);
  }
}

function closeModePicker() {
  pendingPlace = null;
  setState('idle');
}

function pickMode(m) {
  if (!pendingPlace) return;
  mode = m;
  updateModeButtons();
  isoLayers.forEach(function(l) { map.removeLayer(l); });
  isoLayers = [];
  run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
}

function updateModeButtons() {
  ['walking', 'cycling', 'driving'].forEach(function(m) {
    var btn = document.getElementById('btn-' + m);
    if (btn) btn.classList.toggle('active', m === mode);
  });
}

function changeMode() {
  isoLayers.forEach(function(l) { map.removeLayer(l); });
  isoLayers = [];
  if (postcodeLayer) { map.removeLayer(postcodeLayer); postcodeLayer = null; }
  MINS.forEach(function(m) {
    var el = document.getElementById('a' + m);
    if (el) { el.textContent = '—'; el.classList.add('empty'); }
  });
  showModePicker();
}

function closeTravelCard() {
  if (marker) { map.removeLayer(marker); marker = null; }
  isoLayers.forEach(function(l) { map.removeLayer(l); });
  isoLayers = [];
  MINS.forEach(function(m) {
    var el = document.getElementById('a' + m);
    if (el) { el.textContent = '—'; el.classList.add('empty'); }
  });
  pendingPlace = null;
  setState('idle');
}

function closePostcodeChip() {
  if (marker) { map.removeLayer(marker); marker = null; }
  if (postcodeLayer) { map.removeLayer(postcodeLayer); postcodeLayer = null; }
  pendingPlace = null;
  setState('idle');
}

function launchFromPostcode(modeKey) {
  if (!pendingPlace) return;
  if (postcodeLayer) { map.removeLayer(postcodeLayer); postcodeLayer = null; }
  mode = modeKey;
  updateModeButtons();
  setState('travel');
  run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
}

function modePickerBack() {
  if (marker) { map.removeLayer(marker); marker = null; }
  openSearchOverlay();
  var q = lastSearchQuery.trim();
  overlayInput.value = lastSearchQuery;
  if (q) {
    pendingPostcode = PC_RE.test(q) ? formatPostcode(q) : null;
    fetchSuggest(q);
  }
  pendingPlace = null;
}

function modePickerClose() {
  if (marker) { map.removeLayer(marker); marker = null; }
  isoLayers.forEach(function(l) { map.removeLayer(l); });
  isoLayers = [];
  pendingPlace = null;
  setState('idle');
}

var sessionToken = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
var suggestTimer = null;
var currentSuggestions = [];
var activeIdx = -1;
var pendingPostcode = null;
var preSearchState = null;

var overlayInput = document.getElementById('overlay-input');
var overlaySugg = document.getElementById('overlay-sugg');
var overlayEl = document.getElementById('search-overlay');
var suggBox = overlaySugg;

function closeSugg() { activeIdx = -1; }
function openSugg() { if (currentSuggestions.length || pendingPostcode) renderSuggestions(); }

function openSearchOverlay() {
  preSearchState = appState;
  setState('search');
  overlayInput.value = '';
  overlayInput.placeholder = 'Search a place or postcode…';
  pendingPostcode = null;
  currentSuggestions = [];
  overlaySugg.innerHTML = '';
  requestAnimationFrame(function() {
    overlayEl.classList.add('open');
    overlayInput.focus();
  });
}

function closeSearchOverlay() {
  overlayInput.blur();
  overlayEl.classList.remove('open');
  pendingPostcode = null;
  currentSuggestions = [];
  overlaySugg.innerHTML = '';
  if (preSearchState === 'modepicker' && pendingPlace) {
    setState('modepicker');
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
  suggBox.innerHTML = '';
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
    suggBox.appendChild(item);
  });
}

async function fetchSuggest(q) {
  try {
    var mc = map.getCenter();
    var url = 'https://api.mapbox.com/search/searchbox/v1/suggest?q=' + encodeURIComponent(q)
      + '&language=en&country=gb&proximity=' + mc.lng.toFixed(4) + ',' + mc.lat.toFixed(4) + '&limit=6'
      + '&session_token=' + sessionToken
      + '&access_token=' + MAPBOX_TOKEN;
    var r = await fetch(url);
    var d = await r.json();
    currentSuggestions = (d.suggestions || []).map(function(s) {
      return { mapbox_id: s.mapbox_id, name: s.name, place_formatted: s.place_formatted, full_address: s.full_address };
    });
    activeIdx = -1;
    renderSuggestions();
    if (currentSuggestions.length) openSugg(); else closeSugg();
  } catch (e) {
    currentSuggestions = [];
    closeSugg();
  }
}

function selectSuggestionFromList(i, items) {
  var s = items[i];
  if (!s) return;
  if (s.type === 'postcode') {
    closeSearchOverlay();
    document.getElementById('pc-label').textContent = s.postcode;
    pendingPlace = { lng: 0, lat: 0, name: s.postcode, address: 'UK postcode boundary', postcode: s.postcode };
    setState('postcode');
    searchPostcode(s.postcode);
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
      pendingPlace = { lng: c[0], lat: c[1], name: name, address: address, postcode: null };
      map.flyTo([c[1], c[0]], 14, { duration: 1.5 });
      placeMarker(c[1], c[0]);
      setStatus(name);
      showModePicker();
      sessionToken = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    } else { setStatus('Could not load that location', true); }
  } catch (e) { setStatus('Search failed', true); }
}

document.getElementById('search-back-btn').addEventListener('click', closeSearchOverlay);

overlayInput.addEventListener('input', function() {
  var q = overlayInput.value.trim();
  clearTimeout(suggestTimer);
  if (!q) { pendingPostcode = null; currentSuggestions = []; overlaySugg.innerHTML = ''; return; }
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

async function run(lng, lat, label) {
  center = [lng, lat];
  setStatus('Loading isochrones…');
  placeMarker(lat, lng);

  isoLayers.forEach(function(l) { map.removeLayer(l); });
  isoLayers = [];

  var profile = mode === 'driving' ? 'driving-traffic' : mode;
  var url = 'https://api.mapbox.com/isochrone/v1/mapbox/' + profile + '/' + lng + ',' + lat
    + '?contours_minutes=' + MINS.join(',')
    + '&contours_colors=' + COLORS.map(function(c) { return c.slice(1); }).join(',')
    + '&polygons=true&generalize=50&access_token=' + MAPBOX_TOKEN;

  try {
    var r = await fetch(url);
    var data = await r.json();
    if (data.message) { setStatus('API error: ' + data.message, true); return; }
    if (!data.features || !data.features.length) { setStatus('No data for this location', true); return; }

    var sorted = data.features.slice().sort(function(a, b) { return b.properties.contour - a.properties.contour; });
    sorted.forEach(function(f) {
      var color = COLORS[MINS.indexOf(f.properties.contour)] || '#888';
      var layer = L.geoJSON(f, { style: { fillColor: color, fillOpacity: 0.18, color: color, weight: 2.5, opacity: 0.7 } }).addTo(map);
      isoLayers.push(layer);
    });

    var areas = {};
    data.features.forEach(function(f) { areas[f.properties.contour] = calcArea(f.geometry); });
    MINS.forEach(function(m) {
      var el = document.getElementById('a' + m);
      if (!el) return;
      var a = areas[m];
      if (a !== undefined && a > 0) { el.textContent = a >= 0.995 ? Math.round(a) + ' km²' : a.toFixed(2) + ' km²'; el.classList.remove('empty'); }
      else { el.textContent = '—'; el.classList.add('empty'); }
    });

    setStatus(label || lat.toFixed(4) + '°N, ' + lng.toFixed(4) + '°E');
  } catch(e) { setStatus('Failed to load isochrones', true); }
}

function calcArea(geom) {
  if (geom.type === 'Polygon') return ringArea(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce(function(s, p) { return s + ringArea(p); }, 0);
  return 0;
}
function ringArea(rings) {
  var total = 0;
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r], a = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var x1 = ring[i][0], y1 = ring[i][1], x2 = ring[i+1][0], y2 = ring[i+1][1];
      a += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
    }
    total += Math.abs(a * 6371 * 6371 / 2);
  }
  return total;
}
function rad(d) { return d * Math.PI / 180; }
function setStatus(msg, isError) {
  var el = document.getElementById('st');
  if (el) {
    el.textContent = msg;
    el.className = 'travel-card-title' + (isError ? ' error' : '');
  }
  var pcEl = document.getElementById('pc-st');
  if (pcEl && appState === 'postcode') {
    pcEl.textContent = msg;
  }
}
