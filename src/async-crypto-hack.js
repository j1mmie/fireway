/**
 * This module replaces crypto.randomBytes with a version that avoids
 * dispatching RANDOMBYTESREQUEST async hooks on every call. It is
 * seeded from crypto.randomBytes, but after the first seed, it avoids
 * dispatching those async hooks. How it works:
 *
 *   1. Entropy is obtained from an initial call to crypto.randomBytes
 *   2. A seed is generated from the entropy using a hash function (cyrb128)
 *   3. A random number generator is seeded from the hash function (sfc32)
 *   4. The random number generator is used to generate random bytes
 *
 * More info on the algorithms used here:
 *   https://github.com/bryc/code/blob/master/jshash/PRNGs.md
 */
const crypto = require('crypto')

const entropy = crypto.randomBytes(128)

/**
 * 128-bit Hashing function that is used for generating RNG seeds
 * by bryc (https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript/47593316#47593316)
 */
function cyrb128(buffer) {
  let h1 = 1779033703, h2 = 3144134277,
      h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < buffer.length; i++) {
      k = buffer[i];
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= (h2 ^ h3 ^ h4), h2 ^= h1, h3 ^= h1, h4 ^= h1;
  return [h1>>>0, h2>>>0, h3>>>0, h4>>>0];
}

/**
 * SFC32, a 32-bit Simple Fast Counter Random Number Generator
 */
function sfc32(a, b, c, d) {
  return function() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    var t = (a + b) | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = (c << 21 | c >>> 11);
    d = d + 1 | 0;
    t = t + d | 0;
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  }
}

const seed = cyrb128(entropy)
const rnd = sfc32(seed[0], seed[1], seed[2], seed[3])

function customRandomBytes(size) {
	const arr = new Uint8Array(size)
	for (var i = 0; i < arr.length; i++) {
		arr[i] = Math.floor(256 * rnd());
	}
	return Buffer.from(arr);
}

const originalRandomBytes = crypto.randomBytes

function enable() {
  crypto.randomBytes = customRandomBytes
}

function disable() {
  crypto.randomBytes = originalRandomBytes
}

module.exports = { enable, disable }
