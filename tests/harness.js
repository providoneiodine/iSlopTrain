/*
 * Loads the app's classic scripts into a Node sandbox, in the same order as
 * index.html, and returns the IST namespace. Only the logic layers are loaded
 * (core, render, components, drills, sessions); app.js and js/ui/ build the
 * DOM at load time and aren't needed for these tests.
 *
 * The browser globals are minimal stand-ins: enough for the scripts to load
 * and for pure logic to run. Nothing here draws.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const STOP = /^js\/(app\.js|ui\/)/;

function scripts() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((s) => !STOP.test(s));
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/**
 * A 2D context that accepts every call and draws nothing, so drills can run
 * their render code headless. Reads of unset properties return a no-op
 * function (that's what the drawing methods are); the few values code reads
 * back have defaults.
 */
function mockContext2D(canvas) {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const state = {
    canvas, globalAlpha: 1, lineWidth: 1, font: '10px sans-serif', letterSpacing: '0px', fillStyle: '#000', strokeStyle: '#000',
    measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => gradient, createRadialGradient: () => gradient, createConicGradient: () => gradient, createPattern: () => ({}),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    isPointInPath: () => false, getLineDash: () => [], getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return new Proxy(state, { get: (t, k) => (k in t ? t[k] : noop) });
}

/** A DOM element stand-in that records its event listeners (so tests can send pointer events). */
function mockElement() {
  const listeners = {};
  const el = {
    style: {}, width: 1280, height: 720, clientWidth: 1280, clientHeight: 720, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
    removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
    dispatch: (type, e) => (listeners[type] || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, pointerId: 1 }, e))),
    setPointerCapture() {}, releasePointerCapture() {}, append() {}, appendChild() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    listeners,
  };
  let ctx = null;
  el.getContext = () => ctx || (ctx = mockContext2D(el));
  return el;
}

/** A fresh sandbox each call. Pass o.localStorage to keep saved data across loads (a "reload"), o.fetch to serve requests. */
function load(o) {
  o = o || {};
  const noop = () => {};
  const byId = {};
  const sandbox = {
    console,
    performance,
    localStorage: o.localStorage || memoryStorage(),
    navigator: { getGamepads: () => [] },
    document: {
      getElementById: (id) => byId[id] || (byId[id] = mockElement()),
      createElement: mockElement,
      querySelector: () => mockElement(),
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
      hidden: false,
    },
    addEventListener: noop,
    removeEventListener: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
    TextDecoder,
    TextEncoder,
    fetch: o.fetch, // undefined unless a test serves the network
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const src of scripts()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), sandbox, { filename: src });
  }
  docs.set(sandbox.IST, sandbox.document);
  return sandbox.IST;
}

const docs = new WeakMap();
/** The mock element a loaded app knows by this id (e.g. 'stage', the drill canvas). */
const element = (IST, id) => docs.get(IST).getElementById(id);

module.exports = { load, scripts, memoryStorage, mockContext2D, element };
