'use strict';

// Shared type contract for the AI Insights plugin (docs/proposals/ai-insights-design.md).
// All glucose values are mg/dL. All times are epoch milliseconds unless the
// field name says otherwise. Every module under lib/aiinsights/ consumes or
// produces the shapes documented here; keep this file in sync with them.

/**
 * @typedef {'basal_rate'|'carb_ratio'|'insulin_sensitivity'} SettingType
 */
const SETTING_TYPES = ['basal_rate', 'carb_ratio', 'insulin_sensitivity'];

const SETTING_LABELS = {
  basal_rate: 'Basal Rate'
  , carb_ratio: 'Carb Ratio'
  , insulin_sensitivity: 'Insulin Sensitivity'
};

const SETTING_UNITS = {
  basal_rate: 'U/hr'
  , carb_ratio: 'g/U'
  , insulin_sensitivity: 'mg/dL per U'
};

/** @typedef {'low'|'medium'|'high'} Confidence */
const CONFIDENCES = ['low', 'medium', 'high'];

/** @typedef {'supportive_coach'|'clinical_expert'|'dry_wit'|'tough_love'} Personality */
const PERSONALITIES = ['supportive_coach', 'clinical_expert', 'dry_wit', 'tough_love'];

const ANALYSIS_PERIODS = [3, 7, 14, 30, 90];

// Canonical glucose thresholds (spec 5.1)
const THRESHOLDS = {
  urgentLow: 54
  , low: 70
  , overnightLow: 80
  , high: 180
  , overnightHigh: 200
  , veryHigh: 250
};

/**
 * One scheduled value of a therapy setting.
 * @typedef {Object} ScheduleItem
 * @property {number} startSeconds  seconds since midnight (0..86399)
 * @property {number} value         U/hr, g/U or mg/dL per U
 */

/**
 * Snapshot of the therapy settings in force at the end of the window (spec 6.2 step 3).
 * @typedef {Object} TherapySnapshot
 * @property {ScheduleItem[]} basal
 * @property {ScheduleItem[]} carbratio
 * @property {ScheduleItem[]} sens           always mg/dL per U (converted from mmol if needed)
 * @property {number|null}    dia            hours
 * @property {string}         insulinType    e.g. 'Novolog', 'Fiasp', 'Unknown'
 * @property {string}         profileName
 * @property {string|null}    profileId      profile document _id
 * @property {string}         profileUnits   'mg/dl' | 'mmol' as stored in the profile
 * @property {string}         system         'Loop' | 'AAPS' | 'Trio' | 'oref0' | 'Unknown'
 * @property {string}         timezone       IANA zone used for local-hour bucketing
 */

/**
 * @typedef {Object} HourlyAverage
 * @property {number}      hour   0..23 local hour
 * @property {number|null} mean   mg/dL, null when no readings in that hour
 * @property {number}      count
 */

/**
 * @typedef {Object} GlucoseStats
 * @property {number} count
 * @property {number|null} mean
 * @property {number|null} sd            population SD (divide by n)
 * @property {number|null} cv            sd / mean * 100
 * @property {number} veryHighPct        > 250
 * @property {number} highPct            180 < v <= 250
 * @property {number} inRangePct         70 <= v <= 180   (TIR)
 * @property {number} lowPct             54 <= v < 70
 * @property {number} veryLowPct         < 54
 * @property {number} tirPct             alias of inRangePct
 * @property {number} titrPct            70 <= v <= tightRangeUpperBound
 * @property {number} tbrPct             < 70
 * @property {number} tarPct             > 180
 * @property {number|null} gmi           3.31 + 0.02392 * mean
 * @property {HourlyAverage[]} hourly    24 entries, index == hour
 * @property {Object.<string, (number|null)[]>} hourlyByDay  'YYYY-MM-DD' -> 24 means (chat context, 9.5)
 * @property {{mills:number, mgdl:number}[]} readings   sorted ascending
 */

/**
 * One bolus-like treatment after normalisation.
 * @typedef {Object} BolusEvent
 * @property {number} mills
 * @property {number} units
 * @property {number|null} carbs
 * @property {boolean} isCorrection   spec 5.3 step 6
 * @property {boolean} automatic      Loop `automatic: true` when present
 * @property {string}  eventType
 * @property {string|null} id
 */

/**
 * @typedef {Object} DailyInsulin
 * @property {string} date    'YYYY-MM-DD' in profile timezone
 * @property {number} basal   U
 * @property {number} bolus   U
 * @property {number} total   U
 */

/**
 * @typedef {Object} SuspensionStats  (spec 6.6.2)
 * @property {number} events
 * @property {number} totalMinutes
 * @property {number} pctOfPeriod
 * @property {number} subBasalMinutes
 * @property {number} overcorrectionEvents   suspend -> >180 within 2h of resume
 * @property {{hour:number, minutes:number}[]} byHour   24 entries
 */

