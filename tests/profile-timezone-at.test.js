'use strict';

var should = require('should');
var helper = require('./inithelper')();
var moment = helper.ctx.moment;

describe('Profile timezone history', function () {

  function storeProfile (startDate, timezone) {
    var store = { dia: 3, carbs_hr: 30, carbratio: 7, sens: 35, basal: 1 };
    if (timezone) store.timezone = timezone;
    return {
      defaultProfile: 'Default'
      , startDate: startDate
      , store: { Default: store }
    };
  }

  // Newest first, as the profile store sorts them
  var history = [
    storeProfile('2024-01-20T00:00:00Z', 'Asia/Jerusalem')
    , storeProfile('2024-01-10T00:00:00Z', 'GMT+9') // Trio-style string, on a trip
    , storeProfile('2020-01-01T00:00:00Z', 'Asia/Jerusalem')
  ];

  var profile = require('../lib/profilefunctions')(null, helper.ctx);
  profile.loadData(history);

  var onTrip = moment('2024-01-15T12:00:00Z').valueOf();
  var atHome = moment('2024-01-25T12:00:00Z').valueOf();

  it('getTimezone() is the zone of the profile active now', function () {
    profile.getTimezone().should.equal('Asia/Jerusalem');
  });

  it('getTimezoneAt() is the zone of the profile active at the time, normalized', function () {
    profile.getTimezoneAt(onTrip).should.equal('Etc/GMT-9');
    profile.getTimezoneAt(atHome).should.equal('Asia/Jerusalem');
    profile.getTimezoneAt(moment('2023-06-01T12:00:00Z').valueOf()).should.equal('Asia/Jerusalem');
  });

  it('utcOffsetAt() gives the offset in minutes at the time', function () {
    profile.utcOffsetAt(onTrip).should.equal(540);
    profile.utcOffsetAt(atHome).should.equal(120);
    profile.utcOffsetAt(moment('2024-07-15T12:00:00Z').valueOf()).should.equal(180);
  });

  it('applyTimezoneAt() uses the zone in effect at the moment itself', function () {
    profile.applyTimezoneAt(moment(onTrip)).format('HH:mm').should.equal('21:00');
    profile.applyTimezoneAt(moment(atHome)).format('HH:mm').should.equal('14:00');
  });

  it('utcOffsetAt() is null without a timezone', function () {
    var bare = require('../lib/profilefunctions')(null, helper.ctx);
    bare.loadData([storeProfile('2020-01-01', undefined)]);
    should.not.exist(bare.getTimezoneAt(onTrip));
    (bare.utcOffsetAt(onTrip) === null).should.equal(true);
  });

  it('handles a sub-hour fixed offset', function () {
    var india = require('../lib/profilefunctions')(null, helper.ctx);
    india.loadData([storeProfile('2020-01-01', 'GMT+5:30')]);
    india.getTimezoneAt(onTrip).should.equal('+05:30');
    india.utcOffsetAt(onTrip).should.equal(330);
  });
});
