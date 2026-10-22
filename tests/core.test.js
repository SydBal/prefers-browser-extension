/*
 * Prefers Checker: core tests. Plain node, no dependencies.
 * Run: node tests/core.test.js
 */
'use strict';

var assert = require('node:assert');
var core = require('../core.js');

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   - ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL - ' + name);
    console.error('       ' + (err && err.message ? err.message : err));
  }
}

function approx(actual, expected, tolerance, what) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    what + ': expected ~' + expected + ', got ' + actual);
}

/* ---------- contrast math ---------- */

var BLACK = { r: 0, g: 0, b: 0 };
var WHITE = { r: 255, g: 255, b: 255 };

test('contrast: black on white is 21', function () {
  approx(core.contrastRatio(BLACK, WHITE), 21, 0.01, 'black/white');
});

test('contrast: same color is 1', function () {
  approx(core.contrastRatio(WHITE, WHITE), 1, 0.001, 'white/white');
  approx(core.contrastRatio(BLACK, BLACK), 1, 0.001, 'black/black');
});

test('contrast: mid grey #777777 on white is about 4.48', function () {
  // #777777 on white is a well-known reference pair: 4.48:1.
  var grey = core.parseColor('#777777');
  approx(core.contrastRatio(grey, WHITE), 4.48, 0.02, '#777/white');
});

test('contrast: mid grey #595959 on white is about 7.0', function () {
  // #595959 on white computes to about 7.0:1.
  var grey = core.parseColor('#595959');
  approx(core.contrastRatio(grey, WHITE), 7.0, 0.05, '#595959/white');
});

