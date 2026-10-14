const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTypoSuggestion,
  isDisposableDomain,
  evaluateDomainHeuristics,
} = require('./emailDomainHeuristics.service');

test('getTypoSuggestion maps common gmail typos', () => {
  assert.deepEqual(getTypoSuggestion('gmial.com'), { from: 'gmial.com', to: 'gmail.com' });
  assert.deepEqual(getTypoSuggestion('gamil.com'), { from: 'gamil.com', to: 'gmail.com' });
  assert.equal(getTypoSuggestion('gmail.com'), null);
});

test('isDisposableDomain detects known throwaway domains', () => {
  assert.equal(isDisposableDomain('mailinator.com'), true);
  assert.equal(isDisposableDomain('gmail.com'), false);
});

test('evaluateDomainHeuristics rejects typo domains with suggestion', () => {
  const result = evaluateDomainHeuristics('owner@gmial.com');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMAIL_TYPO_DOMAIN');
  assert.equal(result.suggestion, 'owner@gmail.com');
  assert.match(result.message, /Did you mean owner@gmail\.com/);
});

test('evaluateDomainHeuristics rejects disposable domains', () => {
  const result = evaluateDomainHeuristics('x@yopmail.com');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMAIL_DISPOSABLE_DOMAIN');
});

test('evaluateDomainHeuristics accepts normal domains', () => {
  assert.deepEqual(evaluateDomainHeuristics('owner@gmail.com'), { ok: true });
});
