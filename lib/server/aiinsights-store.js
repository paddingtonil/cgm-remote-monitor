'use strict';

// Storage adapter for the AI Insights plugin collections
// (docs/proposals/ai-insights-design.md section 6).
//
// Four collections, all named through env:
//   ai_suggestions  one document per validated, merged suggestion
//   ai_analyses     every provider call (cache + audit); chat/trends expire
//   ai_usage        cost ledger for the monthly budget
//   ai_settings     a single document (_id 'default') of user-editable settings
//
// Promise-based on purpose: the only callers are lib/aiinsights/* and the
// aiinsights router, none of which use the legacy callback style.

function storage (env, ctx) {
  var purifyForStorage = require('./storage-purifier');

  // Analyses of these kinds are cache entries, not clinical history, and
  // expire after EXPIRING_KINDS_TTL_DAYS via a TTL index on `expires_at`
  // (a real Date; Nightscout's ISO-string created_at cannot carry a TTL).
  var EXPIRING_KINDS = ['chat', 'trends', 'connection_test', 'meal_advice', 'pre_meal'];
  var EXPIRING_KINDS_TTL_DAYS = 180;

  function suggestions () { return ctx.store.collection(env.ai_suggestions_collection); }
  function analyses () { return ctx.store.collection(env.ai_analyses_collection); }
  function usage () { return ctx.store.collection(env.ai_usage_collection); }
  function settings () { return ctx.store.collection(env.ai_settings_collection); }

  function nowISO () {
    return new Date().toISOString();
  }

  // ---- settings -----------------------------------------------------------

  async function getSettings () {
    return settings().findOne({ _id: 'default' });
  }

  async function saveSettings (doc) {
    doc._id = 'default';
    doc.modified_at = nowISO();
    purifyForStorage(ctx, doc);
    await settings().replaceOne({ _id: 'default' }, doc, { upsert: true });
    return doc;
  }

  // ---- analyses -----------------------------------------------------------

  async function insertAnalysis (doc) {
    if (!doc.created_at) { doc.created_at = nowISO(); }
    if (EXPIRING_KINDS.indexOf(doc.kind) > -1 && !doc.expires_at) {
      doc.expires_at = new Date(Date.now() + EXPIRING_KINDS_TTL_DAYS * 86400000);
    }
    purifyForStorage(ctx, doc);
    var result = await analyses().insertOne(doc);
    doc._id = result.insertedId;
    return doc;
  }

  async function listAnalyses (filter, limit) {
    return analyses().find(filter || { }).sort({ created_at: -1 }).limit(limit || 10).toArray();
  }

  async function latestAnalysis (filter) {
    var rows = await listAnalyses(filter, 1);
    return rows.length ? rows[0] : null;
  }

  async function getAnalysis (id) {
    var idForms = require('./object-id-forms');
    return analyses().findOne({ _id: idForms.toStoredId(String(id)) });
  }

  // ---- suggestions --------------------------------------------------------

  async function insertSuggestions (docs) {
    if (!Array.isArray(docs)) { docs = [docs]; }
    if (docs.length === 0) { return []; }
    docs.forEach(function stamp (doc) {
      if (!doc.created_at) { doc.created_at = nowISO(); }
      if (!doc.status) { doc.status = 'pending'; }
      if (!doc.status_changed_at) { doc.status_changed_at = doc.created_at; }
    });
    purifyForStorage(ctx, docs);
    await suggestions().insertMany(docs);
    return docs;
  }

  async function listSuggestions (filter, limit) {
    return suggestions().find(filter || { }).sort({ created_at: -1 }).limit(limit || 50).toArray();
  }

  async function getSuggestion (recordId) {
    return suggestions().findOne({ record_id: String(recordId) });
  }

  async function updateSuggestion (recordId, patch) {
    patch = Object.assign({ }, patch);
    delete patch._id;
    delete patch.record_id;
    purifyForStorage(ctx, patch);
    var result = await suggestions().findOneAndUpdate(
      { record_id: String(recordId) }
      , { $set: patch }
      , { returnDocument: 'after' }
    );
    // mongodb 5.x returns { value }, 6.x returns the document itself
    return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
  }

  async function supersedePending (settingType, exceptRecordIds) {
    var filter = { setting_type: settingType, status: 'pending' };
    if (exceptRecordIds && exceptRecordIds.length) {
      filter.record_id = { $nin: exceptRecordIds };
    }
    var result = await suggestions().updateMany(filter, {
      $set: { status: 'superseded', status_changed_at: nowISO() }
    });
    return result.modifiedCount || 0;
  }

  // ---- usage --------------------------------------------------------------

  async function insertUsage (doc) {
    if (!doc.created_at) { doc.created_at = nowISO(); }
    purifyForStorage(ctx, doc);
    var result = await usage().insertOne(doc);
    doc._id = result.insertedId;
    return doc;
  }

  async function monthSpent (month) {
    var rows = await usage().aggregate([
      { $match: { month: month } }
      , { $group: { _id: null, total: { $sum: '$estimated_cost_usd' }, count: { $sum: 1 } } }
    ]).toArray();
    if (!rows.length) { return { month: month, totalUsd: 0, count: 0 }; }
    return { month: month, totalUsd: rows[0].total || 0, count: rows[0].count || 0 };
  }

  // ---- indexes ------------------------------------------------------------

  function ensureIndexes () {
    ctx.store.ensureIndexes(suggestions(), ['setting_type', 'status', 'created_at']);
    ctx.store.ensureIndexes(analyses(), ['kind', 'created_at', 'job_id']);
    ctx.store.ensureIndexes(usage(), ['month', 'created_at']);
    suggestions().createIndex({ record_id: 1 }, { unique: true }).catch(function onError (err) {
      console.error('aiinsights: unable to create record_id index', err.message);
    });
    analyses().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }).catch(function onError (err) {
      console.error('aiinsights: unable to create TTL index', err.message);
    });
  }

  return {
    suggestions: suggestions
    , analyses: analyses
    , usage: usage
    , settings: settings
    , getSettings: getSettings
    , saveSettings: saveSettings
    , insertAnalysis: insertAnalysis
    , listAnalyses: listAnalyses
    , latestAnalysis: latestAnalysis
    , getAnalysis: getAnalysis
    , insertSuggestions: insertSuggestions
    , listSuggestions: listSuggestions
    , getSuggestion: getSuggestion
    , updateSuggestion: updateSuggestion
    , supersedePending: supersedePending
    , insertUsage: insertUsage
    , monthSpent: monthSpent
    , ensureIndexes: ensureIndexes
    , EXPIRING_KINDS: EXPIRING_KINDS
  };
}

module.exports = storage;
