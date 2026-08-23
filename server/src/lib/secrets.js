/* Field-level encryption for the few things a queue holds that are genuinely
   personal.

   A customer's phone number is the one piece of data here that would matter if a
   database backup went astray: it identifies a real person and reaches them. It
   is sealed with AES-256-GCM before it is written and opened again on the way
   out, so the staff screen and the printed report are unchanged while the stored
   copy is unreadable on its own.

   Names are deliberately left in the clear: the desk searches them, sorts them,
   and reads them aloud, and encrypting a field the product must query would buy
   nothing but a broken search. */

import crypto from 'node:crypto';
import { config } from '../config.js';

const key = crypto.createHash('sha256').update(`field:${config.sessionSecret}`).digest();
const PREFIX = 'enc1.';

/** Seals a value. Empty input stays empty so "no phone given" round-trips. */
export function sealField(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), body].map(p => p.toString('base64url')).join('.');
}

/**
 * Opens a sealed value. Anything written before this existed is returned as it
 * is, so turning encryption on does not blank out the records already stored.
 */
export function openField(value) {
  const text = String(value ?? '');
  if (!text.startsWith(PREFIX)) return text;
  try {
    const [iv, tag, body] = text.slice(PREFIX.length).split('.').map(p => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // A wrong key or a tampered record: report no phone rather than garbage.
    return '';
  }
}
