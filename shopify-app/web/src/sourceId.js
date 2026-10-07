import { randomInt } from 'node:crypto';

// NI's SourceID: max 15 characters, alphanumeric only.
// Format: "D" + base36 timestamp (8 chars) + 6 random base36 chars = 15.
// Uppercase so it's easy to read out over the phone to NI support.
// Uniqueness is also enforced by the database's primary key.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function newSourceId(now = Date.now()) {
  const time = now.toString(36).toUpperCase().padStart(8, '0').slice(-8);
  let rand = '';
  for (let i = 0; i < 6; i++) rand += ALPHABET[randomInt(ALPHABET.length)];
  return `D${time}${rand}`;
}

export function isValidSourceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{1,15}$/.test(id);
}
