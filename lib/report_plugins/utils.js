'use strict';

var consts = require('../constants');
var htmlUtils = require('../utils/html');

var moment = window.moment;
var utils = { };

function init( ) {
  return utils;
}

module.exports = init;

utils.localeDate = function localeDate(day) {
  var translate = window.Nightscout.client.translate;
  var profile = window.Nightscout.client.sbx.data.profile;
  var date;
  if (typeof day === 'string') {
    date = profile.parseInTimezone(day + 'T00:00:00');
  } else {
    date = profile.applyTimezone(moment(day));
  }
  var ret = 
    [translate('Sunday'),translate('Monday'),translate('Tuesday'),translate('Wednesday'),translate('Thursday'),translate('Friday'),translate('Saturday')][date.day()];
  ret += ' ';
  ret += date.format('L');
  return ret;
};

utils.localeDateTime = function localeDateTime(day) {
  var profile = window.Nightscout.client.sbx.data.profile;
  var date;
  if (typeof day === 'string') {
    date = profile.parseInTimezone(day + 'T00:00:00');
  } else {
    date = profile.applyTimezone(moment(day));
  }
  var ret = date.format('L LT');
  return ret;
};

var ONE_HOUR = 60 * 60 * 1000;
var TWELVE_HOURS = 12 * ONE_HOUR;
var DAY_SAMPLE_HOURS = [1, 4, 7, 10, 13, 16, 19, 22];

/**
 * Where the patient was on a report day. The day is sampled every three
 * hours through the layered resolver (record offset, else the profile zone
 * in effect at that instant, else home; see client-core/timezone-context),
 * and records that carry their own offset count as well. The day is `away`
 * if any part of it was spent outside home's offsets, so the day the pump
 * clock was synced is noted too. `zones` lists every offset seen, in order.
 * @param {string} day - 'YYYY-MM-DD'
 * @param {{treatments: Array, sgv: Array}} data - the day's loaded data
 * @returns {{offset: number|null, zone: string|null, source: string, label: string, away: boolean,
 *   difference: number|null, zones: Array<{offset: number, zone: string|null, label: string, away: boolean}>,
 *   home: {zone: string|null, offset: number|null}}|null}
 */
utils.dayTimezone = function dayTimezone (day, data) {
  var client = window.Nightscout.client;
  var tz = client.tz;
  if (!tz) return null;

  var dayStart = client.sbx.data.profile.parseInTimezone(day).valueOf();
  var midday = dayStart + TWELVE_HOURS;
  var home = { zone: tz.homeZone(), offset: tz.homeOffsetAt(midday) };

  // every offset seen through the day, in order of first appearance
  var zones = [];
  var counts = {};
  function note (resolved, at, weight) {
    if (!resolved || resolved.offset === null) return;
    var key = String(resolved.offset);
    if (!counts[key]) {
      counts[key] = 0;
      zones.push({
        offset: resolved.offset
        , zone: resolved.zone || null
        , label: tz.zoneLabel(resolved.zone, resolved.offset)
        , away: home.offset !== null && !tz.isHomeOffset(resolved.offset, at)
      });
    }
    counts[key] += weight;
  }

  DAY_SAMPLE_HOURS.forEach(function eachSample (hour) {
    var at = dayStart + hour * ONE_HOUR;
    note(tz.patientAt(at, null), at, 1);
  });
  [data.treatments, data.sgv].forEach(function eachList (list) {
    (list || []).forEach(function eachRecord (record) {
      var offset = tz.recordOffset(record);
      if (offset !== null) note({ offset: offset, zone: null, source: 'record' }, record.mills || midday, 0.01);
    });
  });

  var awayZones = zones.filter(function isAway (z) { return z.away; });
  // the zone the day is labelled with: the away zone seen most, else the one seen most
  var pool = awayZones.length ? awayZones : zones;
  var main = null;
  pool.forEach(function eachZone (z) {
    if (!main || counts[String(z.offset)] > counts[String(main.offset)]) main = z;
  });

  if (!main) {
    return { offset: null, zone: null, source: 'unknown', label: '', away: false, difference: null, zones: [], home: home };
  }

  return {
    offset: main.offset
    , zone: main.zone
    , source: tz.patientAt(midday, null).source
    , label: zones.length > 1 ? zones.map(function (z) { return z.label; }).join(' → ') : main.label
    , away: awayZones.length > 0
    , difference: tz.homeDifference(main.offset, midday)
    , zones: zones
    , home: home
  };
};

