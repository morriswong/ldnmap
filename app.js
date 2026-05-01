var MAPBOX_TOKEN = '__MAPBOX_TOKEN__';
var OS_TOKEN = '__OS_TOKEN__';
var COLORS = ['#2ecc71','#3498db','#f39c12','#e74c3c'];
var MINS = [5,10,15,20];

function syncAppHeight() {
  var vv = window.visualViewport;
  var h = (vv && vv.height) || window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (vv && window.matchMedia('(max-width: 768px)').matches) {
    var panelBottom = window.innerHeight - vv.offsetTop - vv.height + 8;
    document.documentElement.style.setProperty('--panel-bottom', Math.max(8, panelBottom) + 'px');
  }
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
function toggleSidebar() {
  var panel = document.querySelector('.panel');
  var showBtn = document.getElementById('show-btn');
  var collapsed = panel.classList.toggle('collapsed');
  showBtn.classList.toggle('hidden', !collapsed);
  if (!collapsed && window.matchMedia('(max-width: 768px)').matches) {
    showMenuView();
  }
}
function showMenuView() {
  var panel = document.querySelector('.panel');
  panel.classList.add('view-menu');
  panel.classList.remove('view-travel');
  panel.classList.remove('view-postcode');
  if (postcodeLayer) { map.removeLayer(postcodeLayer); postcodeLayer = null; }
}
function showTravelView() {
  var panel = document.querySelector('.panel');
  panel.classList.add('view-travel');
  panel.classList.remove('view-menu', 'view-postcode');
  document.querySelectorAll('.mode-tab').forEach(function(b) {
    b.classList.toggle('on', b.dataset.tab === 'travel');
  });
}
function showPostcodeView() {
  var panel = document.querySelector('.panel');
  panel.classList.add('view-postcode');
  panel.classList.remove('view-menu', 'view-travel');
  document.querySelectorAll('.mode-tab').forEach(function(b) {
    b.classList.toggle('on', b.dataset.tab === 'postcode');
  });
}
function searchPostcode() {
  var pcEl = document.getElementById('pc-input');
  var pc = (overlaySourceInput === pcEl ? overlayInput.value : pcEl.value).trim().toUpperCase();
  if (overlaySourceInput) { pcEl.value = pc; closeSearchOverlay(); }
  if (!pc) return;
  var statusEl = document.getElementById('pc-status');
  statusEl.className = 'status';
  statusEl.textContent = 'Fetching ' + pc + '…';

  var cached = localStorage.getItem('pc:' + pc);
  if (cached) {
    var entry = JSON.parse(cached);
    if (Date.now() - entry.ts < 30 * 24 * 60 * 60 * 1000) {
      renderPostcode(entry.geojson, pc, statusEl); return;
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
        statusEl.className = 'status error';
        statusEl.textContent = pc + ' has no polygon — likely a Large User postcode (e.g. a venue or hospital).';
        return;
      }
      try { localStorage.setItem('pc:' + pc, JSON.stringify({ geojson: geo, ts: Date.now() })); } catch(e) {}
      renderPostcode(geo, pc, statusEl);
    })
    .catch(function(e) {
      statusEl.className = 'status error';
      var msg = e.message || '';
      statusEl.textContent = (msg.toLowerCase().includes('load') || msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network'))
        ? 'Network error — OS API key may not be configured yet.'
        : 'Error: ' + msg;
    });
}
function renderPostcode(geo, pc, statusEl) {
  if (postcodeLayer) { map.removeLayer(postcodeLayer); }
  postcodeLayer = L.geoJSON(geo, {
    style: { color: '#8b5cf6', weight: 2.5, fillColor: '#8b5cf6', fillOpacity: 0.18 }
  }).addTo(map);
  map.fitBounds(postcodeLayer.getBounds(), { padding: [24, 24], maxZoom: 16 });
  var props = geo.features[0].properties;
  statusEl.className = 'status ok';
  statusEl.textContent = pc + ' · ' + props.postcodetype + ' · '
    + props.postcodedeliverypointcount_total + ' delivery points · '
    + geo.features.length + ' polygon part' + (geo.features.length > 1 ? 's' : '');
}
if (window.matchMedia('(max-width: 768px)').matches) {
  document.querySelector('.panel').classList.add('collapsed');
  document.getElementById('show-btn').classList.remove('hidden');
} else {
  showTravelView();
}
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
  document.getElementById('theme-icon').innerHTML = iconHtml;
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

function placeDefaultMarker() {
  var lat = 51.5007, lng = -0.1246;
  var markerFill = isDark ? '#fff' : '#1a1a1a';
  var markerRing = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.9)';
  marker = L.circleMarker([lat, lng], {
    radius: 6, fillColor: markerFill, fillOpacity: 1,
    color: markerRing, weight: 8
  }).addTo(map);
  document.querySelectorAll('.slot-val').forEach(function(el) { el.classList.add('empty'); });
}

