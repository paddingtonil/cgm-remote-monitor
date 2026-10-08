'use strict';

/*
 * lib/client-core/careportal/validate.js
 *
 * Pure validation for careportal treatment data. Extracted from
 * lib/client/careportal.js (Track 2 / Phase 5a). No DOM, no jQuery,
 * no globals: takes a plain `data` object and an `opts` bag, returns
 * `{ allOk, messages }`.
 *
 * The original `validateData(data)` closure depended on the outer
 * `units` and `consts.MMOL_TO_MGDL`. Here both are explicit:
 *
 *   validate(data, { units, MMOL_TO_MGDL })
 *
 * Behavior is byte-identical to the original (same threshold math,
 * same message strings) so the legacy careportal.test.js continues
 * to pass once the adapter delegates here.
 */

var consts = require('../../constants');

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(data, opts) {
  opts = opts || {};
  var units = opts.units;
  var MMOL_TO_MGDL = opts.MMOL_TO_MGDL || consts.MMOL_TO_MGDL;

  var allOk = true;
  var messages = [];

  if (data.duration !== 0 && data.eventType === 'Temporary Target') {
    if (isNaN(data.targetTop) || isNaN(data.targetBottom) || !data.targetBottom || !data.targetTop) {
      allOk = false;
      messages.push("Please enter a valid value for both top and bottom target to save a Temporary Target");
    } else {
      var targetTop = parseInt(data.targetTop);
      var targetBottom = parseInt(data.targetBottom);

      var minTarget = 4 * MMOL_TO_MGDL;
      var maxTarget = 18 * MMOL_TO_MGDL;

      if (units === 'mmol') {
        targetTop = Math.round(targetTop / MMOL_TO_MGDL * 10) / 10;
        targetBottom = Math.round(targetBottom / MMOL_TO_MGDL * 10) / 10;
        minTarget = Math.round(minTarget / MMOL_TO_MGDL * 10) / 10;
        maxTarget = Math.round(maxTarget / MMOL_TO_MGDL * 10) / 10;
      }

      if (targetTop > maxTarget) {
        allOk = false;
        messages.push("Temporary target high is too high");
      }

      if (targetBottom < minTarget) {
        allOk = false;
        messages.push("Temporary target low is too low");
      }

      if (targetTop < targetBottom || targetBottom > targetTop) {
        allOk = false;
        messages.push("The low target must be lower than the high target and high target must be higher than the low target.");
      }
    }
  }

  // A trip declared on the site (see lib/plugins/timezone.js): a zone and a
  // first day are required; the last day, when given, must not come first.
  if (data.eventType === 'Travel') {
    if (!data.timezone) {
      allOk = false;
      messages.push("Please select the time zone of the trip");
    }
    if (!DATE_RE.test(data.startDate || '')) {
      allOk = false;
      messages.push("Please enter the first day of the trip");
    }
    if (data.endDate && (!DATE_RE.test(data.endDate) || data.endDate < data.startDate)) {
      allOk = false;
      messages.push("The last day of the trip must not be before the first day");
    }
  }

  return { allOk: allOk, messages: messages };
}

module.exports = validate;
module.exports.validate = validate;
