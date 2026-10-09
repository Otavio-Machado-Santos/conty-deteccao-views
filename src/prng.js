/**
 * PRNG determinística (mulberry32) para o dataset sintético.
 * A mesma seed sempre produz a mesma sequência de floats em [0, 1).
 */
export function createPrng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(prng, minInclusive, maxExclusive) {
  return minInclusive + Math.floor(prng() * (maxExclusive - minInclusive));
}

export function gaussian(prng, mean = 0, stdDev = 1) {
  // Box-Muller com os dois uniforms da sequência (consistente entre execuções).
  const u1 = Math.max(prng(), Number.EPSILON);
  const u2 = prng();
  const mag = Math.sqrt(-2 * Math.log(u1));
  return mean + stdDev * mag * Math.cos(2 * Math.PI * u2);
}
