'use strict';

// In-memory job queue for provider calls (docs/proposals/ai-insights-design.md 7.4).
//
// A provider call can take up to 60 s and common Nightscout hosts (Heroku,
// Railway, Fly) cut HTTP requests at ~30 s, so every analysis runs as a job:
// POST answers 202 + jobId, the browser polls GET /jobs/:id. Nightscout is a
// single process, so a Map is enough. Completed results are persisted by the
// job's own `run` function before the job is marked done, so a restart loses
// at most an in-flight call, never a finished one.

var crypto = require('crypto');

function createJobs (opts) {
  opts = opts || { };
  var concurrency = opts.concurrency || 1;
  var ttlMs = opts.ttlMs || 15 * 60 * 1000;
  var now = opts.now || function () { return Date.now(); };

  var jobs = new Map();
  var queue = [];
  var running = 0;

  function publicView (job) {
    return {
      jobId: job.id
      , kind: job.kind
      , status: job.status
      , progress: job.progress
      , createdAt: job.createdAt
      , startedAt: job.startedAt
      , finishedAt: job.finishedAt
      , result: job.status === 'done' ? job.result : undefined
      , error: job.status === 'failed' ? job.error : undefined
    };
  }

  function findActive (predicate) {
    for (var job of jobs.values()) {
      if ((job.status === 'queued' || job.status === 'running') && predicate(job)) {
        return job;
      }
    }
    return null;
  }

  function cleanup () {
    var cutoff = now() - ttlMs;
    for (var [id, job] of jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) {
        jobs.delete(id);
      }
    }
  }

  function runNext () {
    while (running < concurrency && queue.length) {
      var job = queue.shift();
      running += 1;
      job.status = 'running';
      job.startedAt = now();
      var progress = function setProgress (text) { job.progress = String(text); };
      Promise.resolve()
        .then(function start () { return job.run({ progress: progress, jobId: job.id }); })
        .then(function done (result) {
          job.status = 'done';
          job.result = result === undefined ? null : result;
        }, function failed (err) {
          job.status = 'failed';
          job.error = {
            message: err && err.message ? String(err.message) : String(err)
            , code: err && err.code ? String(err.code) : (err && err.name ? String(err.name) : 'error')
            , status: err && typeof err.status === 'number' ? err.status : undefined
          };
          if (opts.log !== false) {
            console.error('[aiinsights] job ' + job.kind + ' failed: ' + job.error.message);
          }
        })
        .then(function finish () {
          job.finishedAt = now();
          running -= 1;
          cleanup();
          runNext();
        });
    }
  }

  /**
   * submit({ kind, key, run }) -> public job view.
   * `run({ progress, jobId })` returns a promise with the result.
   * When `key` is given and a queued/running job has the same key, that job
   * is returned instead of starting a duplicate.
   */
  function submit (spec) {
    if (!spec || typeof spec.run !== 'function') {
      throw new TypeError('jobs.submit requires a run function');
    }
    if (spec.key) {
      var existing = findActive(function sameKey (j) { return j.key === spec.key; });
      if (existing) { return Object.assign(publicView(existing), { deduplicated: true }); }
    }
    var job = {
      id: crypto.randomUUID()
      , kind: spec.kind || 'job'
      , key: spec.key || null
      , run: spec.run
      , status: 'queued'
      , progress: null
      , createdAt: now()
      , startedAt: null
      , finishedAt: null
      , result: null
      , error: null
    };
    jobs.set(job.id, job);
    queue.push(job);
    runNext();
    return publicView(job);
  }

  function get (id) {
    var job = jobs.get(id);
    return job ? publicView(job) : null;
  }

  function hasActive (kind) {
    return findActive(function sameKind (j) { return !kind || j.kind === kind; }) !== null;
  }

  function activeCount () {
    var n = 0;
    for (var job of jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') { n += 1; }
    }
    return n;
  }

  return {
    submit: submit
    , get: get
    , hasActive: hasActive
    , activeCount: activeCount
    , cleanup: cleanup
  };
}

module.exports = createJobs;
