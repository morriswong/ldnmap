var MAPBOX_TOKEN = '__MAPBOX_TOKEN__';
var OS_TOKEN = '__OS_TOKEN__';
mapboxgl.accessToken = MAPBOX_TOKEN;
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

function buildStyleUrl(dark) {
  return 'mapbox://styles/mapbox/' + (dark ? 'dark-v11' : 'streets-v12');
}
function whenStyleReady(fn) {
  if (map.isStyleLoaded()) { fn(); } else { map.once('style.load', fn); }
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
    .catch(function() {
      fetch('https://api.postcodes.io/postcodes/' + pc.replace(/\s+/g, ''))
        .then(function(res) { return res.json(); })
        .then(function(data) {
          var pcSt = document.getElementById('pc-st');
          if (pcSt) pcSt.classList.remove('is-loading');
          if (data.status === 200 && data.result && data.result.latitude) {
            if (pendingPlace) {
              pendingPlace.lat = data.result.latitude;
              pendingPlace.lng = data.result.longitude;
            }
            var ctaBtn = document.getElementById('postcode-cta-btn');
            if (ctaBtn) ctaBtn.disabled = false;
            map.flyTo({ center: [data.result.longitude, data.result.latitude], zoom: 14 });
            setStatus('Boundary unavailable — showing postcode centre', false);
          } else {
            setStatus('Postcode lookup failed.', true);
          }
        })
        .catch(function() {
          var pcSt = document.getElementById('pc-st');
          if (pcSt) pcSt.classList.remove('is-loading');
          setStatus('Postcode lookup failed.', true);
        });
    });
}

function renderPostcode(geo, pc) {
  if (postcodeLayer) {
    if (map.getLayer('postcode-fill')) map.removeLayer('postcode-fill');
    if (map.getLayer('postcode-line')) map.removeLayer('postcode-line');
    if (map.getSource('postcode'))     map.removeSource('postcode');
    postcodeLayer = null;
  }
  whenStyleReady(function() {
    map.addSource('postcode', { type: 'geojson', data: geo });
    map.addLayer({ id: 'postcode-fill', type: 'fill', source: 'postcode',
      paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'postcode-line', type: 'line', source: 'postcode',
      paint: { 'line-color': '#8b5cf6', 'line-width': 2.5, 'line-opacity': 1 } });
    postcodeLayer = geo;

    var bounds = geojsonBounds(geo);
    if (bounds) {
      map.fitBounds(bounds, { padding: { top: 24, right: 24, bottom: 24, left: 24 }, maxZoom: 16 });
      var ctr = bounds.getCenter();
      if (pendingPlace && pendingPlace.postcode) {
        pendingPlace.lat = ctr.lat;
        pendingPlace.lng = ctr.lng;
        var ctaBtn = document.getElementById('postcode-cta-btn');
        if (ctaBtn) ctaBtn.disabled = false;
      }
    }

    var pcStEl = document.getElementById('pc-st');
    if (pcStEl) { pcStEl.textContent = ''; pcStEl.classList.remove('is-loading'); }
  });
}

setState('idle');

function toggleTheme() {
  isDark = !isDark;
  document.body.classList.toggle('light', !isDark);
  var iconHtml = isDark
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
  var fab = document.getElementById('theme-icon-fab');
  if (fab) fab.innerHTML = iconHtml;
  map.once('style.load', function() {
    rehydrateLayers();
    updateMarkerColor();
  });
  map.setStyle(buildStyleUrl(isDark));
}

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

function addIsoLayer(feature, color) {
  var mins = feature.properties.contour;
  var sid  = 'iso-' + mins;
  if (map.getSource(sid)) return;
  map.addSource(sid, { type: 'geojson', data: feature });
  map.addLayer({ id: isoFillId(mins), type: 'fill', source: sid,
    paint: { 'fill-color': color, 'fill-opacity': 0.18 } });
  map.addLayer({ id: isoLineId(mins), type: 'line', source: sid,
    paint: { 'line-color': color, 'line-width': 3.5, 'line-opacity': 0.9 } });
  isoLayers.push({ minutes: mins, sourceId: sid, data: feature });
}

