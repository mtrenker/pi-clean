const assert = require('node:assert/strict');
const test = require('node:test');

const { analyzePackage, VERIFIED_PACKAGES } = require('./detect-typosquatting.js');

test('verified official packages bypass name-only false positives', () => {
  assert.equal(VERIFIED_PACKAGES.has('@platejs/core'), true);
  assert.deepEqual(analyzePackage('@platejs/core'), {
    package: '@platejs/core',
    risks: [],
    overallRisk: 'low',
    verified: true,
  });
});

test('unverified close spellings remain high risk', () => {
  const result = analyzePackage('reeact');
  assert.equal(result.overallRisk, 'high');
  assert.equal(result.risks.some((risk) => risk.similarTo === 'react'), true);
});