map.on('mousemove', function(e) {
  document.getElementById('coords').textContent = e.latlng.lat.toFixed(4) + '\u00B0N, ' + e.latlng.lng.toFixed(4) + '\u00B0E';
});

map.on('click', function(e) { run(e.latlng.lng, e.latlng.lat); });

function pick(m) {
  mode = m;
  document.querySelectorAll('.mbtn').forEach(function(b) { b.classList.toggle('on', b.dataset.m === m); });
  if (center) run(center[0], center[1]);
}

var sessionToken = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
var suggestTimer = null;
var currentSuggestions = [];
var activeIdx = -1;
var qInput = document.getElementById('q');
var suggBox = document.getElementById('sugg');
var origSuggBox = suggBox;

var overlaySourceInput = null;
var overlayInput = document.getElementById('overlay-input');
var overlaySugg = document.getElementById('overlay-sugg');
var overlayEl = document.getElementById('search-overlay');
var panelEl = document.querySelector('.panel');

function closeSugg() { if (overlaySourceInput) { activeIdx = -1; return; } suggBox.classList.remove('open'); activeIdx = -1; }
function openSugg() { if (overlaySourceInput) return; if (currentSuggestions.length) suggBox.classList.add('open'); }

function openSearchOverlay(sourceInput) {
  if (!window.matchMedia('(max-width: 768px)').matches) return;
  overlaySourceInput = sourceInput;
  overlayInput.value = sourceInput.value;
  overlayInput.placeholder = sourceInput.placeholder;
  suggBox = overlaySugg;
  panelEl.classList.add('search-active');
  if (currentSuggestions.length) renderSuggestions();
  requestAnimationFrame(function() {
    overlayEl.classList.add('open');
    overlayInput.focus();
  });
}

function closeSearchOverlay() {
  if (!overlaySourceInput) return;
  overlayInput.blur();
  overlayEl.classList.remove('open');
  overlaySourceInput.value = overlayInput.value;
  var src = overlaySourceInput;
  overlaySourceInput = null;
  suggBox = origSuggBox;
  currentSuggestions = [];
  overlaySugg.innerHTML = '';
  requestAnimationFrame(function() {
    panelEl.classList.remove('search-active');
  });
}

function renderSuggestions() {
  suggBox.innerHTML = '';
  currentSuggestions.forEach(function(s, i) {
    var item = document.createElement('div');
    item.className = 'sugg-item' + (i === activeIdx ? ' active' : '');
    item.innerHTML = '<div class="sugg-name"></div><div class="sugg-addr"></div>';
    item.querySelector('.sugg-name').textContent = s.name;
    item.querySelector('.sugg-addr').textContent = s.place_formatted || s.full_address || '';
    item.addEventListener('mousedown', function(e) { e.preventDefault(); selectSuggestion(i); });
    suggBox.appendChild(item);
  });
}

