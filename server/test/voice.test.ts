import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceVoice } from '../src/ai/voice.ts';

/**
 * These cover the guardrail, not the prompt. The prompts take third-party
 * labels from pervasive to rare; this is what closes the gap, so the cases
 * below are the ones observed leaking out of a real generation.
 */

test('rewrites the object position that models actually leak', () => {
  assert.equal(
    enforceVoice('installed via the workflow described by the author.', 'first-person'),
    'installed via the workflow described by me.',
  );
});

test('rewrites possessives and subjects', () => {
  assert.equal(enforceVoice("the author's notes record it", 'first-person'), 'my notes record it');
  assert.equal(enforceVoice('The author configured DNS.', 'first-person'), 'I configured DNS.');
  assert.equal(enforceVoice('the user then rebooted', 'first-person'), 'I then rebooted');
});

test('follows the plural voice', () => {
  assert.equal(enforceVoice('The author configured DNS.', 'first-person-plural'), 'We configured DNS.');
  assert.equal(enforceVoice('described by the author', 'first-person-plural'), 'described by us');
});

test('drops the attribution entirely for an impersonal document', () => {
  assert.equal(
    enforceVoice('The roles were installed by the author.', 'impersonal'),
    'The roles were installed.',
  );
});

test('leaves other people alone', () => {
  // "the author of" is somebody else — an RFC, a paper, a tool's documentation.
  const cited = 'This follows the recommendation of the author of RFC 2131.';
  assert.equal(enforceVoice(cited, 'first-person'), cited);
});

test('is a no-op on text that never mentions a label', () => {
  const clean = 'I promoted the server to a domain controller and the client joined.';
  assert.equal(enforceVoice(clean, 'first-person'), clean);
});
