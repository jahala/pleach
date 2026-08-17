// The canary's fitness function. RED until work.command writes tools/wordcount.mjs.

import assert from 'node:assert/strict';
import { wordcount } from '../tools/wordcount.mjs';

assert.equal(wordcount('the quick brown fox'), 4);
assert.equal(wordcount('  spaced   out  '), 2);
assert.equal(wordcount(''), 0);
assert.equal(wordcount('one'), 1);
console.log('wordcount ok');