function removeAllIsoLayers() {
  isoLayers.forEach(function(l) {
    var m = l.minutes;
    if (map.getLayer(isoFillId(m)))  map.removeLayer(isoFillId(m));
    if (map.getLayer(isoLineId(m)))  map.removeLayer(isoLineId(m));
    if (map.getSource(l.sourceId))   map.removeSource(l.sourceId);
  });
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

function rehydrateLayers() {
  var saved = isoLayers.slice();
  isoLayers = [];
  saved.forEach(function(l) {
    var color = COLORS[MINS.indexOf(l.minutes)] || '#888';
    addIsoLayer(l.data, color);
  });
  if (selectedMin !== null) updateIsoHighlight();

  if (postcodeLayer) {
    var geo = postcodeLayer;
    postcodeLayer = null;
    map.addSource('postcode', { type: 'geojson', data: geo });
    map.addLayer({ id: 'postcode-fill', type: 'fill', source: 'postcode',
      paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'postcode-line', type: 'line', source: 'postcode',
      paint: { 'line-color': '#8b5cf6', 'line-width': 2.5, 'line-opacity': 1 } });
    postcodeLayer = geo;
  }

  if (stationsData) addStationsLayer(stationsData); // [stations]
}

function isoFitPadding() {
  return window.innerWidth <= 768
    ? { top: 60, right: 24, bottom: 200, left: 24 }
    : { top: 60, right: 24, bottom: 100, left: 340 };
}
function fitIsochroneBounds() {
  if (!isoLayers.length) return;
  var bounds = geojsonBounds(isoLayers[0].data);
  if (bounds) map.fitBounds(bounds, { padding: isoFitPadding(), maxZoom: 14 });
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
  removeAllIsoLayers();
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

function changeMode() {
  removeAllIsoLayers();
  clearStations(); // [stations]
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
  removeAllIsoLayers();
  clearStations(); // [stations]
  pendingPlace = null;
  resetBucketSelection();
  setState('idle');
  clearPermalink(); // [permalink]
}

function closePostcodeChip() {
  hidePostcodeChip();
  clearStations(); // [stations]
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
  var ctaBtn = document.getElementById('postcode-cta-btn');
  if (ctaBtn) ctaBtn.disabled = true;
  document.getElementById('postcode-chip').classList.add('postcode-chip-active');
  document.body.classList.add('postcode-chip-showing');
  postcodeChipVisible = true;
}

function hidePostcodeChip() {
  document.getElementById('postcode-chip').classList.remove('postcode-chip-active');
  document.body.classList.remove('postcode-chip-showing');
  postcodeChipVisible = false;
  if (postcodeLayer) {
    if (map.getLayer('postcode-fill')) map.removeLayer('postcode-fill');
    if (map.getLayer('postcode-line')) map.removeLayer('postcode-line');
    if (map.getSource('postcode'))     map.removeSource('postcode');
    postcodeLayer = null;
  }
}

function chipBack() {
  modePickerBack();
}

function launchFromPostcode(modeKey) {
  if (!pendingPlace) return;
  hidePostcodeChip();
  mode = modeKey;
  updateModeButtons();
  setState('travel');
  run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
}
function launchFromPostcodeDefault() {
  mode = 'walking';
  launchFromPostcode('walking');
}
function copyPostcode() {
  if (!pendingPlace || !pendingPlace.postcode) return;
  var pc = pendingPlace.postcode;
  var btn = document.getElementById('pc-copy-btn');
  navigator.clipboard.writeText(pc).then(function() {
    if (!btn) return;
    btn.classList.add('pc-copy-btn--copied');
    setTimeout(function() { if (btn) btn.classList.remove('pc-copy-btn--copied'); }, 1800);
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = pc;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
    if (btn) {
      btn.classList.add('pc-copy-btn--copied');
      setTimeout(function() { if (btn) btn.classList.remove('pc-copy-btn--copied'); }, 1800);
    }
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

function launchRecentSearch(idx) {
  var recent = getRecentSearches();
  var r = recent[idx];
  if (!r) return;
  closeSearchOverlay();
  if (r.type === 'place') {
    pendingPlace = { lng: r.lng, lat: r.lat, name: r.name, address: r.address, postcode: r.postcode };
    lastSearchQuery = r.name;
    map.flyTo({ center: [r.lng, r.lat], zoom: 12, duration: 1000 });
    placeMarker(r.lat, r.lng);
    setStatus(r.name);
    if (r.postcode) {
      showPostcodeChip();
      searchPostcode(r.postcode);
      setState('modepicker');
    } else {
      mode = mode || 'walking';
      updateModeButtons();
      setState('travel');
      run(r.lng, r.lat, r.name);
    }
  } else {
    pendingPlace = { lng: 0, lat: 0, name: r.postcode, address: 'UK postcode boundary', postcode: r.postcode };
    showPostcodeChip();
    searchPostcode(r.postcode);
    setState('modepicker');
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
    pendingPlace = { lng: 0, lat: 0, name: s.postcode, address: 'UK postcode boundary', postcode: s.postcode };
    saveRecentSearch({ type: 'postcode', name: s.postcode, address: 'UK postcode', postcode: s.postcode });
    showPostcodeChip();
    searchPostcode(s.postcode);
    setState('modepicker');
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
      pendingPlace = { lng: c[0], lat: c[1], name: name, address: address, postcode: postcode };
      saveRecentSearch({ type: 'place', name: name, address: address, lat: c[1], lng: c[0], postcode: postcode });
      map.flyTo({ center: [c[0], c[1]], zoom: 12, duration: 1000 });
      placeMarker(c[1], c[0]);
      setStatus(name);
      if (pendingPlace.postcode) {
        showPostcodeChip();
        searchPostcode(pendingPlace.postcode);
        setState('modepicker');
      } else {
        mode = mode || 'walking';
        updateModeButtons();
        setState('travel');
        run(pendingPlace.lng, pendingPlace.lat, pendingPlace.name);
      }
      sessionToken = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    } else { setStatus('Could not load that location', true); }
  } catch (e) { setStatus('Search failed', true); }
}

document.getElementById('search-back-btn').addEventListener('click', closeSearchOverlay);

overlayInput.addEventListener('input', function() {
  var q = overlayInput.value.trim();
  clearTimeout(suggestTimer);
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

async function run(lng, lat, label) {
  center = [lng, lat];
  setStatus('Loading isochrones…');
  placeMarker(lat, lng);

  removeAllIsoLayers();
  resetBucketSelection();

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
    whenStyleReady(function() {
      sorted.forEach(function(f) {
        var color = COLORS[MINS.indexOf(f.properties.contour)] || '#888';
        addIsoLayer(f, color);
      });
      fitIsochroneBounds();
    });

    setStatus(label || lat.toFixed(4) + '°N, ' + lng.toFixed(4) + '°E');
    updatePermalink(); // [permalink]
    loadNearbyStations(lat, lng); // [stations]
  } catch(e) { setStatus('Failed to load isochrones', true); }
}

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

// Map a TfL mode array to a single primary mode key + short label.
function stationPrimaryMode(modes) {
  var order = ['tube', 'elizabeth-line', 'dlr', 'overground', 'national-rail', 'tram', 'cable-car', 'river-bus'];
  var m = (modes || []).slice().sort(function(a, b) {
    var ia = order.indexOf(a); var ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  })[0] || 'rail';
  var labels = {
    'tube': 'Tube', 'elizabeth-line': 'Elizabeth', 'dlr': 'DLR',
    'overground': 'Overground', 'national-rail': 'Rail', 'tram': 'Tram',
    'cable-car': 'Cable car', 'river-bus': 'River'
  };
  return { key: m, label: labels[m] || 'Rail' };
}

// Re-rank a raw station list (no dist) against an exact point: compute walk
// distance, sort nearest-first, keep the closest 5. Used for both fresh fetches
// and cache hits, so distances stay accurate even when a cache entry (keyed to a
// rounded coordinate) is reused for a slightly different pin.
function rankStations(list, lat, lng) {
  return (list || []).map(function(s) {
    return {
      name: s.name, lat: s.lat, lng: s.lng, modes: s.modes || [], lines: s.lines || [],
      dist: haversineMetres(lat, lng, s.lat, s.lng)
    };
  }).sort(function(a, b) { return a.dist - b.dist; }).slice(0, 5);
}

var STATION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
function stationCacheKey(lat, lng) {
  // Round to 3 decimals (~110 m grid) so nearby pins share a cache entry.
  return 'st:' + lat.toFixed(3) + ',' + lng.toFixed(3);
}
function readStationCache(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var e = JSON.parse(raw);
    if (Date.now() - e.ts > STATION_CACHE_TTL) { localStorage.removeItem(key); return null; }
    return e.stations || null;
  } catch (e) { return null; }
}
function writeStationCache(key, stations) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), stations: stations })); } catch (e) {}
}

