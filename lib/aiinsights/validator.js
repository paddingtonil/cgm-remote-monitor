'use strict';

// Post-parse safety layer for AI Insights settings responses (spec 6.7 / 6.8,
// design doc section 10). Every stage runs in the order listed there:
//
//   1  extractJson            fenced ```json, else ```, else first '{' .. last '}'
//   2  repairTruncatedJson    drop partial tail, close open string, close ] / }
//   3  isApiEnvelope          candidates / usageMetadata -> empty_thinking_response
//   4  required fields        time_blocks, reasoning, confidence; rounding per setting
//   5  block filtering        absolute bounds, recommended range, % change, no-op
//   6  success_criteria       evaluation_days default 5, kept only with expected_outcomes
//   7  mergeSuggestions       one suggestion per setting type
//   8  clamp                  (inside validateTimeBlocks) <= 1.5x threshold -> clamp
//   9  checkCitations         numbers in reasoning vs hourly means +-2
//  10  applyConfidenceCap     CR < 5 meals / ISF < 3 corrections -> low
//  11  hasContradiction       phrase present and confidence != low -> drop
//
// Also hosts the plain-text parsers for the trends (spec 9.3) and meal debrief
// (spec 7.5) responses.

const types = require('./types');

const SETTING_TYPES = types.SETTING_TYPES;
const CONFIDENCES = types.CONFIDENCES;

const GUARDRAILS = {
  carb_ratio: { absMin: 2.0, recMin: 4.0, recMax: 28.0, absMax: 150.0, round: 0.1, maxChangePct: 25, promptChangePct: 20 }
  , insulin_sensitivity: { absMin: 10.0, recMin: 16.0, recMax: 400.0, absMax: 500.0, round: 1, maxChangePct: 25, promptChangePct: 20 }
  , basal_rate: { absMin: 0.05, recMin: 0.05, recMax: 10.0, absMax: 30.0, round: 0.05, maxChangePct: 15, promptChangePct: 10 }
};

const CONTRADICTION_PHRASES = [
  'cannot be derived'
  , 'cannot be determined'
  , 'cannot be calculated'
  , 'cannot be meaningfully'
  , 'insufficient data'
  , 'no meal data'
  , 'no carb entries'
  , 'no bolus data'
  , 'unable to determine'
  , 'kept close to current settings'
  , 'echoing current'
  , 'no meals available'
  , 'cannot validate'
  , 'no correction events'
];

const VERDICTS = ['success', 'partial', 'no_improvement', 'worsened', 'insufficient_data'];

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const SNAPSHOT_KEYS = {
  basal_rate: 'basal'
  , carb_ratio: 'carbratio'
  , insulin_sensitivity: 'sens'
};

const SECONDS_PER_DAY = 86400;

const CITATION_PATTERNS = [
  /(\d{2,3})\s*mg\/dL/gi
  , /glucose[^.\d]{0,40}?(\d{2,3})/gi
  , /average[^.\d]{0,40}?(\d{2,3})/gi
];

const EFFECTIVE_CARB_PATTERNS = [
  /behaved like ~?(\d+)\s*g/i
  , /effectively ~?(\d+)\s*g/i
  , /equivalent to ~?(\d+)\s*g/i
  , /acted as ~?(\d+)\s*g/i
];

