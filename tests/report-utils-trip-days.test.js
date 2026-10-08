'use strict';

/*
 * The report helpers on a real trip, with only the pump time zone history
 * Loop wrote into the profiles to go on. The resolver is wired the way the
 * report client wires it: to the profile object that holds the range's
 * history, not to the dashboard's current-profile object.
 */

require('should');

var helper = require('./inithelper')();
var moment = helper.ctx.moment;

function storeProfile (startDate, timezone) {
  return {
    defaultProfile: 'Default'
    , startDate: startDate
    , store: { Default: { dia: 6, carbs_hr: 30, carbratio: 10, sens: 50, basal: 1, timezone: timezone } }
  };
}

// Newest first, as /api/v1/profiles returns them. Israel (UTC+3 in summer)
// to the US east coast, then central, and back; the pump was synced on
// landing each time.
var history = [
  storeProfile('2026-10-06T16:18:00Z', 'ETC/GMT-3') // home clock again
  , storeProfile('2026-10-06T06:08:00Z', 'ETC/GMT-2') // stop-over in Europe
  , storeProfile('2026-09-29T12:00:00Z', 'ETC/GMT+5') // US central, UTC-5
  , storeProfile('2026-09-25T17:07:00Z', 'ETC/GMT+4') // US east, UTC-4
  , storeProfile('2020-01-01T00:00:00Z', 'ETC/GMT-3')
];

describe('report utils: trip days from the pump time zone history', function () {
  var utils;
  var tz;
  var priorWindow;
  var priorNightscout;

  before(function () {
    priorWindow = global.window;
    // the dashboard's profile object: only the current profile, as on the real page
    var dashboardProfile = require('../lib/profilefunctions')(null, helper.ctx);
    dashboardProfile.loadData([history[0]]);
    // the report's profile object, loaded with the range's history
    var rangeProfile = require('../lib/profilefunctions')(null, helper.ctx);
    rangeProfile.loadData(history);

    var settings = { timeDisplay: 'patient', homeTimezone: 'Asia/Jerusalem', timeFormat: 24 };
    tz = require('../lib/client-core/timezone-context')({ moment: moment, settings: settings, profile: dashboardProfile });
    tz.setProfile(rangeProfile); // what reportclient does once the range is loaded

    moment.locale('en');
    global.window = global.window || {};
    global.window.moment = moment;
    priorNightscout = global.window.Nightscout;
    global.window.Nightscout = {
      client: {
        tz: tz
        , settings: settings
        , translate: function (text, options) {
          return text.replace('%1', options && options.params ? options.params[0] : '');
        }
        , sbx: { data: { profile: rangeProfile } }
      }
    };
    delete require.cache[require.resolve('../lib/report_plugins/utils')];
    utils = require('../lib/report_plugins/utils')();
  });

  after(function () {
    delete require.cache[require.resolve('../lib/report_plugins/utils')];
    if (priorWindow === undefined) delete global.window;
    else {
      global.window = priorWindow;
      global.window.Nightscout = priorNightscout;
    }
  });

  var tripDay = '2026-10-04';

  it('a trip day starts at midnight where the patient slept', function () {
    var start = utils.dayStart(tripDay);
    start.toISOString().should.equal('2026-10-04T05:00:00.000Z'); // midnight UTC-5
    start.utcOffset().should.equal(-300);
  });

  it('a 7:00 breakfast on the trip reads 7:00, not the home or browser clock', function () {
    var breakfast = moment.utc('2026-10-04T12:00:00Z').valueOf(); // 07:00 in UTC-5
    // Loop uploads UTC timestamps with utcOffset 0: no record-level signal
    utils.momentAt(breakfast, { utcOffset: 0 }).format('HH:mm').should.equal('07:00');
    utils.momentAt(breakfast).format('HH:mm').should.equal('07:00');
  });

  it('labels the day with the date and a Trip badge naming the zone and the difference from home', function () {
    var info = utils.dayTimezone(tripDay, { treatments: [], sgv: [] });
    info.away.should.equal(true);
    info.label.should.equal('UTC-5');
    info.difference.should.equal(-480);

    utils.localeDate(tripDay).should.equal('Sunday 10/04/2026');
    var badge = utils.travelBadge({ timezone: info });
    badge.should.containEql('Trip');
    badge.should.containEql('UTC-5, 8h behind home');
  });

  it('every day from the first pump change until the zone is set back is a trip day', function () {
    ['2026-09-25', '2026-09-26', '2026-09-29', '2026-10-05'].forEach(function (day) {
      utils.dayTimezone(day, { treatments: [], sgv: [] }).away.should.equal(true, day);
    });
    // the fly-home day already reads in home's clock
    utils.dayStart('2026-10-06').toISOString().should.equal('2026-10-05T21:00:00.000Z');
  });

  it('days at home are not badged and read in home\'s clock', function () {
    ['2026-09-20', '2026-10-07'].forEach(function (day) {
      utils.dayTimezone(day, { treatments: [], sgv: [] }).away.should.equal(false, day);
      utils.travelBadge({ timezone: utils.dayTimezone(day, { treatments: [], sgv: [] }) }).should.equal('');
    });
    utils.dayStart('2026-10-07').toISOString().should.equal('2026-10-06T21:00:00.000Z'); // midnight Israel, UTC+3
  });

  it('without the rewiring the dashboard profile hides the trip (the bug being fixed)', function () {
    var dashboardOnly = require('../lib/profilefunctions')(null, helper.ctx);
    dashboardOnly.loadData([history[0]]);
    var broken = require('../lib/client-core/timezone-context')({
      moment: moment, settings: { timeDisplay: 'patient', homeTimezone: 'Asia/Jerusalem' }, profile: dashboardOnly
    });
    broken.isAwayAt(moment.utc('2026-10-04T12:00:00Z').valueOf(), null).should.equal(false);
    broken.momentAt(moment.utc('2026-10-04T12:00:00Z').valueOf(), null).format('HH:mm').should.equal('15:00');
  });
});
