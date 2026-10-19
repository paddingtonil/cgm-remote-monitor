'use strict';

var consts = require('../constants');

const MAX_BG_MMOL = 22;
const MAX_BG_MGDL = MAX_BG_MMOL * consts.MMOL_TO_MGDL;

module.exports = function fitTreatmentsToBGCurve (ddata, env, ctx) {

  var settings = env.settings;
  var rawbg = require('../plugins/rawbg')({
    settings: settings
    , language: ctx.language
  });

  // The curve the treatments are fitted to is the same for every treatment, so
  // build it once rather than filtering, copying and reversing the sgv array
  // per treatment (which was O(treatments × sgvs) with thousands of treatments
  // in a 60h AAPS/Loop window).
  var rawbgEnabled = settings.isEnabled('rawbg');
  var withBGs = (ddata.sgvs || []).filter(function(d) {
    return d.mgdl > 39 || rawbgEnabled;
  });

  // sgvs normally arrive sorted by time, which allows a binary search for the
  // neighbours of a treatment. Fall back to a linear scan when they are not,
  // so the result is identical either way.
  var sortedByMills = true;
  for (var s = 1; s < withBGs.length; s++) {
    if (!(withBGs[s - 1].mills <= withBGs[s].mills)) {
      sortedByMills = false;
      break;
    }
  }

  // Last entry with mills <= target, or undefined.
  function lastAtOrBefore (target) {
    if (sortedByMills) {
      var lo = 0, hi = withBGs.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (withBGs[mid].mills <= target) { lo = mid + 1; } else { hi = mid; }
      }
      // the comparison re-check keeps a non-numeric target (NaN, undefined)
      // behaving as the linear scan does: no match
      return lo > 0 && withBGs[lo - 1].mills <= target ? withBGs[lo - 1] : undefined;
    }
    for (var i = withBGs.length - 1; i >= 0; i--) {
      if (withBGs[i].mills <= target) { return withBGs[i]; }
    }
    return undefined;
  }

  // First entry with mills >= target, or undefined.
  function firstAtOrAfter (target) {
    if (sortedByMills) {
      var lo = 0, hi = withBGs.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (withBGs[mid].mills < target) { lo = mid + 1; } else { hi = mid; }
      }
      return lo < withBGs.length && withBGs[lo].mills >= target ? withBGs[lo] : undefined;
    }
    for (var i = 0; i < withBGs.length; i++) {
      if (withBGs[i].mills >= target) { return withBGs[i]; }
    }
    return undefined;
  }

  function updateTreatmentBG(treatment) {    function mgdlByTime() {

      var beforeTreatment = lastAtOrBefore(treatment.mills);
      var afterTreatment = firstAtOrAfter(treatment.mills);

      var mgdlBefore = mgdlValue(beforeTreatment) || calcRaw(beforeTreatment);
      var mgdlAfter = mgdlValue(afterTreatment) || calcRaw(afterTreatment);

      var calcedBG = 0;
      if (mgdlBefore && mgdlAfter) {
        calcedBG = (mgdlBefore + mgdlAfter) / 2;
      } else if (mgdlBefore) {
        calcedBG = mgdlBefore;
      } else if (mgdlAfter) {
        calcedBG = mgdlAfter;
      }

      return Math.round(calcedBG) || 180;
    }

    function mgdlValue (entry) {
      return entry && entry.mgdl >= 39 && Number(entry.mgdl);
    }    /**
     * Calculate raw blood glucose values using calibration data
     * @param {Object} entry - The entry to calculate raw values for
     * @returns {number|undefined} - The calculated raw value or undefined
     */
    function calcRaw (entry) {
      var raw;
      if (entry && settings.isEnabled('rawbg')) {
        var cal = ddata.cals?.[ddata.cals?.length - 1];
        if (cal) {
          raw = rawbg.calc(entry, cal);
        }
      }
      return raw;
    }

    //to avoid checking if eventType is null everywhere, just default it here
    treatment.eventType = treatment.eventType || '';

    if (treatment.glucose && isNaN(treatment.glucose)) {
      console.warn('found an invalid glucose value', treatment);
    } else if (treatment.glucose && treatment.units) {
      if (treatment.units === 'mmol') {
        treatment.mmol = Math.min(Number(treatment.glucose), MAX_BG_MMOL);
      } else {
        treatment.mgdl = Math.min(Number(treatment.glucose), MAX_BG_MGDL);
      }
    } else if (treatment.glucose) {
      //no units, assume everything is the same
      //console.warn('found a glucose value without any units, maybe from an old version?', pick(treatment, ['_id', 'created_at', 'enteredBy']));
      var units = settings.units === 'mmol' ? 'mmol' : 'mgdl';

      treatment[units] = settings.units === 'mmol' ? Math.min(Number(treatment.glucose), MAX_BG_MMOL) : Math.min(Number(treatment.glucose), MAX_BG_MGDL);
    } else {
      treatment.mgdl = mgdlByTime();
    }
  }

  ddata.treatments?.forEach(updateTreatmentBG);

};
