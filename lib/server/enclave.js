'use strict;'

const path = require('path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');

// this is a class for holding potentially sensitive data in the app
// the class also implement functions to use the data, so the data is not shared outside the class

const init = function init () {

  const enclave = {};
  const secrets = {};
  const apiKey = Symbol('api-secret');
  const apiKeySHA1 = Symbol('api-secretSHA1');
  const apiKeySHA512 = Symbol('api-secretSHA512');
  const jwtKey = Symbol('jwtkey');
  const aiApiKey = Symbol('aiinsights-api-key');
  let apiKeySet = false;
  let aiApiKeySet = false;

  function readKey (filename) {
    let filePath = path.resolve(__dirname + '/../../node_modules/.cache/_ns_cache/' + filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath).toString().trim();
    }
    console.error('Key file ', filePath, 'not found');
    return null;
  }

  secrets[jwtKey] = readKey('randomString');

  function genHash(data, algorihtm) {
    const hash = crypto.createHash(algorihtm);
    data = hash.update(data, 'utf-8');
    return data.digest('hex').toLowerCase();
  }

  enclave.setApiKey = function setApiKey (keyValue) {
    if (keyValue.length < 12) return;
    apiKeySet = true;
    secrets[apiKey] = keyValue;
    secrets[apiKeySHA1] = genHash(keyValue,'sha1');
    secrets[apiKeySHA512] = genHash(keyValue,'sha512');
  }

  enclave.isApiKeySet = function isApiKeySet () {
    return apiKeySet;
  }

  enclave.isApiKey = function isApiKey (keyValue) {
    return keyValue.toLowerCase() == secrets[apiKeySHA1] || keyValue == secrets[apiKeySHA512];
  }

  // AI Insights provider key (docs/proposals/ai-insights-design.md 11.1).
  // Held only here; never copied into env.settings, extendedSettings or Mongo.
  // Callers pass the key straight into an outbound request header and must
  // not log or persist the returned value.
  enclave.setAiApiKey = function setAiApiKey (keyValue) {
    if (typeof keyValue !== 'string' || keyValue.length === 0) return;
    aiApiKeySet = true;
    secrets[aiApiKey] = keyValue;
  }

  enclave.isAiApiKeySet = function isAiApiKeySet () {
    return aiApiKeySet;
  }

  enclave.withAiApiKey = function withAiApiKey (fn) {
    return fn(aiApiKeySet ? secrets[aiApiKey] : null);
  }

  enclave.setJWTKey = function setJWTKey (keyValue) {
    secrets[jwtKey] = keyValue;
  }

  enclave.signJWT = function signJWT(token, lifetime) {
    const lt = lifetime ? lifetime : '8h';
    return jwt.sign(token, secrets[jwtKey], { expiresIn: lt });
  }

  enclave.verifyJWT = function verifyJWT(tokenString) {
    try {
      return jwt.verify(tokenString, secrets[jwtKey]);
    } catch(err) {
      return null;
    }
  }

  enclave.getSubjectHash = function getSubjectHash(id) {
    var shasum = crypto.createHash('sha1');
    shasum.update(secrets[apiKeySHA1]);
    shasum.update(id);
    return shasum.digest('hex').toLowerCase();
  }

  return enclave;
}

module.exports = init;
