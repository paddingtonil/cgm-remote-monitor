'use strict';

var factories = {
  weeks: function weeks(value) {
    return {
      mins: value * 7 * 24 * 60, secs: value * 7 * 24 * 60 * 60, msecs: value * 7 * 24 * 60 * 60 * 1000
    };
  }
  , days: function days(value) {
    return {
      hours: value * 24, mins: value * 24 * 60, secs: value * 24 * 60 * 60, msecs: value * 24 * 60 * 60 * 1000
    };
  }
  , hours: function hours(value) {
    return {
      mins: value * 60, secs: value * 60 * 60, msecs: value * 60 * 60 * 1000
    };
  }
  , mins: function mins(value) {
    return {
      secs: value * 60, msecs: value * 60 * 1000
    };
  }
  , secs: function secs(value) {
    return {
      msecs: value * 1000
    };
  }
  , msecs: function msecs(value) {
    return {
      mins: value / 1000 / 60, secs: value / 1000, msecs: value
    };
  }
};

// These helpers run inside the hot loops of duration processing, basal
// rendering and IOB/COB calculation, so each call goes straight to its
// factory instead of building a throwaway closure first.
var times = {
  week: function ( ) { return factories.weeks(1); }
  , weeks: function (value) { return factories.weeks(value); }
  , day: function ( ) { return factories.days(1); }
  , days: function (value) { return factories.days(value); }
  , hour: function ( ) { return factories.hours(1); }
  , hours: function (value) { return factories.hours(value); }
  , min: function ( ) { return factories.mins(1); }
  , mins: function (value) { return factories.mins(value); }
  , sec: function ( ) { return factories.secs(1); }
  , secs: function (value) { return factories.secs(value); }
  , msec: function ( ) { return factories.msecs(1); }
  , msecs: function (value) { return factories.msecs(value); }
};

module.exports = times;