const DEFAULT_LEARNING = 'Review your carb count for this meal type';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stripHtml (value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/<[^>]*>/g, '').trim();
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNumber (value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function toInt (value, fallback) {
  const n = toNumber(value);
  if (Number.isNaN(n)) {
    return fallback;
  }
  return Math.round(n);
}

function stepDecimals (step) {
  const text = String(step);
  const idx = text.indexOf('.');
  return idx < 0 ? 0 : text.length - idx - 1;
}

function roundToStep (value, step) {
  const v = toNumber(value);
  const s = toNumber(step);
  if (Number.isNaN(v)) {
    return NaN;
  }
  if (Number.isNaN(s) || s <= 0) {
    return v;
  }
  return Number((Math.round(v / s) * s).toFixed(stepDecimals(s)));
}

// Round to the step grid, but never past `limit` in the direction away from
// `current`. Used when clamping so the clamped value stays within the threshold.
function roundTowardCurrent (value, step, current) {
  const rounded = roundToStep(value, step);
  const decimals = stepDecimals(step);
  if (value > current && rounded > value) {
    return Number((rounded - step).toFixed(decimals));
  }
  if (value < current && rounded < value) {
    return Number((rounded + step).toFixed(decimals));
  }
  return rounded;
}

function formatPct (pct) {
  return pct.toFixed(1) + '%';
}

function stringList (value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(function onlyText (item) {
      return typeof item === 'string' || typeof item === 'number';
    })
    .map(stripHtml)
    .filter(function nonEmpty (item) {
      return item.length > 0;
    });
}

function stringMap (value) {
  const out = {};
  if (!isPlainObject(value)) {
    return out;
  }
  Object.keys(value).forEach(function copyEntry (key) {
    const v = value[key];
    if (typeof v === 'string' || typeof v === 'number') {
      out[stripHtml(key)] = stripHtml(v);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1: JSON extraction
// ---------------------------------------------------------------------------

function extractJson (text) {
  if (typeof text !== 'string') {
    return null;
  }

  const jsonFence = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence && jsonFence[1].trim()) {
    return jsonFence[1].trim();
  }

  // Opening ```json fence whose closing fence was truncated away.
  const openJsonFence = text.match(/```json\s*([\s\S]*)$/i);
  if (openJsonFence && openJsonFence[1].trim()) {
    return openJsonFence[1].trim();
  }

  const anyFence = text.match(/```\s*([\s\S]*?)```/);
  if (anyFence && anyFence[1].trim()) {
    return anyFence[1].trim();
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0) {
    return null;
  }
  if (last > first) {
    return text.slice(first, last + 1);
  }
  return text.slice(first);
}

// ---------------------------------------------------------------------------
// Stage 2: truncated JSON repair
// ---------------------------------------------------------------------------

// Walk the text tracking string state and open brackets. Returns everything
// the repair heuristics need in one pass.
function scanJson (text) {
  const stack = []; // { closer: '}'|']', index }
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastComma = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        stringStart = -1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === '{') {
      stack.push({ closer: '}', index: i });
    } else if (ch === '[') {
      stack.push({ closer: ']', index: i });
    } else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1].closer === ch) {
        stack.pop();
      }
    } else if (ch === ',') {
      lastComma = i;
    }
  }

  return { inString: inString, stringStart: stringStart, stack: stack, lastComma: lastComma };
}

function previousSignificant (text, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (!/\s/.test(text[i])) {
      return text[i];
    }
  }
  return '';
}

function closeOpen (text) {
  const info = scanJson(text);
  let out = text;
  if (info.inString) {
    out += '"';
  }
  for (let i = info.stack.length - 1; i >= 0; i--) {
    out += info.stack[i].closer;
  }
  return out;
}

// Remove an incomplete trailing key or value so what remains is closable.
function dropPartialTail (text) {
  let out = text;
  let info = scanJson(out);

  if (info.inString) {
    const before = previousSignificant(out, info.stringStart);
    const inObject = info.stack.length && info.stack[info.stack.length - 1].closer === '}';
    if (inObject && (before === '{' || before === ',')) {
      // partial key: drop it
      out = out.slice(0, info.stringStart);
    } else {
      // partial value: keep what we have, close the string
      out += '"';
    }
  }

  out = out.replace(/\s+$/, '');
  info = scanJson(out);

  // Dangling `"key":` or `"key"` inside an object -> cut back to the last comma
  // (or to the opening brace) so the key disappears entirely.
  if (/:$/.test(out) || (/"$/.test(out) && isDanglingKey(out, info))) {
    const open = info.stack.length ? info.stack[info.stack.length - 1].index : -1;
    if (info.lastComma > open) {
      out = out.slice(0, info.lastComma);
    } else if (open >= 0) {
      out = out.slice(0, open + 1);
    }
    out = out.replace(/\s+$/, '');
  }

  if (/,$/.test(out)) {
    out = out.slice(0, -1).replace(/\s+$/, '');
  }

  return out;
}

function isDanglingKey (text, info) {
  if (!info.stack.length || info.stack[info.stack.length - 1].closer !== '}') {
    return false;
  }
  // Find the opening quote of the final string token.
  let i = text.length - 2;
  for (; i >= 0; i--) {
    if (text[i] === '"' && text[i - 1] !== '\\') {
      break;
    }
  }
  if (i < 0) {
    return false;
  }
  const before = previousSignificant(text, i);
  return before === '{' || before === ',';
}

function parses (text) {
  try {
    JSON.parse(text);
    return true;
  } catch (err) {
    return false;
  }
}

function repairTruncatedJson (text) {
  let source = String(text || '').trim().replace(/```\s*$/, '').trim();
  if (!source) {
    return source;
  }

  let candidate = closeOpen(dropPartialTail(source));
  if (parses(candidate)) {
    return candidate;
  }

  // Progressively cut at the last structural comma until something parses.
  let current = source;
  for (let attempt = 0; attempt < 25; attempt++) {
    const info = scanJson(current);
    if (info.lastComma < 0) {
      break;
    }
    current = current.slice(0, info.lastComma);
    candidate = closeOpen(dropPartialTail(current));
    if (parses(candidate)) {
      return candidate;
    }
  }

  return closeOpen(dropPartialTail(source));
}

function parseJsonLenient (text) {
  const extracted = extractJson(text);
  if (extracted === null) {
    throw new Error('No JSON object found in response');
  }

  try {
    return JSON.parse(extracted);
  } catch (err) {
    // fall through to repair
  }

  const repaired = repairTruncatedJson(extracted);
  try {
    return JSON.parse(repaired);
  } catch (err) {
    // fall through to the "truncated after the last brace" case
  }

  // The response may have been cut mid-string after the last '}', in which
  // case extractJson dropped the tail. Repair from the first brace to the end.
  const first = text.indexOf('{');
  const tail = first >= 0 ? text.slice(first) : '';
  if (tail && tail !== extracted) {
    const repairedTail = repairTruncatedJson(tail);
    try {
      return JSON.parse(repairedTail);
    } catch (err) {
      // give up below
    }
  }

  throw new Error('Response is not valid JSON even after repair');
}

// ---------------------------------------------------------------------------
// Stage 3: API envelope detection
// ---------------------------------------------------------------------------

function isApiEnvelope (obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(obj, 'candidates') ||
    Object.prototype.hasOwnProperty.call(obj, 'usageMetadata');
}

// ---------------------------------------------------------------------------
// Stages 4, 5 and 8: time block validation
// ---------------------------------------------------------------------------

function blockLabel (settingType, start, end) {
  return settingType + ' block ' + start + '-' + end;
}

function validateTimeBlocks (blocks, settingType, notes) {
  const rails = GUARDRAILS[settingType];
  const out = [];
  if (!rails) {
    throw new TypeError('Unknown setting type: ' + settingType);
  }
  if (!Array.isArray(blocks)) {
    return out;
  }
  notes = Array.isArray(notes) ? notes : [];

  blocks.forEach(function validateBlock (raw, index) {
    if (!isPlainObject(raw)) {
      notes.push(settingType + ' block #' + index + ' is not an object; rejected');
      return;
    }

    const start = toNumber(raw.start_seconds);
    const end = toNumber(raw.end_seconds);
    const timeValid = Number.isInteger(start) && Number.isInteger(end) &&
      start >= 0 && end <= SECONDS_PER_DAY && start < end;
    if (!timeValid) {
      notes.push(settingType + ' block #' + index + ' has invalid time range (' +
        raw.start_seconds + '-' + raw.end_seconds + '); rejected');
      return;
    }

    const label = blockLabel(settingType, start, end);
    const current = toNumber(raw.current_value);
    const proposedRaw = toNumber(raw.proposed_value);
    if (Number.isNaN(current) || Number.isNaN(proposedRaw)) {
      notes.push(label + ': non-numeric current/proposed value; rejected');
      return;
    }

    const roundedCurrent = roundToStep(current, rails.round);
    let proposed = roundToStep(proposedRaw, rails.round);

    if (proposed < rails.absMin || proposed > rails.absMax) {
      notes.push(label + ': proposed ' + proposed + ' outside absolute bounds [' +
        rails.absMin + ', ' + rails.absMax + ']; rejected');
      return;
    }
    if (current < rails.absMin || current > rails.absMax) {
      notes.push(label + ': current ' + current + ' outside absolute bounds [' +
        rails.absMin + ', ' + rails.absMax + ']; rejected');
      return;
    }
    if (proposed < rails.recMin || proposed > rails.recMax) {
      notes.push(label + ': proposed ' + proposed + ' outside recommended range [' +
        rails.recMin + ', ' + rails.recMax + ']; kept with warning');
    }

    if (current > 0) {
      const pct = Math.abs(proposed - current) / current * 100;
      if (pct > rails.maxChangePct) {
        if (pct <= rails.maxChangePct * 1.5) {
          const direction = proposed > current ? 1 : -1;
          const limit = current * (1 + direction * rails.maxChangePct / 100);
          const clamped = roundTowardCurrent(limit, rails.round, current);
          notes.push(label + ': change ' + formatPct(pct) + ' exceeds ' + rails.maxChangePct +
            '%; clamped proposed ' + proposed + ' to ' + clamped);
          proposed = clamped;
        } else {
          notes.push(label + ': change ' + formatPct(pct) + ' exceeds ' + rails.maxChangePct +
            '% by more than 1.5x; rejected');
          return;
        }
      }
    }

    if (proposed === roundedCurrent) {
      notes.push(label + ': proposed equals current after rounding; dropped as no-op');
      return;
    }

    out.push({
      start_seconds: start
      , end_seconds: end
      , current_value: current
      , proposed_value: proposed
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Stage 9: citation check
// ---------------------------------------------------------------------------

function checkCitations (reasoning, hourly) {
  const notes = [];
  if (typeof reasoning !== 'string' || !reasoning) {
    return notes;
  }
  const means = (Array.isArray(hourly) ? hourly : [])
    .map(function pickMean (h) {
      return h && typeof h.mean === 'number' && Number.isFinite(h.mean) ? h.mean : null;
    })
    .filter(function notNull (m) {
      return m !== null;
    });
  if (!means.length) {
    return notes;
  }

  const seen = new Set();
  CITATION_PATTERNS.forEach(function runPattern (pattern) {
    pattern.lastIndex = 0;
    let match = pattern.exec(reasoning);
    while (match) {
      const value = parseInt(match[1], 10);
      if (value >= 40 && value <= 400 && !seen.has(value)) {
        seen.add(value);
        const found = means.some(function closeEnough (m) {
          return Math.abs(m - value) <= 2;
        });
        if (!found) {
          notes.push('citation ' + value + ' mg/dL not found in hourly averages');
        }
      }
      match = pattern.exec(reasoning);
    }
    pattern.lastIndex = 0;
  });

  return notes;
}

// ---------------------------------------------------------------------------
// Stage 10: confidence cap by data availability
// ---------------------------------------------------------------------------

function applyConfidenceCap (suggestion, settingType, counts) {
  if (!isPlainObject(suggestion)) {
    return suggestion;
  }
  counts = counts || {};
  const mealCount = toNumber(counts.mealCount);
  const correctionCount = toNumber(counts.correctionCount);

  let warning = null;
  if (settingType === 'carb_ratio' && !Number.isNaN(mealCount) && mealCount < 5) {
    warning = 'only ' + mealCount + ' meal ' + (mealCount === 1 ? 'entry' : 'entries') +
      ' were available in this period';
  } else if (settingType === 'insulin_sensitivity' && !Number.isNaN(correctionCount) && correctionCount < 3) {
    warning = 'only ' + correctionCount + ' correction ' + (correctionCount === 1 ? 'bolus' : 'boluses') +
      ' were available in this period';
  }

  if (!warning) {
    return suggestion;
  }

  const previous = suggestion.confidence;
  suggestion.confidence = 'low';
  suggestion.reasoning = (suggestion.reasoning || '').trim() +
    ' ⚠️ Limited data: ' + warning + ', so this suggestion is low confidence.';
  suggestion.reasoning = suggestion.reasoning.trim();
  if (!Array.isArray(suggestion.validation_notes)) {
    suggestion.validation_notes = [];
  }
  suggestion.validation_notes.push('confidence capped to low (was ' + previous + '): ' + warning);
  return suggestion;
}

// ---------------------------------------------------------------------------
// Stage 11: contradiction detection
// ---------------------------------------------------------------------------

function hasContradiction (reasoning) {
  if (typeof reasoning !== 'string' || !reasoning) {
    return null;
  }
  const lower = reasoning.toLowerCase();
  for (let i = 0; i < CONTRADICTION_PHRASES.length; i++) {
    if (lower.indexOf(CONTRADICTION_PHRASES[i]) >= 0) {
      return CONTRADICTION_PHRASES[i];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 7: merge
// ---------------------------------------------------------------------------

function mergeSuggestions (list, settingType) {
  if (!Array.isArray(list) || !list.length) {
    return null;
  }

  const merged = {
    setting_type: settingType
    , time_blocks: []
    , plain_summary: ''
    , reasoning: ''
    , confidence: 'low'
    , success_criteria: null
    , validation_notes: []
  };

  const reasonings = [];
  list.forEach(function mergeOne (s) {
    if (!isPlainObject(s)) {
      return;
    }
    if (Array.isArray(s.time_blocks)) {
      merged.time_blocks = merged.time_blocks.concat(s.time_blocks);
    }
    if (CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[merged.confidence]) {
      merged.confidence = s.confidence;
    }
    if (typeof s.reasoning === 'string' && s.reasoning.trim()) {
      reasonings.push(s.reasoning.trim());
    }
    if (!merged.success_criteria && isPlainObject(s.success_criteria) &&
      Array.isArray(s.success_criteria.expected_outcomes) && s.success_criteria.expected_outcomes.length) {
      merged.success_criteria = s.success_criteria;
    }
    if (!merged.plain_summary && typeof s.plain_summary === 'string' && s.plain_summary.trim()) {
      merged.plain_summary = s.plain_summary.trim();
    }
    if (Array.isArray(s.validation_notes)) {
      merged.validation_notes = merged.validation_notes.concat(s.validation_notes);
    }
  });

  merged.time_blocks.sort(function byStart (a, b) {
    return a.start_seconds - b.start_seconds;
  });
  merged.reasoning = reasonings.join(' ');

  return merged;
}

// ---------------------------------------------------------------------------
// Snapshot cross-check
// ---------------------------------------------------------------------------

function snapshotValueAt (snapshot, settingType, seconds) {
  if (!isPlainObject(snapshot)) {
    return null;
  }
  const items = snapshot[SNAPSHOT_KEYS[settingType]];
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  let best = null;
  items.forEach(function pick (item) {
    if (!isPlainObject(item)) {
      return;
    }
    const start = toNumber(item.startSeconds);
    const value = toNumber(item.value);
    if (Number.isNaN(start) || Number.isNaN(value)) {
      return;
    }
    if (start <= seconds && (best === null || start >= best.start)) {
      best = { start: start, value: value };
    }
  });
  if (best === null) {
    // before the first scheduled entry: schedules wrap, so use the latest one
    items.forEach(function pickLatest (item) {
      const start = toNumber(item && item.startSeconds);
      const value = toNumber(item && item.value);
      if (!Number.isNaN(start) && !Number.isNaN(value) && (best === null || start > best.start)) {
        best = { start: start, value: value };
      }
    });
  }
  return best === null ? null : best.value;
}

function crossCheckSnapshot (blocks, settingType, snapshot, notes) {
  const rails = GUARDRAILS[settingType];
  blocks.forEach(function check (block) {
    const expected = snapshotValueAt(snapshot, settingType, block.start_seconds);
    if (expected === null) {
      return;
    }
    if (Math.abs(block.current_value - expected) > rails.round + 1e-9) {
      notes.push(blockLabel(settingType, block.start_seconds, block.end_seconds) +
        ': current_value ' + block.current_value + ' differs from profile value ' + expected);
    }
  });
}

// ---------------------------------------------------------------------------
// Past evaluations / success criteria sanitisation
// ---------------------------------------------------------------------------

function sanitizePastEvaluations (raw) {
  const out = {};
  if (!isPlainObject(raw)) {
    return out;
  }
  Object.keys(raw).forEach(function sanitizeOne (key) {
    const entry = raw[key];
    if (!isPlainObject(entry) || VERDICTS.indexOf(entry.verdict) < 0) {
      return;
    }
    const id = stripHtml(key);
    if (!id) {
      return;
    }
    out[id] = {
      criteria_met: Math.max(0, toInt(entry.criteria_met, 0))
      , criteria_total: Math.max(0, toInt(entry.criteria_total, 0))
      , verdict: entry.verdict
      , reasoning: stripHtml(entry.reasoning)
    };
  });
  return out;
}

function sanitizeSuccessCriteria (raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const outcomes = stringList(raw.expected_outcomes);
  if (!outcomes.length) {
    return null;
  }
  let days = toInt(raw.evaluation_days, 5);
  if (days < 1) {
    days = 1;
  }
  if (days > 30) {
    days = 30;
  }
  return {
    expected_outcomes: outcomes
    , evaluation_days: days
    , revert_warnings: stringList(raw.revert_warnings)
    , metric_targets: stringMap(raw.metric_targets)
  };
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

function emptyResult (error, notes) {
  return {
    suggestions: []
    , pastEvaluations: {}
    , overallAssessment: ''
    , nextRecommendedFocus: null
    , validationNotes: notes
    , error: error
  };
}

function parseSettingsResponse (text, opts) {
  opts = opts || {};
  const settingType = opts.settingType;
  if (SETTING_TYPES.indexOf(settingType) < 0) {
    throw new TypeError('parseSettingsResponse requires a valid settingType');
  }
  const notes = [];

  // Stages 1 + 2
  let data;
  try {
    data = parseJsonLenient(text);
  } catch (err) {
    notes.push('response could not be parsed as JSON: ' + err.message);
    return emptyResult('invalid_json', notes);
  }
  if (!isPlainObject(data)) {
    notes.push('response JSON is not an object');
    return emptyResult('invalid_json', notes);
  }

  // Stage 3
  if (isApiEnvelope(data)) {
    notes.push('response is a raw API envelope with no content');
    return emptyResult('empty_thinking_response', notes);
  }

  const pastEvaluations = sanitizePastEvaluations(data.past_suggestion_evaluations);

  // Stages 4, 5, 6, 8
  const rawSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  if (data.suggestions !== undefined && !Array.isArray(data.suggestions)) {
    notes.push('suggestions is not an array; ignored');
  }

  const candidates = [];
  rawSuggestions.forEach(function validateSuggestion (raw, index) {
    const label = 'suggestion #' + index;
    if (!isPlainObject(raw)) {
      notes.push(label + ' is not an object; skipped');
      return;
    }
    if (!Array.isArray(raw.time_blocks)) {
      notes.push(label + ' has no time_blocks array; skipped');
      return;
    }
    if (typeof raw.reasoning !== 'string' || !raw.reasoning.trim()) {
      notes.push(label + ' has no reasoning; skipped');
      return;
    }
    if (CONFIDENCES.indexOf(raw.confidence) < 0) {
      notes.push(label + ' has invalid confidence "' + raw.confidence + '"; skipped');
      return;
    }

    const blockNotes = [];
    const blocks = validateTimeBlocks(raw.time_blocks, settingType, blockNotes);
    if (!blocks.length) {
      notes.push(label + ' has no valid time_blocks after filtering; skipped');
      Array.prototype.push.apply(notes, blockNotes);
      return;
    }
    crossCheckSnapshot(blocks, settingType, opts.snapshot, blockNotes);

    candidates.push({
      setting_type: settingType
      , time_blocks: blocks
      , plain_summary: typeof raw.plain_summary === 'string' ? stripHtml(raw.plain_summary) : ''
      , reasoning: stripHtml(raw.reasoning)
      , confidence: raw.confidence
      , success_criteria: sanitizeSuccessCriteria(raw.success_criteria)
      , validation_notes: blockNotes
    });
  });

  // Stage 7
  const suggestions = [];
  let merged = mergeSuggestions(candidates, settingType);
  if (merged) {
    // Stage 9
    Array.prototype.push.apply(merged.validation_notes, checkCitations(merged.reasoning, opts.hourly));
    // Stage 10
    applyConfidenceCap(merged, settingType, { mealCount: opts.mealCount, correctionCount: opts.correctionCount });
    // Stage 11
    const phrase = hasContradiction(merged.reasoning);
    if (phrase && merged.confidence !== 'low') {
      notes.push('suggestion dropped: reasoning contains "' + phrase + '" with ' + merged.confidence + ' confidence');
      Array.prototype.push.apply(notes, merged.validation_notes);
      merged = null;
    } else {
      suggestions.push(merged);
    }
  }

  const focus = SETTING_TYPES.indexOf(data.next_recommended_focus) >= 0 ? data.next_recommended_focus : null;

  return {
    suggestions: suggestions
    , pastEvaluations: pastEvaluations
    , overallAssessment: stripHtml(data.overall_assessment || '')
    , nextRecommendedFocus: focus
    , validationNotes: notes
    , error: null
  };
}

// ---------------------------------------------------------------------------
// Trends (spec 9.3) and debrief (spec 7.5) plain-text parsers
// ---------------------------------------------------------------------------

const SUMMARY_HEADER = /^\s*[#*_\s]*SUMMARY\b[*_]*\s*:?\s*(.*)$/i;
const HIGHLIGHTS_HEADER = /^\s*[#*_\s]*HIGHLIGHTS?\b[*_]*\s*:?\s*(.*)$/i;
const BULLET = /^\s*[-•*]\s*(.*)$/;

function parseTrends (text) {
  const clean = stripHtml(text);
  const lines = clean.split(/\r?\n/);
  const summaryLines = [];
  const highlights = [];
  const hasSummaryHeader = lines.some(function isHeader (line) {
    return SUMMARY_HEADER.test(line);
  });
  let section = hasSummaryHeader ? null : 'summary';

  lines.forEach(function consume (line) {
    const summaryMatch = line.match(SUMMARY_HEADER);
    if (summaryMatch) {
      section = 'summary';
      if (summaryMatch[1].trim()) {
        summaryLines.push(summaryMatch[1].trim());
      }
      return;
    }
    const highlightsMatch = line.match(HIGHLIGHTS_HEADER);
    if (highlightsMatch) {
      section = 'highlights';
      const rest = highlightsMatch[1].trim();
      if (rest) {
        const bullet = rest.match(BULLET);
        highlights.push(bullet ? bullet[1].trim() : rest);
      }
      return;
    }
    if (!line.trim()) {
      return;
    }
    if (section === 'summary') {
      summaryLines.push(line.trim());
    } else if (section === 'highlights') {
      const bullet = line.match(BULLET);
      if (bullet) {
        if (bullet[1].trim()) {
          highlights.push(bullet[1].trim());
        }
      } else if (highlights.length) {
        // wrapped continuation of the previous bullet
        highlights[highlights.length - 1] += ' ' + line.trim();
      }
    }
  });

  let summary = summaryLines.join(' ').trim();
  if (!summary && !highlights.length) {
    summary = clean;
  }
  return { summary: summary, highlights: highlights };
}

function parseDebrief (text) {
  const clean = stripHtml(text);
  const split = clean.split(/LEARNINGS\s*:/i);
  const body = split[0].trim();
  const learnings = [];

  if (split.length > 1) {
    split.slice(1).join(' ').split(/\r?\n/).forEach(function collect (line) {
      const match = line.match(/^\s*[-*]\s+(.*)$/);
      if (match && match[1].trim()) {
        learnings.push(match[1].trim());
      }
    });
  }
  if (!learnings.length) {
    learnings.push(DEFAULT_LEARNING);
  }

  let effectiveCarbs = null;
  for (let i = 0; i < EFFECTIVE_CARB_PATTERNS.length && effectiveCarbs === null; i++) {
    const match = clean.match(EFFECTIVE_CARB_PATTERNS[i]);
    if (match) {
      effectiveCarbs = parseInt(match[1], 10);
    }
  }

  return { body: body, learnings: learnings, effectiveCarbs: effectiveCarbs };
}

module.exports = {
  GUARDRAILS: GUARDRAILS
  , CONTRADICTION_PHRASES: CONTRADICTION_PHRASES
  , VERDICTS: VERDICTS
  , extractJson: extractJson
  , repairTruncatedJson: repairTruncatedJson
  , parseJsonLenient: parseJsonLenient
  , roundToStep: roundToStep
  , isApiEnvelope: isApiEnvelope
  , validateTimeBlocks: validateTimeBlocks
  , checkCitations: checkCitations
  , applyConfidenceCap: applyConfidenceCap
  , hasContradiction: hasContradiction
  , mergeSuggestions: mergeSuggestions
  , parseSettingsResponse: parseSettingsResponse
  , parseTrends: parseTrends
  , parseDebrief: parseDebrief
};
