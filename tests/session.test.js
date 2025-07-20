const assert = require('assert');
const {isWithinSession} = require('../src/utils/session');

// 10:00 WIB should be false
assert.strictEqual(isWithinSession(new Date('2025-06-30T03:00:00Z')), false);
// 15:00 WIB should be true
assert.strictEqual(isWithinSession(new Date('2025-06-30T08:00:00Z')), true);
// 00:30 WIB should be true
assert.strictEqual(isWithinSession(new Date('2025-06-30T17:30:00Z')), true);

console.log('session tests passed');
