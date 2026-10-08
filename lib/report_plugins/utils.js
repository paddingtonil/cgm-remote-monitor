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

var TWELVE_HOURS = 12 * 60 * 60 * 1000;

/**
 * Where the patient was on a report day: the offset most of the day's
 * records carry, else the profile zone in effect that day, else home (see
 * client-core/timezone-context). `away` is set when that differs from home.
 * @param {string} day - 'YYYY-MM-DD'
 * @param {{treatments: Array, sgv: Array}} data - the day's loaded data
 * @returns {{offset: number|null, zone: string|null, source: string, label: string, away: boolean, home: {zone: string|null, offset: number|null}}|null}
 */
utils.dayTimezone = function dayTimezone (day, data) {
  var client = window.Nightscout.client;
  var tz = client.tz;
  if (!tz) return null;

  var midday = client.sbx.data.profile.parseInTimezone(day).valueOf() + TWELVE_HOURS;
  var home = { zone: tz.homeZone(), offset: tz.homeOffsetAt(midday) };

  var counts = {};
  [data.treatments, data.sgv].forEach(function eachList (list) {
    (list || []).forEach(function eachRecord (record) {
      var offset = tz.recordOffset(record);
      if (offset !== null) counts[offset] = (counts[offset] || 0) + 1;
    });
  });
  var dominant = null;
  Object.keys(counts).forEach(function eachOffset (key) {
    if (dominant === null || counts[key] > counts[dominant]) dominant = key;
  });

  var resolved = dominant !== null
    ? { offset: Number(dominant), zone: null, source: 'record' }
    : tz.patientAt(midday, null);

  var away = resolved.offset !== null && home.offset !== null && resolved.offset !== home.offset;
  return {
    offset: resolved.offset
    , zone: resolved.zone
    , source: resolved.source
    , label: resolved.zone || tz.label(resolved.offset)
    , away: away
    , home: home
  };
};

/**
 * An inline badge naming where the patient was, for a day on which they were
 * away from home; an empty string otherwise. Safe to append to HTML.
 */
utils.travelBadge = function travelBadge (data) {
  var info = data && data.timezone;
  if (!info || !info.away) return '';
  var translate = window.Nightscout.client.translate;
  var label = htmlUtils.textAsHtml(info.label);
  var title = htmlUtils.textAsHtml(translate('Patient was in %1 on this day', { params: [info.label] }));
  return ' <span class="travelbadge" title="' + title + '"'
    + ' style="margin-left:6px;padding:1px 7px;border-radius:9px;background:#ffd666;color:#333;font-size:0.85em;font-weight:normal;white-space:nowrap">'
    + '&#9992; ' + translate('Travelling') + ': ' + label + '</span>';
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