/**
 * The pump time zone history recorded in the profile documents of a report
 * range: one entry per change of offset, oldest first. Loop and Trio write
 * the pump's zone into every profile they upload, so this is the record of
 * where the patient was (see client-core/timezone-context).
 * @param {Array} profiles - profile documents (datastorage.profiles)
 * @returns {Array<{start: number, zone: string|null, offset: number|null, label: string, away: boolean}>}
 */
utils.timezoneHistory = function timezoneHistory (profiles) {
  var client = window.Nightscout.client;
  var tz = client.tz;
  var profile = client.sbx.data.profile;
  if (!tz || !Array.isArray(profiles)) return [];

  var items = profiles.map(function eachDoc (doc) {
    if (!doc) return null;
    var start = new Date(doc.startDate).getTime();
    var store = doc.store || {};
    var active = store[doc.defaultProfile] || store[Object.keys(store)[0]] || doc;
    var raw = active && active.timezone;
    var zone = profile.normalizeTimezone ? profile.normalizeTimezone(raw) : raw;
    return { start: start, zone: zone || null, offset: tz.zoneOffsetAt(zone, start) };
  }).filter(function valid (item) {
    return item && !isNaN(item.start);
  }).sort(function byStart (a, b) { return a.start - b.start; });

  var runs = [];
  items.forEach(function eachItem (item) {
    var last = runs[runs.length - 1];
    if (last && last.offset === item.offset) return;
    runs.push({
      start: item.start
      , zone: item.zone
      , offset: item.offset
      , label: item.offset === null ? (item.zone || '?') : tz.zoneLabel(item.zone, item.offset)
      , away: item.offset !== null && tz.homeOffsetAt(item.start) !== null && !tz.isHomeOffset(item.offset, item.start)
    });
  });
  return runs;
};

/**
 * An inline badge naming where the patient was, for a day on which they were
 * away from home; an empty string otherwise. Safe to append to HTML.
 */
utils.travelBadge = function travelBadge (data) {
  var info = data && data.timezone;
  if (!info || !info.away) return '';
  var client = window.Nightscout.client;
  var translate = client.translate;
  var difference = client.tz ? client.tz.differenceText(info.difference, translate) : '';
  var text = info.label + (difference ? ', ' + difference : '');
  var title = htmlUtils.textAsHtml(translate('Patient was in %1 on this day', { params: [info.label] }));
  return ' <span class="travelbadge" title="' + title + '"'
    + ' style="margin-left:6px;padding:1px 7px;border-radius:9px;background:#ffd666;color:#333;font-size:0.85em;font-weight:normal;white-space:nowrap">'
    + '&#9992; ' + translate('Trip') + ': ' + htmlUtils.textAsHtml(text) + '</span>';
};

utils.scaledTreatmentBG = function scaledTreatmentBG(treatment,data) {
  var client = window.Nightscout.client;

  var SIX_MINS_IN_MS =  360000;
 
  function calcBGByTime(time) {
    var closeBGs = data.filter(function(d) {
      if (!d.y) {
        return false;
      } else {
        return Math.abs((new Date(d.date)).getTime() - time) <= SIX_MINS_IN_MS;
      }
    });

    var totalBG = 0;
    closeBGs.forEach(function(d) {
      totalBG += Number(d.y);
    });

    return totalBG > 0 ? (totalBG / closeBGs.length) : 450;
  }

  var treatmentGlucose = null;

  if (treatment.glucose && isNaN(treatment.glucose)) {
    console.warn('found an invalid glucose value', treatment);
  } else {
    if (treatment.glucose && treatment.units && client.settings.units) {
      if (treatment.units !== client.settings.units) {
        console.info('found mismatched glucose units, converting ' + treatment.units + ' into ' + client.settings.units, treatment);
        if (treatment.units === 'mmol') {
          //BG is in mmol and display in mg/dl
          treatmentGlucose = Math.round(treatment.glucose * consts.MMOL_TO_MGDL);
        } else {
          //BG is in mg/dl and display in mmol
          treatmentGlucose = client.utils.scaleMgdl(treatment.glucose);
        }
      } else {
        treatmentGlucose = treatment.glucose;
      }
    } else if (treatment.glucose) {
      //no units, assume everything is the same
      console.warn('found an glucose value with any units, maybe from an old version?', treatment);
      treatmentGlucose = treatment.glucose;
    }
  }

  return treatmentGlucose || client.utils.scaleMgdl(calcBGByTime(treatment.mills));
};
