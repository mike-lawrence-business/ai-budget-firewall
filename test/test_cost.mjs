import assert from 'assert';
import { estimateCost } from '../src/costs.js';

// Basic tests
const c1 = estimateCost('gpt-3.5-turbo', 1000, 1000);
console.log('gpt-3.5 cost for 2k tokens:', c1);
assert(Math.abs(c1 - ((1000/1000)*0.0005 + (1000/1000)*0.0015)) < 1e-12);

const c2 = estimateCost('gpt-4', 500, 500);
console.log('gpt-4 cost for 1k tokens:', c2);
assert(Math.abs(c2 - ((500/1000)*0.03 + (500/1000)*0.06)) < 1e-12);

console.log('All cost tests passed');
