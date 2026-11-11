// A stand-in browser for app.js: just enough DOM, Mapbox GL and fetch to run the page's
// script in Node and watch what it does to the map. Used by tests/app.test.mjs.
// The map stub is strict where Mapbox is: adding a source or layer that already exists throws.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

class ClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

class El {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.text = '';
    this.html = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.offsetHeight = 0;
    this.offsetTop = 0;
    this.offsetWidth = 0;
    this.scrollTop = 0;
    this.stubs = {};
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.text = String(v); }
  get innerHTML() { return this.html; }
  set innerHTML(v) { this.children = []; this.text = ''; this.html = String(v); this.stubs = {}; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev || { preventDefault() {}, target: this })); }
  focus() {}
  blur() {}
  select() {}
  closest() { return null; }
  descendants() { return this.children.flatMap((c) => [c, ...(c.descendants ? c.descendants() : [])]); }
  // '.a' / '.a.b' against built children; markup set through innerHTML isn't parsed, so a
  // selector that finds nothing gets a placeholder element (one per selector).
  matches(sel) {
    const cls = sel.trim().split(/\s+/).pop().split('.').filter(Boolean);
    return this.descendants().filter((d) => d.classList && cls.every((c) => d.classList.contains(c)));
  }
  querySelector(sel) {
    return this.matches(sel)[0] || (this.stubs[sel] = this.stubs[sel] || new El('div'));
  }
  querySelectorAll(sel) { return this.matches(sel); }
}

function textNode(t) { const n = new El('#text'); n.text = String(t); return n; }

class LngLatBounds {
  constructor(sw, ne) { this.w = sw[0]; this.s = sw[1]; this.e = ne[0]; this.n = ne[1]; }
  extend(c) {
    this.w = Math.min(this.w, c[0]); this.e = Math.max(this.e, c[0]);
    this.s = Math.min(this.s, c[1]); this.n = Math.max(this.n, c[1]);
    return this;
  }
  getCenter() { return { lng: (this.w + this.e) / 2, lat: (this.s + this.n) / 2 }; }
  getWest() { return this.w; } getEast() { return this.e; } getSouth() { return this.s; } getNorth() { return this.n; }
  contains(c) { return c[0] >= this.w && c[0] <= this.e && c[1] >= this.s && c[1] <= this.n; }
}

class FakeMap {
  constructor() {
    this.sources = {};
    this.layers = [];
    this.handlers = {};      // type → [{ fn, once }]
    this.styleLoaded = true;
    this.styles = [];        // every setStyle() url
    this.calls = [];         // camera moves: { name, options }
    this.padding = { top: 0, right: 0, bottom: 0, left: 0 };
    this.zoom = 13;
    this.center = { lng: -0.1246, lat: 51.5007 };
    this.container = new El('div');
    this.container.clientWidth = 1280;
    this.container.clientHeight = 800;
    this.canvas = new El('canvas');
  }
  addControl() {}
  on(type, a, b) { if (!b) (this.handlers[type] = this.handlers[type] || []).push({ fn: a }); }
  once(type, fn) { (this.handlers[type] = this.handlers[type] || []).push({ fn, once: true }); }
  off(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter((h) => h.fn !== fn); }
  fire(type, ev) {
    const hs = this.handlers[type] || [];
    this.handlers[type] = hs.filter((h) => !h.once);
    hs.filter((h) => !h.once).concat(hs.filter((h) => h.once)).forEach((h) => h.fn(ev || {}));
  }
  listenerCount(type) { return (this.handlers[type] || []).length; }
  isStyleLoaded() { return this.styleLoaded; }
  // Like Mapbox: the old style's sources and layers go at once, the new style arrives later.
  setStyle(url) { this.styles.push(url); this.sources = {}; this.layers = []; this.styleLoaded = false; }
  finishStyle() { this.styleLoaded = true; this.fire('style.load'); this.fire('idle'); }
  getStyle() { return { layers: [] }; }
  getSource(id) { return this.sources[id]; }
  addSource(id, def) {
    if (this.sources[id]) throw new Error('There is already a source with ID "' + id + '"');
    this.sources[id] = { def, setData(d) { def.data = d; } };
  }
  removeSource(id) { delete this.sources[id]; }
  getLayer(id) { return this.layers.find((l) => l.id === id); }
  addLayer(layer) {
    if (this.getLayer(layer.id)) throw new Error('Layer "' + layer.id + '" already exists');
    if (!this.sources[layer.source]) throw new Error('Source "' + layer.source + '" not found');
    this.layers.push(layer);
  }
  removeLayer(id) { this.layers = this.layers.filter((l) => l.id !== id); }
  layerIds() { return this.layers.map((l) => l.id); }
  setPaintProperty() {}
  setFilter() {}
  resize() {}
  getContainer() { return this.container; }
  getCanvas() { return this.canvas; }
  getCenter() { return this.center; }
  getZoom() { return this.zoom; }
  getPadding() { return this.padding; }
  getBounds() { return new LngLatBounds([this.center.lng - 0.05, this.center.lat - 0.03], [this.center.lng + 0.05, this.center.lat + 0.03]); }
  project(c) { return { x: (c[0] - this.center.lng) * 10000 + 640, y: (this.center.lat - c[1]) * 10000 + 400 }; }
  queryRenderedFeatures() { return []; }
  // A padding passed to flyTo/easeTo/jumpTo stays on the map; fitBounds' padding doesn't.
  move(name, o) { this.calls.push({ name, options: o }); if (o && o.padding) this.padding = o.padding; if (o && o.center) this.center = { lng: o.center[0], lat: o.center[1] }; }
  flyTo(o) { this.move('flyTo', o); }
  easeTo(o) { this.move('easeTo', o); }
  jumpTo(o) { this.move('jumpTo', o); }
  fitBounds(b, o) { this.calls.push({ name: 'fitBounds', bounds: b, options: o }); }
}

