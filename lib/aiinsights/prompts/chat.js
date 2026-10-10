'use strict';

// Ask Loopy chat prompts (spec 9.5).

const units = require('./units');

// Spec lines 1057-1076, verbatim.
const SYSTEM_TEMPLATE = [
  'You\'re a diabetes-savvy friend who can see this person\'s actual Loop data. They know how diabetes works — skip the textbook stuff.'
  , ''
  , '{{PERSONALITY}}'
  , ''
  , 'RULES:'
  , '- You are talking directly TO them. Address them as "you"/"your" — never "the user",   "this user", "this person", or any other third-person reference.'
  , '- Be brief. 2-3 sentences max for simple questions. Bullets for complex ones.'
  , '- Just the facts — cite their specific numbers, skip explanations they already know.'
  , '- Talk like a knowledgeable friend, not a doctor or a manual.'
  , '- Never explain what a carb ratio, ISF, or basal rate IS. They know.'
  , '- If they ask "why am I high overnight?" — give their overnight avg and what\'s   likely causing it. Don\'t explain what overnight highs are.'
  , '- If data says something clearly, say it directly. No hedging.'
  , '- For settings changes: current value → suggested value → why, in one line.'
  , '- Never fabricate numbers. Only reference what\'s in the data below.'
  , '- If no data is available, just say so briefly.'
  , '- NEVER give unsolicited praise, encouragement, or reassurance. No "Great job!",   "You\'re doing well!", "Keep it up!" or similar. Just answer the question.   If they ask how they\'re doing, then evaluate honestly. Otherwise, skip it entirely.'
  , '{{UNIT_CONTEXT}}'
  , ''
  , 'DATA:'
  , '{context}'
].join('\n');

const MAX_HISTORY = 10;

const NO_DATA = 'No therapy data currently available.';

/**
 * System prompt (spec 9.5) with {{PERSONALITY}}, {{UNIT_CONTEXT}} and {context}
 * substituted. `context` is the prebuilt DATA block (therapy context, live
 * glucose, supplemental context, live loop status) assembled by the caller.
 * @param {{personality?: string, context?: string}} [opts]
 */
function systemPrompt (opts) {
  const o = opts || {};
  const ctx = o.context && String(o.context).trim() ? o.context : NO_DATA;
  return SYSTEM_TEMPLATE
    .replace('{{PERSONALITY}}', units.personality(o.personality))
    .replace('{{UNIT_CONTEXT}}', units.unitContext())
    .replace('{context}', function replaceContext () { return ctx; });
}

/**
 * User prompt (spec 9.5): the message alone, or with the last 10 history
 * messages prepended as 'CONVERSATION HISTORY:'.
 * @param {{message: string, history?: {role: 'user'|'assistant', content: string}[]}} input
 */
function userPrompt (input) {
  const i = input || {};
  const message = i.message === undefined || i.message === null ? '' : String(i.message);
  const history = Array.isArray(i.history) ? i.history.slice(-MAX_HISTORY) : [];
  if (!history.length) {
    return message;
  }
  const turns = history.map(function eachTurn (turn) {
    const who = turn.role === 'assistant' ? 'Assistant' : 'User';
    return who + ': ' + (turn.content === undefined || turn.content === null ? '' : String(turn.content));
  });
  turns.push('User: ' + message);
  return 'CONVERSATION HISTORY:\n' + turns.join('\n\n');
}

module.exports = {
  systemPrompt
  , userPrompt
  , MAX_HISTORY
};
