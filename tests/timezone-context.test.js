'use strict';

require('should');

var helper = require('./inithelper')();
var moment = helper.ctx.moment;

function profileWith (records) {
  var profile = require('../lib/profilefunctions')(null, helper.ctx);
  profile.loadData(records);
  return profile;
}

function storeProfile (startDate, timezone) {
  var store = { dia: 3, carbs_hr: 30, carbratio: 7, sens: 35 };
  if (timezone) store.timezone = timezone;
  return {
    defaultProfile: 'Default'
    , startDate: startDate
    , store: { Default: store }
  };
}

describe('timezone-context', function () {
  var tzContext = require('../lib/client-core/timezone-context');

  // Winter: Israel UTC+2, Tokyo UTC+9, New York UTC-5
  var winter = moment('2024-01-15T12:00:00Z').valueOf();
  // Summer: Israel UTC+3
  var summer = moment('2024-07-15T12:00:00Z').valueOf();

  function make (settings, profile) {
    return tzContext({ moment: moment, settings: settings || {}, profile: profile || null });
  }

  describe('mode', function () {
    it('defaults to patient time', function () {
      make({}).mode().should.equal('patient');
      make({ timeDisplay: 'nonsense' }).mode().should.equal('patient');
    });

    it('honours TIME_DISPLAY', function () {
      make({ timeDisplay: 'browser' }).mode().should.equal('browser');
      make({ timeDisplay: 'profile' }).mode().should.equal('profile');
    });
  });

  describe('home', function () {
    it('is HOME_TIMEZONE, with daylight saving applied at the instant', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' });
      tz.homeZone().should.equal('Asia/Jerusalem');
      tz.homeOffsetAt(winter).should.equal(120);
      tz.homeOffsetAt(summer).should.equal(180);
    });

    it('falls back to the current profile zone', function () {
      var tz = make({}, profileWith([storeProfile('2020-01-01', 'Europe/Berlin')]));
      tz.homeZone().should.equal('Europe/Berlin');
      tz.homeOffsetAt(winter).should.equal(60);
    });

    it('ignores an unknown HOME_TIMEZONE', function () {
      var tz = make({ homeTimezone: 'Mars/Olympus' }, profileWith([storeProfile('2020-01-01', 'Europe/Berlin')]));
      tz.homeZone().should.equal('Europe/Berlin');
    });

    it('is null with nothing configured', function () {
      (make({}).homeZone() === null).should.equal(true);
      (make({}).homeOffsetAt(winter) === null).should.equal(true);
    });
  });

  describe('recordOffset', function () {
    var tz = make({});

    it('reads a non-zero utcOffset', function () {
      tz.recordOffset({ utcOffset: 540 }).should.equal(540);
      tz.recordOffset({ utcOffset: '-300' }).should.equal(-300);
    });

    it('treats zero as unknown: uploaders send UTC regardless of location', function () {
      (tz.recordOffset({ utcOffset: 0 }) === null).should.equal(true);
    });

    it('is null for a missing or invalid offset', function () {
      (tz.recordOffset({}) === null).should.equal(true);
      (tz.recordOffset({ utcOffset: 'abc' }) === null).should.equal(true);
      (tz.recordOffset(null) === null).should.equal(true);
    });
  });

  describe('patientAt (layered)', function () {
    var history = [
      storeProfile('2024-01-20T00:00:00Z', 'Asia/Jerusalem') // back home
      , storeProfile('2024-01-10T00:00:00Z', 'Asia/Tokyo') // on a trip
      , storeProfile('2020-01-01T00:00:00Z', 'Asia/Jerusalem')
    ];

    it('uses the record offset first', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith(history));
      var resolved = tz.patientAt(winter, { utcOffset: -300 });
      resolved.offset.should.equal(-300);
      resolved.source.should.equal('record');
    });

    it('then the profile in effect at the instant, not the newest one', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith(history));
      var onTrip = tz.patientAt(moment('2024-01-15T12:00:00Z').valueOf(), { utcOffset: 0 });
      onTrip.offset.should.equal(540);
      onTrip.zone.should.equal('Asia/Tokyo');
      onTrip.source.should.equal('profile');

      var before = tz.patientAt(moment('2024-01-05T12:00:00Z').valueOf(), null);
      before.offset.should.equal(120);
      before.zone.should.equal('Asia/Jerusalem');

      var after = tz.patientAt(moment('2024-01-25T12:00:00Z').valueOf(), null);
      after.offset.should.equal(120);
    });

    it('then home', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith([storeProfile('2020-01-01', undefined)]));
      var resolved = tz.patientAt(summer, null);
      resolved.offset.should.equal(180);
      resolved.source.should.equal('home');
    });

    it('is unknown with nothing to go on', function () {
      var resolved = make({}).patientAt(winter, { utcOffset: 0 });
      (resolved.offset === null).should.equal(true);
      resolved.source.should.equal('unknown');
    });
  });

  describe('displayOffsetAt / momentAt', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);

    it('patient mode shows the record wall clock', function () {
      var tz = make({ timeDisplay: 'patient', homeTimezone: 'Asia/Jerusalem' }, profile);
      tz.momentAt(winter, { utcOffset: 540 }).format('HH:mm').should.equal('21:00');
      tz.momentAt(winter, { utcOffset: 0 }).format('HH:mm').should.equal('14:00');
    });

    it('profile mode ignores the record offset', function () {
      var tz = make({ timeDisplay: 'profile', homeTimezone: 'Asia/Jerusalem' }, profile);
      tz.momentAt(winter, { utcOffset: 540 }).format('HH:mm').should.equal('14:00');
    });

    it('browser mode leaves the moment in local time', function () {
      var tz = make({ timeDisplay: 'browser', homeTimezone: 'Asia/Jerusalem' }, profile);
      (tz.displayOffsetAt(winter, { utcOffset: 540 }) === null).should.equal(true);
      tz.momentAt(winter, { utcOffset: 540 }).utcOffset().should.equal(moment(winter).utcOffset());
    });

    it('format() is a shorthand', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      tz.format(winter, 'HH:mm', { utcOffset: 540 }).should.equal('21:00');
    });
  });

  describe('isAwayAt', function () {
    var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]));

    it('is true when the record offset differs from home', function () {
      tz.isAwayAt(winter, { utcOffset: 540 }).should.equal(true);
    });

    it('is false at home, and across the home daylight-saving change', function () {
      tz.isAwayAt(winter, { utcOffset: 120 }).should.equal(false);
      tz.isAwayAt(summer, { utcOffset: 180 }).should.equal(false);
      tz.isAwayAt(summer, { utcOffset: 0 }).should.equal(false);
    });

    it('treats the home zone\'s other daylight-saving offset as home, not travel', function () {
      // Loop re-syncs the pump clock (and so the profile offset) days after a
      // DST change; a fixed GMT+3 in Israel's winter is still Israel.
      tz.isAwayAt(winter, { utcOffset: 180 }).should.equal(false);
      tz.isAwayAt(summer, { utcOffset: 120 }).should.equal(false);
      tz.isAwayAt(winter, { utcOffset: 60 }).should.equal(true);
      tz.isAwayAt(winter, { utcOffset: 240 }).should.equal(true);
    });

    it('is false when nothing is known', function () {
      make({}).isAwayAt(winter, { utcOffset: 540 }).should.equal(false);
    });
  });

  describe('Loop-style fixed-offset profiles (pump time zone)', function () {
    // Loop writes the pump's zone as ETC/GMT+N (IANA sign: GMT+7 is UTC-7)
    var history = [
      storeProfile('2026-10-06T00:00:00Z', 'ETC/GMT-3') // back home, Israel summer time
      , storeProfile('2026-09-20T12:00:00Z', 'ETC/GMT+4') // on a trip, UTC-4
      , storeProfile('2026-03-28T00:00:00Z', 'ETC/GMT-3') // Israel summer time
      , storeProfile('2020-01-01T00:00:00Z', 'ETC/GMT-2') // Israel winter time
    ];
    var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profileWith(history));

    it('detects the trip from the profile history alone', function () {
      var onTrip = moment('2026-09-28T12:00:00Z').valueOf();
      var resolved = tz.patientAt(onTrip, { utcOffset: 0 });
      resolved.offset.should.equal(-240);
      resolved.source.should.equal('profile');
      tz.isAwayAt(onTrip, { utcOffset: 0 }).should.equal(true);
      tz.zoneLabel(resolved.zone, resolved.offset).should.equal('UTC-4');
    });

    it('does not flag the daylight-saving changes as trips', function () {
      tz.isAwayAt(moment('2026-02-10T12:00:00Z').valueOf(), null).should.equal(false); // GMT-2 in winter
      tz.isAwayAt(moment('2026-06-10T12:00:00Z').valueOf(), null).should.equal(false); // GMT-3 in summer
      tz.isAwayAt(moment('2026-10-20T12:00:00Z').valueOf(), null).should.equal(false); // GMT-3 after the trip
    });

    it('status() reports the trip while it is current', function () {
      var during = tz.status({}, moment('2026-10-01T12:00:00Z').valueOf());
      during.away.should.equal(true);
      during.patient.offset.should.equal(-240);
      tz.status({}, moment('2026-10-07T12:00:00Z').valueOf()).away.should.equal(false);
    });
  });

  describe('zoneLabel', function () {
    var tz = make({});

    it('names IANA zones with their offset and fixed zones by offset only', function () {
      tz.zoneLabel('Asia/Jerusalem', 120).should.equal('Asia/Jerusalem (UTC+2)');
      tz.zoneLabel('Etc/GMT+4', -240).should.equal('UTC-4');
      tz.zoneLabel('+05:30', 330).should.equal('UTC+5:30');
      tz.zoneLabel(null, 540).should.equal('UTC+9');
    });
  });

  describe('currentPatient / status', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);
    var now = winter;
    var hour = 60 * 60 * 1000;

    it('takes the newest recent record with an offset, from treatments or SGVs', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      var data = {
        treatments: [{ mills: now - 2 * hour, utcOffset: 540 }]
        , sgvs: [{ mills: now - 3 * hour, utcOffset: 540 }, { mills: now - 5 * 60 * 1000, utcOffset: -300 }]
      };
      var current = tz.currentPatient(data, now);
      current.offset.should.equal(-300);
      current.source.should.equal('record');
      current.since.should.equal(now - 5 * 60 * 1000);
    });

    it('ignores records in the future, too old, or without an offset', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      var data = {
        treatments: [{ mills: now + hour, utcOffset: 540 }, { mills: now - 10 * hour, utcOffset: 540 }, { mills: now - hour, utcOffset: 0 }]
        , sgvs: []
      };
      var current = tz.currentPatient(data, now);
      current.source.should.equal('profile');
      current.offset.should.equal(120);
    });

    it('status() flags travel against home', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem' }, profile);
      var away = tz.status({ treatments: [{ mills: now - hour, utcOffset: 540 }] }, now);
      away.away.should.equal(true);
      away.known.should.equal(true);
      away.home.zone.should.equal('Asia/Jerusalem');
      away.home.offset.should.equal(120);
      away.patient.offset.should.equal(540);

      var home = tz.status({ treatments: [{ mills: now - hour, utcOffset: 120 }] }, now);
      home.away.should.equal(false);

      var unknown = make({}).status({}, now);
      unknown.known.should.equal(false);
      unknown.away.should.equal(false);
    });
  });

  describe('travel periods declared by hand (TRAVEL_PERIODS)', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);
    var settings = {
      homeTimezone: 'Asia/Jerusalem'
      , travelPeriods: '2026-09-20..2026-10-05=America/New_York, 2026-12-24..2026-12-31=Europe/London bogus 2026-01-01..2026-01-02=Mars/Olympus'
    };

    it('parses the valid entries and skips the rest', function () {
      var periods = make(settings, profile).travelPeriods();
      periods.length.should.equal(2);
      periods[0].zone.should.equal('America/New_York');
      periods[1].zone.should.equal('Europe/London');
    });

    it('covers the whole trip, from home midnight on the first day to the end of the last day there', function () {
      var tz = make(settings, profile);
      // 20 Sep 00:00 Israel (UTC+3) = 19 Sep 21:00Z
      (tz.travelPeriodAt(moment('2026-09-19T20:59:00Z').valueOf()) === null).should.equal(true);
      tz.travelPeriodAt(moment('2026-09-19T21:00:00Z').valueOf()).zone.should.equal('America/New_York');
      // 5 Oct 23:59 New York (UTC-4) = 6 Oct 03:59Z
      tz.travelPeriodAt(moment('2026-10-06T03:59:00Z').valueOf()).zone.should.equal('America/New_York');
      (tz.travelPeriodAt(moment('2026-10-06T04:00:00Z').valueOf()) === null).should.equal(true);
    });

    it('is used for records without their own offset, over the profile zone', function () {
      var tz = make(settings, profile);
      var onTrip = moment('2026-09-28T12:00:00Z').valueOf();
      var resolved = tz.patientAt(onTrip, { utcOffset: 0 });
      resolved.source.should.equal('travel');
      resolved.zone.should.equal('America/New_York');
      resolved.offset.should.equal(-240);
      tz.isAwayAt(onTrip, { utcOffset: 0 }).should.equal(true);
      tz.momentAt(onTrip, { utcOffset: 0 }).format('HH:mm').should.equal('08:00');
    });

    it('does not override a record that says where it was', function () {
      var tz = make(settings, profile);
      tz.patientAt(moment('2026-09-28T12:00:00Z').valueOf(), { utcOffset: 540 }).source.should.equal('record');
    });

    it('is ignored outside the declared dates', function () {
      var tz = make(settings, profile);
      tz.patientAt(moment('2026-10-20T12:00:00Z').valueOf(), null).source.should.equal('profile');
    });

    it('re-parses when the setting changes', function () {
      var tz = make({ homeTimezone: 'Asia/Jerusalem', travelPeriods: '' }, profile);
      tz.travelPeriods().length.should.equal(0);
      tz.setSettings(settings);
      tz.travelPeriods().length.should.equal(2);
    });
  });

  describe('displayOffsetNow', function () {
    var profile = profileWith([storeProfile('2020-01-01', 'Asia/Jerusalem')]);
    var now = winter;
    var data = { treatments: [{ mills: now - 60 * 1000, utcOffset: 540 }] };

    it('follows the patient in patient mode', function () {
      make({ homeTimezone: 'Asia/Jerusalem' }, profile).displayOffsetNow(data, now).should.equal(540);
    });

    it('is the profile zone in profile mode', function () {
      make({ timeDisplay: 'profile', homeTimezone: 'Asia/Jerusalem' }, profile).displayOffsetNow(data, now).should.equal(120);
    });

    it('is null (browser) in browser mode', function () {
      (make({ timeDisplay: 'browser' }, profile).displayOffsetNow(data, now) === null).should.equal(true);
    });
  });

  describe('labels', function () {
    it('formats offsets', function () {
      make({}).label(540).should.equal('UTC+9');
      make({}).label(330).should.equal('UTC+5:30');
    });
  });
});