// A reply for the fake fetch.
export function reply(body, status) {
  const code = status || 200;
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

// A promise settled from outside, for answers that should arrive late.
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Let pending promise callbacks (and zero-delay timers) run.
export function settle() { return new Promise((r) => setTimeout(r, 5)); }

// Four isochrone contours around a point, as the Mapbox API returns them.
export function isochrones(tag) {
  return { features: [5, 10, 15, 20].map((m) => ({
    type: 'Feature', properties: { contour: m, tag: tag || '' },
    geometry: { type: 'Polygon', coordinates: [[[-0.13, 51.49], [-0.11, 51.49], [-0.11, 51.51], [-0.13, 51.51], [-0.13, 51.49]]] }
  })) };
}

// Load parking-rules.js and app.js into a fresh fake browser. `routes` is a list of
// [RegExp, (url) => reply | Promise<reply>]; the first match answers a fetch, and anything
// unmatched gets an empty 404. Returns the script's global scope, with `map` and helpers.
export function loadApp(opts) {
  const o = opts || {};
  const els = {};
  const selectors = {};
  const store = new Map(Object.entries(o.storage || {}));
  const body = new El('body');
  const document = {
    body,
    documentElement: new El('html'),
    copied: [],
    getElementById(id) { return (els[id] = els[id] || new El('div', id)); },
    createElement(tag) { return new El(tag); },
    createTextNode: textNode,
    querySelector(sel) { return (selectors[sel] = selectors[sel] || new El('div')); },
    querySelectorAll() { return []; },
    execCommand(cmd) { if (cmd === 'copy') document.copied.push(body.children[body.children.length - 1].value); return true; }
  };
  const fetched = [];
  const ctx = {
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn) => fn(),
    Intl, URL,
    crypto: { randomUUID: () => 'session-token' },
    navigator: o.navigator || {},
    location: { hash: o.hash || '', hostname: 'ldnmap.test', port: '', pathname: '/', search: '', get href() { return 'https://ldnmap.test/' + this.hash; } },
    history: { replaceState(_s, _t, url) { const i = url.indexOf('#'); ctx.location.hash = i === -1 ? '' : url.slice(i); } },
    localStorage: {
      get length() { return store.size; },
      key(i) { return [...store.keys()][i] || null; },
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); }
    },
    matchMedia: () => ({ matches: !!o.mobile }),
    addEventListener() {},
    innerWidth: o.mobile ? 390 : 1280,
    innerHeight: o.mobile ? 844 : 800,
    fetched,
    fetch(url) {
      fetched.push(String(url));
      const route = (o.routes || []).find((r) => r[0].test(String(url)));
      return Promise.resolve(route ? route[1](String(url)) : reply({}, 404));
    },
    mapboxgl: {
      Map: FakeMap,
      LngLatBounds,
      NavigationControl: class {},
      AttributionControl: class {},
      Marker: class { setLngLat(c) { this.lngLat = c; return this; } addTo() { this.added = true; return this; } remove() { this.added = false; return this; } },
      Popup: class { setLngLat() { return this; } setDOMContent() { return this; } addTo() { return this; } remove() {} }
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const file of ['parking-rules.js', 'app.js']) {
    vm.runInContext(readFileSync(new URL(file, root), 'utf8'), ctx, { filename: file });
  }
  ctx.el = (id) => document.getElementById(id);
  ctx.storage = store;
  return ctx;
}
