import assert from 'assert';
import { extractFinalJson } from '../src/index.js';

// Note: extractFinalJson is defined in index.js as a top-level function.

console.log('Running extractFinalJson tests');

const sample1 = 'data: {"id":1}\n\n{"model":"gpt-3.5","usage":{"prompt_tokens":10,"completion_tokens":5}}';
const res1 = extractFinalJson(sample1);
assert.ok(res1 && res1.usage && res1.model === 'gpt-3.5', 'Should parse trailing JSON');

const sample2 = 'some text\n{ "model":"gpt-4", "usage": {"prompt_tokens":2, "completion_tokens":3} }\n';
const res2 = extractFinalJson(sample2);
assert.ok(res2 && res2.usage && res2.model === 'gpt-4', 'Should parse last brace JSON');

console.log('✅ extractFinalJson tests passed');