/**
 * @typedef {Object} InsulinStats
 * @property {number|null} tddAvg
 * @property {number|null} tddMin
 * @property {number|null} tddMax
 * @property {number|null} tddCv
 * @property {number|null} tddWeekOverWeekPct   null unless >= 14 days
 * @property {number} basalTotal
 * @property {number} bolusTotal
 * @property {number|null} basalPct
 * @property {number|null} bolusPct
 * @property {number} correctionCount
 * @property {number} automaticCorrectionCount
 * @property {number} correctionsPerDay
 * @property {DailyInsulin[]} daily
 * @property {BolusEvent[]} boluses
 * @property {SuspensionStats} suspensions
 * @property {'reconstructed'|'reported'} source
 */

/**
 * @typedef {Object} CarbEntry
 * @property {number} mills
 * @property {number} grams
 * @property {string|null} foodType
 * @property {number|null} protein
 * @property {number|null} fat
 * @property {number|null} fiber
 * @property {number|null} absorptionTime  minutes
 * @property {string|null} id   treatment _id
 */

/**
 * @typedef {Object} CarbStats
 * @property {number} dailyAvg
 * @property {number} entryCount
 * @property {number|null} perMealAvg
 * @property {number[]} byHour     24 counts
 * @property {CarbEntry[]} entries deduplicated (spec 7.1 step 1), ascending
 */

/**
 * The single aggregation result shared by every prompt and analyzer (spec 6.3).
 * @typedef {Object} AggregatedData
 * @property {{days:number, fromMs:number, toMs:number, timezone:string}} period
 * @property {GlucoseStats} glucose
 * @property {InsulinStats} insulin
 * @property {CarbStats} carbs
 * @property {TherapySnapshot} settings
 * @property {number} tightRangeUpperBound
 * @property {Object[]} devicestatus   raw docs with `loop` or `openaps`, ascending (debrief, live status)
 * @property {Object[]} [treatments]   raw treatments inside the window, ascending, each with `mills`
 */

/**
 * @typedef {Object} TimeBlock
 * @property {number} start_seconds
 * @property {number} end_seconds
 * @property {number} current_value
 * @property {number} proposed_value
 */

/**
 * @typedef {Object} SuccessCriteria
 * @property {string[]} expected_outcomes
 * @property {number}   evaluation_days
 * @property {string[]} revert_warnings
 * @property {Object.<string,string>} metric_targets
 */

/**
 * A validated, merged suggestion (one per setting type per analysis).
 * @typedef {Object} Suggestion
 * @property {SettingType} setting_type
 * @property {TimeBlock[]} time_blocks
 * @property {string} plain_summary
 * @property {string} reasoning
 * @property {Confidence} confidence
 * @property {SuccessCriteria|null} success_criteria
 * @property {string[]} validation_notes
 */

/**
 * @typedef {Object} PastEvaluation
 * @property {number} criteria_met
 * @property {number} criteria_total
 * @property {'success'|'partial'|'no_improvement'|'worsened'|'insufficient_data'} verdict
 * @property {string} reasoning
 */

/**
 * Output of validator.parseSettingsResponse.
 * @typedef {Object} ParsedSettingsResponse
 * @property {Suggestion[]} suggestions                   0 or 1 entries after merge
 * @property {Object.<string, PastEvaluation>} pastEvaluations   keyed by record_id
 * @property {string} overallAssessment
 * @property {SettingType|null} nextRecommendedFocus
 * @property {string[]} validationNotes
 * @property {string|null} error        non-null means the whole response was rejected
 */

/**
 * Input to prompts/settings.userPrompt (spec 6.5). Everything optional is
 * rendered only when present.
 * @typedef {Object} SettingsPromptInput
 * @property {SettingType} settingType
 * @property {AggregatedData} agg
 * @property {Object[]} pastOutcomes      [{ record_id, applied_days_ago, change_description, evaluation_days, expected_outcomes[], revert_warnings[], post_change_hourly: HourlyAverage[] }]
 * @property {Object[]} recentChanges     [{ applied_ago_text, change_description }]
 * @property {string}   supplementalContext   spec 6.6, may be ''
 * @property {string}   biometricContext      '' unless activity data exists
 */

/**
 * Detected local pattern (spec 6.9).
 * @typedef {Object} DetectedPattern
 * @property {string} id         e.g. 'overnight_lows'
 * @property {string} title      e.g. 'Overnight Lows'
 * @property {'medium'|'high'} severity
 * @property {string} description
 */

/**
 * Settings score (spec 6.10).
 * @typedef {Object} SettingsScore
 * @property {number} total  0..100
 * @property {'A'|'B'|'C'|'D'|'F'} grade
 * @property {{tir:number, tbr:number, cv:number, gmi:number}} components
 * @property {boolean} settingsAlreadyOptimal   TIR > 85 && TBR < 4
 */

module.exports = {
  SETTING_TYPES
  , SETTING_LABELS
  , SETTING_UNITS
  , CONFIDENCES
  , PERSONALITIES
  , ANALYSIS_PERIODS
  , THRESHOLDS
};