async function loadNearbyStations(lat, lng) {
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
    var d = await r.json();
    var pts = (d && d.stopPoints) || [];
    // Cache the raw (dist-less) list; distances are derived per-render via rankStations.
    var raw = pts.filter(function(s) { return typeof s.lat === 'number' && typeof s.lon === 'number'; })
      .map(function(s) {
        var lines = (s.lines || []).map(function(l) { return l.name; }).filter(Boolean);
        return {
          name: (s.commonName || '').replace(/\s+(Underground|Rail|DLR)\s+Station$/i, '').replace(/\s+Station$/i, ''),
          lat: s.lat, lng: s.lon, modes: s.modes || [], lines: lines
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
    var pm = stationPrimaryMode(st.modes);
    var mins = Math.max(1, Math.round(st.dist / 80));
    var row = document.createElement('div');
    row.className = 'travel-station-row';

    var badge = document.createElement('span');
    badge.className = 'station-badge station-badge-' + pm.key;
    badge.textContent = pm.label;

    var info = document.createElement('div');
    info.className = 'travel-station-info';
    var nameEl = document.createElement('div');
    nameEl.className = 'travel-station-name';
    nameEl.textContent = st.name;
    var metaEl = document.createElement('div');
    metaEl.className = 'travel-station-meta';
    metaEl.textContent = mins + ' min walk · ' + Math.round(st.dist) + ' m';
    info.appendChild(nameEl);
    info.appendChild(metaEl);

    row.appendChild(badge);
    row.appendChild(info);
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
var LAST_VIEW_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    if (!entry || !entry.v || (Date.now() - entry.ts) > LAST_VIEW_TTL) return null;
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
  var url = location.href;
  var btn = document.getElementById('share-btn');
  function feedback() {
    if (!btn) return;
    btn.classList.add('share-btn--copied');
    setTimeout(function() { if (btn) btn.classList.remove('share-btn--copied'); }, 1800);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(feedback).catch(function() { fallbackCopy(url, feedback); });
  } else {
    fallbackCopy(url, feedback);
  }
}

function fallbackCopy(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  if (done) done();
}

// Startup restore — run once after the map and all functions are ready.
whenStyleReady(function() { restoreFromPermalink(); });
/* ===== end permalink ===== */

/* ===== DRAGGABLE BOTTOM SHEET (mobile snap points) ===== */
/* Apple/Google-Maps-style sheet: peek (grabber + title), half (~50%), full (~92%).
   Mobile only (<=768px). On desktop the travel-card keeps its original CSS, so
   we never touch inline transform there. */
(function () {
  var card, grabber, header, slots;
  var snaps = { full: 0, half: 0, compact: 0, peek: 0 };
  var current = 'compact';
  var curT = 0;                 // current translateY in px
  var dragging = false, startY = 0, startT = 0, moved = false, suppressClick = false;

  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function vh() { return (window.visualViewport && window.visualViewport.height) || window.innerHeight; }

  function compute() {
    if (!card) return;
    var H = card.offsetHeight;
    var peekVisible = (header ? header.offsetHeight : 52) + (grabber ? grabber.offsetHeight : 22) + 8;
    // Compact = show everything down through the time slots (title + mode + slots),
    // hiding the stations list. Measured from the slots row so it's exact and
    // independent of whether the stations list has loaded yet.
    var compactVisible = slots ? (slots.offsetTop + slots.offsetHeight + 16) : (peekVisible + 110);
    snaps.full = 0;                                  // top of sheet near top of screen
    snaps.half = Math.max(0, H - vh() * 0.5);        // header sits at ~50%
    snaps.compact = Math.max(0, H - compactVisible); // title + mode + time toggles only
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
  }

  function hide(animate) {
    if (!card) return;
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

  function openSheet() {
    if (!card) return;
    if (!isMobile()) { card.style.transform = ''; return; }
    compute();
    applySnap('compact', true);   // open showing the time toggles, map dominant
  }
  function closeSheet() {
    if (!card) return;
    if (!isMobile()) { card.style.transform = ''; return; }
    hide(true);
  }

  window.__sheet = { open: openSheet, close: closeSheet };

  function init() {
    card = document.getElementById('travel-card');
    grabber = document.getElementById('sheet-grabber');
    header = card ? card.querySelector('.travel-card-header') : null;
    slots = card ? card.querySelector('.travel-slots') : null;
    if (!card || !grabber) return;

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
      if (isMobile() && document.body.dataset.state === 'travel') applySnap(current, false);
      else if (!isMobile()) card.style.transform = '';
    });

    if (isMobile()) hide(false);                     // start parked below the viewport
  }
  init();
})();
/* ===== END DRAGGABLE BOTTOM SHEET ===== */