test('parseColor handles rgb, rgba, hex and transparent', function () {
  assert.deepStrictEqual(core.parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepStrictEqual(core.parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepStrictEqual(core.parseColor('#0a141e'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepStrictEqual(core.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepStrictEqual(core.parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.strictEqual(core.parseColor('not-a-color'), null);
});

test('compositeOver blends a half-transparent black over white to mid grey', function () {
  var out = core.compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
  approx(out.r, 127.5, 0.01, 'composite r');
  approx(out.g, 127.5, 0.01, 'composite g');
  approx(out.b, 127.5, 0.01, 'composite b');
});

/* ---------- CSS scanning ---------- */

test('scanner finds each of the five features in CSS text', function () {
  var css = [
    '@media (prefers-reduced-motion: reduce) { .a { animation: none; } }',
    '@media (prefers-color-scheme: dark) { .b { background: #000; } }',
    '@media screen and (prefers-contrast: more) { .c { border-width: 2px; } }',
    '@media (prefers-reduced-transparency: reduce) { .d { backdrop-filter: none; } }',
    '@media (prefers-reduced-data: reduce) { .e { background-image: none; } }',
    '@media (forced-colors: active) { .f { border: 1px solid ButtonText; } }'
  ].join('\n');
  var counts = core.scanCssText(css);
  assert.strictEqual(counts.motion, 1);
  assert.strictEqual(counts.scheme, 1);
  assert.strictEqual(counts.contrast, 1);
  assert.strictEqual(counts.transparency, 1);
  assert.strictEqual(counts.data, 1);
  assert.strictEqual(counts.forcedColors, 1);
});

test('scanner ignores unrelated media queries', function () {
  var css = [
    '@media (min-width: 600px) { .a { display: flex; } }',
    '@media print { .b { display: none; } }',
    '@media (hover: hover) { .c { opacity: 0.9; } }',
    '@media (prefers-reduced-motion: no-preference) { .d { scroll-behavior: smooth; } }'
  ].join('\n');
  var counts = core.scanCssText(css);
  // Only the real feature mention counts, and it is motion (even as a
  // no-preference query, the feature is being addressed).
  assert.strictEqual(counts.motion, 1);
  assert.strictEqual(counts.scheme, 0);
  assert.strictEqual(counts.contrast, 0);
  assert.strictEqual(counts.transparency, 0);
  assert.strictEqual(counts.data, 0);
});

test('weight classification thresholds', function () {
  assert.strictEqual(core.classifyWeight(500 * 1024), 'light');
  assert.strictEqual(core.classifyWeight(2 * 1024 * 1024), 'moderate');
  assert.strictEqual(core.classifyWeight(5 * 1024 * 1024), 'heavy');
});

/* ---------- evidence enrichment ---------- */

function rawFixture(overrides) {
  var raw = {
    url: 'https://example.com/',
    title: 'Example',
    matchMedia: {
      motionReduce: false, schemeLight: true, schemeDark: false,
      contrastMore: false, contrastLess: false,
      transparencyReduce: false, dataReduce: false
    },
    sheets: { accessible: 2, inaccessible: 1 },
    mediaTexts: [],
    colorSchemeProp: false,
    metaColorScheme: false,
    animationsRunning: 0,
    colors: { bodyBg: 'rgb(255, 255, 255)', bodyColor: 'rgb(0, 0, 0)', rootBg: 'rgba(0, 0, 0, 0)', rootColor: 'rgb(0, 0, 0)' },
    samples: [],
    unmeasurableSamples: 0,
    transparency: { backdropCount: 0, translucentCount: 0, examined: 100 },
    data: { totalBytes: 400 * 1024, resourceCount: 12, imageCount: 3, videoCount: 0, autoplayCount: 0 }
  };
  Object.keys(overrides || {}).forEach(function (k) { raw[k] = overrides[k]; });
  return core.enrichEvidence(raw);
}

/* ---------- scoring: motion ---------- */

test('motion: rules plus animations stopping under reduce is a pass', function () {
  var base = rawFixture({ mediaTexts: ['(prefers-reduced-motion: reduce)'], animationsRunning: 4 });
  var states = { motionReduce: rawFixture({ animationsRunning: 0 }) };
  var v = core.scorers.motion(base, states);
  assert.strictEqual(v.status, 'pass');
});

test('motion: animations persist under reduce with no rules is a fail', function () {
  var base = rawFixture({ animationsRunning: 3 });
  var states = { motionReduce: rawFixture({ animationsRunning: 2 }) };
  var v = core.scorers.motion(base, states);
  assert.strictEqual(v.status, 'fail');
});

test('motion: rules exist but animations persist is partial', function () {
  var base = rawFixture({ mediaTexts: ['(prefers-reduced-motion: reduce)'], animationsRunning: 3 });
  var states = { motionReduce: rawFixture({ animationsRunning: 1 }) };
  var v = core.scorers.motion(base, states);
  assert.strictEqual(v.status, 'partial');
});

test('motion: no animations at all is a pass with the nothing-to-reduce note', function () {
  var base = rawFixture({ animationsRunning: 0 });
  var v = core.scorers.motion(base, null);
  assert.strictEqual(v.status, 'pass');
  assert.ok(/nothing to reduce/i.test(v.evidence), 'evidence mentions nothing to reduce: ' + v.evidence);
});

test('motion: instant-only with rules is unknown', function () {
  var base = rawFixture({ mediaTexts: ['(prefers-reduced-motion: reduce)'], animationsRunning: 2 });
  var v = core.scorers.motion(base, null);
  assert.strictEqual(v.status, 'unknown');
});

/* ---------- scoring: color scheme ---------- */

test('scheme: colors change between dark and light emulation is a pass', function () {
  var base = rawFixture({});
  var dark = rawFixture({});
  dark.colors = { bodyBg: 'rgb(10, 10, 12)', bodyColor: 'rgb(240, 240, 240)', rootBg: 'rgb(10, 10, 12)', rootColor: 'rgb(240, 240, 240)' };
  var light = rawFixture({});
  var v = core.scorers.scheme(base, { schemeDark: dark, schemeLight: light });
  assert.strictEqual(v.status, 'pass');
});

test('scheme: declared support but no color change is partial', function () {
  var base = rawFixture({ metaColorScheme: true });
  var dark = rawFixture({});
  var light = rawFixture({});
  var v = core.scorers.scheme(base, { schemeDark: dark, schemeLight: light });
  assert.strictEqual(v.status, 'partial');
});

test('scheme: no indicators and no change is a fail', function () {
  var base = rawFixture({});
  var dark = rawFixture({});
  var light = rawFixture({});
  var v = core.scorers.scheme(base, { schemeDark: dark, schemeLight: light });
  assert.strictEqual(v.status, 'fail');
});

/* ---------- scoring: contrast ---------- */

test('contrast: all sampled text passing is a pass', function () {
  var base = rawFixture({
    samples: [{ label: 'p.body-text', fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } }]
  });
  var v = core.scorers.contrast(base, null);
  assert.strictEqual(v.status, 'pass');
});

test('contrast: failing text with no rules is a fail and names the worst offender', function () {
  var base = rawFixture({
    samples: [
      { label: 'p.faint', fg: { r: 180, g: 180, b: 180 }, bg: { r: 255, g: 255, b: 255 } },
      { label: 'p.body-text', fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } }
    ]
  });
  var v = core.scorers.contrast(base, null);
  assert.strictEqual(v.status, 'fail');
  assert.ok(v.evidence.indexOf('p.faint') !== -1, 'evidence names worst offender: ' + v.evidence);
});

test('contrast: failures resolving under emulated more is a pass', function () {
  var bad = [{ label: 'p.faint', fg: { r: 180, g: 180, b: 180 }, bg: { r: 255, g: 255, b: 255 } }];
  var good = [{ label: 'p.faint', fg: { r: 20, g: 20, b: 20 }, bg: { r: 255, g: 255, b: 255 } }];
  var base = rawFixture({ samples: bad });
  var states = { contrastMore: rawFixture({ samples: good }) };
  var v = core.scorers.contrast(base, states);
  assert.strictEqual(v.status, 'pass');
});

/* ---------- scoring: transparency ---------- */

test('transparency: browser refusing to flip emulation is not testable', function () {
  var base = rawFixture({ transparency: { backdropCount: 3, translucentCount: 1, examined: 100 } });
  var reduce = rawFixture({ transparency: { backdropCount: 3, translucentCount: 1, examined: 100 } });
  // matchMedia.transparencyReduce stays false: the flip never happened.
  var v = core.scorers.transparency(base, { transparencyReduce: reduce });
  assert.strictEqual(v.status, 'nottestable');
});

test('transparency: surfaces dropping under reduce is a pass', function () {
  var base = rawFixture({ transparency: { backdropCount: 3, translucentCount: 1, examined: 100 } });
  var reduce = rawFixture({ transparency: { backdropCount: 0, translucentCount: 0, examined: 100 } });
  reduce.matchMedia.transparencyReduce = true;
  var v = core.scorers.transparency(base, { transparencyReduce: reduce });
  assert.strictEqual(v.status, 'pass');
});

test('transparency: surfaces unchanged under reduce with no rules is a fail', function () {
  var base = rawFixture({ transparency: { backdropCount: 2, translucentCount: 0, examined: 100 } });
  var reduce = rawFixture({ transparency: { backdropCount: 2, translucentCount: 0, examined: 100 } });
  reduce.matchMedia.transparencyReduce = true;
  var v = core.scorers.transparency(base, { transparencyReduce: reduce });
  assert.strictEqual(v.status, 'fail');
});

test('transparency: no surfaces at all is a pass', function () {
  var base = rawFixture({});
  var v = core.scorers.transparency(base, null);
  assert.strictEqual(v.status, 'pass');
});

/* ---------- scoring: data ---------- */

test('data: heavy page with no rules is a fail', function () {
  var base = rawFixture({
    data: { totalBytes: 6 * 1024 * 1024, resourceCount: 90, imageCount: 40, videoCount: 2, autoplayCount: 1 }
  });
  var v = core.scorers.data(base, null);
  assert.strictEqual(v.status, 'fail');
});

test('data: light page with no rules is partial', function () {
  var base = rawFixture({});
  var v = core.scorers.data(base, null);
  assert.strictEqual(v.status, 'partial');
});

test('data: rules plus moderate weight is a pass', function () {
  var base = rawFixture({
    mediaTexts: ['(prefers-reduced-data: reduce)'],
    data: { totalBytes: 2 * 1024 * 1024, resourceCount: 30, imageCount: 5, videoCount: 0, autoplayCount: 0 }
  });
  var v = core.scorers.data(base, null);
  assert.strictEqual(v.status, 'pass');
});

/* ---------- aggregation ---------- */

test('evaluateAll plus summarize counts passes', function () {
  var base = rawFixture({
    mediaTexts: ['(prefers-reduced-motion: reduce)', '(prefers-reduced-data: reduce)'],
    animationsRunning: 0,
    samples: [{ label: 'p.x', fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } }]
  });
  var verdicts = core.evaluateAll(base, null);
  var summary = core.summarize(verdicts);
  // motion pass (nothing animating), contrast pass, transparency pass
  // (no surfaces), data pass (rules declared, light page), scheme
  // unknown -> 4 handled.
  assert.strictEqual(summary.handled, 4);
  assert.strictEqual(summary.text, 'Handles 4 of 5 preferences');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
