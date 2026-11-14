const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Unambiguous consonants for codes humans type (no vowels → no accidental words).
const CODE = "BCDFGHJKLMNPQRSTVWXZ";

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Uniform random string (rejection sampling avoids modulo bias). */
export function randomString(length: number, alphabet = B62): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** 16 chars, 80 bits — primary keys and object keys. */
export const newId = () => randomString(16, B32);
/** Session / API token handed to clients (only its SHA-256 is stored). */
export const newToken = () => `blift_${randomString(32)}`;
/** API key for `blift login --api-key` (only its SHA-256 is stored). */
export const newApiKey = () => `bliftk_${randomString(32)}`;
/** Public share slug (/s/<token>). */
export const newShareToken = () => randomString(12);
/** CLI device-flow code, e.g. WDJB-MJHT. */
export const newUserCode = () => {
  const s = randomString(8, CODE);
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
