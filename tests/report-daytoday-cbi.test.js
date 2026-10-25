'use strict';

const assert = require('assert/strict');
const moment = require('moment');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

const HOUR = 60 * 60 * 1000;
const DAY = '2025-01-01';
const START = Date.parse(DAY + 'T00:00:00.000Z');
const LAST_READING = 23 * HOUR + 55 * 60 * 1000;

describe('day-to-day report: circulating basal insulin (CBI)', function () {
  let env;
  let state;
  let priorD3;

  beforeEach(function () {
    priorD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body><div id="daytodaycharts"></div></body></html>');
    state = domGlobals.installDomGlobals(env);
    env.window.moment = moment;
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/report_plugins/daytoday')];
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  function loopStatus (hours, iob, cbi) {
    const mills = START + hours * HOUR;
    return {
      mills: mills
      , loop: { iob: { timestamp: new Date(mills).toISOString(), iob: iob, basaliob: cbi } }
    };
  }

  function render (devicestatus, options) {
    const ctx = { moment: moment, language: { translate: v => v } };
    const plugins = { iob: require('../lib/plugins/iob')(ctx), cob: require('../lib/plugins/cob')(ctx) };
    const profile = {
      applyTimezone: value => moment.utc(value)
      , loadData: function () {}
      , parseInTimezone: value => moment.utc(value)
      , updateTreatments: function () {}
    };
    env.window.Nightscout = {
      client: {
        plugins: name => plugins[name]
        , profilefunctions: { activeProfileToTime: () => 'Default', profileSwitchName: name => name }
        , sbx: { data: { profile: profile } }
        , settings: { timeFormat: 24 }
        , ticks: () => []
        , tooltip: global.d3.select(env.document.body).append('div')
        , translate: value => value
        , utils: { scaleMgdl: value => value, roundBGForDisplay: value => value }
      }
      , predictions: { offset: 0 }
      , report_plugins: {
        consts: { SCALE_LOG: 'log' }
        , utils: { localeDate: value => value, scaledTreatmentBG: () => 100 }
      }
    };
    const day = {
      dailyCarbs: 0
      , dailyFat: 0
      , dailyProtein: 0
      , devicestatus: devicestatus
      , sgv: [0, LAST_READING].map(offset => ({
        color: 'green', date: new Date(START + offset), mills: START + offset, sgv: 120, type: 'sgv'
      }))
      , treatments: []
    };
    const datastorage = {
      alldays: 1
      , combobolusTreatments: []
      , devicestatus: devicestatus
      , profiles: []
      , profileSwitchTreatments: []
      , tempbasalTreatments: []
      , treatments: []
    };
    datastorage[DAY] = day;

    require('../lib/report_plugins/daytoday')().report(datastorage, [DAY], Object.assign({
      basal: false, bgcheck: false, carbs: false, cbi: false, cob: false, food: false, height: 250, insulin: false
      , insulindistribution: false, iob: false, maxCarbsValue: 20, maxDailyCarbsValue: 1, maxInsulinValue: 1
      , notes: false, openAps: false, othertreatments: false, predicted: false, raw: false, scale: 'linear'
      , targetHigh: 180, targetLow: 80, width: 800
    }, options));
  }

  function cbiLines () {
    return Array.from(env.document.querySelectorAll('#daytodaychart-' + DAY + ' svg polyline'))
      .filter(line => line.getAttribute('stroke') === 'darkorange');
  }

  it('draws an orange CBI line from Loop devicestatus', function () {
    render([loopStatus(1, 1.5, 0.4), loopStatus(1.5, 1.4, 0.5), loopStatus(2, 1.3, 0.6)], { cbi: true });

    const lines = cbiLines();
    assert.equal(lines.length, 1);
    const pts = lines[0].getAttribute('points');
    assert.ok(!/NaN/.test(pts), pts);
    assert.ok(/^[0-9.]+,[0-9.]+( [0-9.]+,[0-9.]+)+$/.test(pts), 'points must be "x,y x,y" with no stray commas: ' + pts);
  });

  it('scales CBI on its own so small changes are visible, and labels the range', function () {
    render([loopStatus(1, 9, 0.90), loopStatus(1.5, 9, 0.60), loopStatus(2, 9, 0.80)], { cbi: true, maxInsulinValue: 10 });

    const ys = cbiLines()[0].getAttribute('points').split(/[ ,]/).filter(Boolean)
      .filter((value, index) => index % 2 === 1).map(Number);
    assert.ok(Math.max.apply(null, ys.slice(0, 3)) - Math.min.apply(null, ys.slice(0, 3)) > 10, 'line must not be flat: ' + ys);
    const label = Array.from(env.document.querySelectorAll('#daytodaychart-' + DAY + ' svg text')).map(t => t.textContent);
    assert.ok(label.includes('CBI 0.80U (0.60–0.90)'), label.join('|'));
  });

  it('does not draw the CBI line when the option is off', function () {
    render([loopStatus(1, 1.5, 0.4)], { cbi: false });

    assert.equal(cbiLines().length, 0);
  });

  it('does not draw a CBI line when the devicestatus carries no CBI', function () {
    render([loopStatus(1, 1.5, undefined)], { cbi: true });

    assert.equal(cbiLines().length, 0);
  });
});