async function fetchSuggest(q) {
  try {
    var url = 'https://api.mapbox.com/search/searchbox/v1/suggest?q=' + encodeURIComponent(q)
      + '&language=en&country=gb&proximity=-0.0371,51.4871&limit=6'
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

async function selectSuggestion(i) {
  var s = currentSuggestions[i];
  if (!s) return;
  qInput.value = s.name;
  if (overlaySourceInput) closeSearchOverlay();
  closeSugg();
  setStatus('Loading\u2026');
  try {
    var url = 'https://api.mapbox.com/search/searchbox/v1/retrieve/' + encodeURIComponent(s.mapbox_id)
      + '?session_token=' + sessionToken + '&access_token=' + MAPBOX_TOKEN;
    var r = await fetch(url);
    var d = await r.json();
    if (d.features && d.features.length) {
      var c = d.features[0].geometry.coordinates;
      var label = d.features[0].properties.full_address || s.name;
      map.flyTo([c[1], c[0]], 13, { duration: 1.5 });
      run(c[0], c[1], label);
      sessionToken = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    } else { setStatus('Could not load that location', true); }
  } catch (e) { setStatus('Search failed', true); }
}

qInput.addEventListener('input', function() {
  var q = qInput.value.trim();
  clearTimeout(suggestTimer);
  if (!q) { currentSuggestions = []; closeSugg(); return; }
  suggestTimer = setTimeout(function() { fetchSuggest(q); }, 180);
});

qInput.addEventListener('keydown', function(e) {
  if (!suggBox.classList.contains('open')) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, currentSuggestions.length - 1);
    renderSuggestions();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectSuggestion(activeIdx >= 0 ? activeIdx : 0);
  } else if (e.key === 'Escape') {
    closeSugg();
  }
});

qInput.addEventListener('focus', function() {
  if (window.matchMedia('(max-width: 768px)').matches) { openSearchOverlay(qInput); return; }
  if (currentSuggestions.length) openSugg();
});

document.addEventListener('click', function(e) {
  if (overlaySourceInput) return;
  if (!e.target.closest('.search-wrap')) closeSugg();
});

var pcInput = document.getElementById('pc-input');
pcInput.addEventListener('focus', function() { openSearchOverlay(pcInput); });
pcInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') searchPostcode();
});

document.getElementById('search-back-btn').addEventListener('click', closeSearchOverlay);

overlayInput.addEventListener('input', function() {
  if (overlaySourceInput === pcInput) return;
  var q = overlayInput.value.trim();
  clearTimeout(suggestTimer);
  if (!q) { currentSuggestions = []; overlaySugg.innerHTML = ''; return; }
  suggestTimer = setTimeout(function() { fetchSuggest(q); }, 180);
});

overlayInput.addEventListener('keydown', function(e) {
  if (overlaySourceInput === pcInput) {
    if (e.key === 'Enter') searchPostcode();
    if (e.key === 'Escape') closeSearchOverlay();
    return;
  }
  if (e.key === 'Escape') { closeSearchOverlay(); return; }
  if (!currentSuggestions.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, currentSuggestions.length - 1);
    renderSuggestions();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectSuggestion(activeIdx >= 0 ? activeIdx : 0);
  }
});
document.getElementById('pc-year').textContent = new Date().getFullYear();

async function run(lng, lat, label) {
  center = [lng, lat];
  setStatus('Loading isochrones\u2026');

  if (marker) map.removeLayer(marker);
  var markerFill = isDark ? '#fff' : '#1a1a1a';
  var markerRing = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)';
  marker = L.circleMarker([lat, lng], { radius: 6, fillColor: markerFill, fillOpacity: 1, color: markerRing, weight: 8 }).addTo(map);

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
      var a = areas[m];
      if (a !== undefined && a > 0) { el.textContent = a >= 1 ? Math.round(a) + ' km\u00B2' : (a * 1000).toFixed(0) + ' m\u00B2'; el.classList.remove('empty'); }
      else { el.textContent = '\u2014'; el.classList.add('empty'); }
    });

    setStatus(label || lat.toFixed(4) + '\u00B0N, ' + lng.toFixed(4) + '\u00B0E');
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
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
}

placeDefaultMarker();
