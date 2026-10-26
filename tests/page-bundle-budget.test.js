'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {entries, output, measure} = require('../tools/measure-page-bundles');

// Measured prototype d79b8a74 with Node 22.23.2/24.20.0 zlib level 9:
// 332151/53156/7923/6665/5306/61784 bytes; 405201 across application entries.
// Re-measured on b8ff91cb, after merging dev eb72a1d3 (opt-in modern theme, #8831), with Node
// 24.22.1: 341123/50948/7923/7017/5285/61736 bytes; 412296 across application
// entries, against 506304 for dev's single bundle.app.js. App and total keep their
// earlier allowances (7849 and about 4800 bytes) over that measurement.
// These bounded allowances permit small fixes, not restoring the
// monolithic dashboard. Update only with a reviewed resource measurement.
// AGP/D3 report features measured on patched Node 24.22.1 after removing unused
// Flot pie/fillbetween plugins: 58638 reports / 423281 total gzip bytes.
// Final Modern daily rendering, combined hover and compact treatment rows:
// 61032 reports / 425675 total gzip bytes on patched Node 24.22.1. Static chart
// styles are loaded as CSS. See the modernReportRefinements audit entry.
// Only reports and total allowances increase; other page limits stay fixed.
// Reviewed measurement of the merged branch merge/dev-2026-10-26 (commit 6ae11c60),
// production build, Node 26.12.1 zlib 1.2.12, gzip level 9: app 353512, reports
// 63328, admin 7921, profile 6994, food 5278, clock 61555 bytes; 437033 across
// application entries. The app, reports and total limits are raised to these
// measured sizes. The growth is the merged AI Insights client and the
// patient-clock timezone resolver. The previous limits were set on dev before
// those features; all nine budget tests pass on the unmodified dev bundle.
const limits = {app: 353512, reports: 63328, admin: 8500, profile: 7100, food: 5700, clock: 63000};

describe('Production page bundle resource budgets', function () {
  let measurements;
  before(function () {measurements = measure();});
  for (const entry of entries) {
    it('keeps ' + entry + ' within its measured gzip budget', function () {
      const actual = measurements.bundles[entry].gzipBytes;
      assert.ok(actual <= limits[entry], entry + ': ' + actual + ' gzip bytes exceeds ' + limits[entry]);
    });
  }
  it('does not emit additional JavaScript chunks outside these budgets', function () {
    const emitted = fs.readdirSync(output).filter(name => name.endsWith('.js')).sort();
    assert.deepEqual(emitted, entries.map(entry => 'bundle.' + entry + '.js').sort());
  });
  it('keeps the total for visiting every application page within 437033 gzip bytes', function () {
    assert.ok(measurements.allApplicationGzipBytes <= 437033,
      'All application entries: ' + measurements.allApplicationGzipBytes + ' gzip bytes exceeds 437033');
  });
  it('emits report modules only in the reports entry', function () {
    for (const entry of entries) {
      const map = JSON.parse(fs.readFileSync(path.join(output, 'bundle.' + entry + '.js.map'), 'utf8'));
      const reportSources = map.sources.filter(source => /\/node_modules\/flot\/|\/lib\/report(?:_plugins)?\//.test(source));
      if (entry === 'reports') {
        assert.ok(reportSources.some(source => source.endsWith('/flot/jquery.flot.js')), 'Reports must include the real Flot implementation');
        assert.ok(reportSources.some(source => source.endsWith('/report_plugins/index.js')), 'Reports must include report plugins');
      } else assert.deepEqual(reportSources, [], entry + ' must not contain report code');
    }
  });
});
