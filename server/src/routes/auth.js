/* Identity endpoints. Firebase owns authentication; this file only mirrors the
   verified user into MongoDB and reports what that user may act on. */

import { Router } from 'express';
import { col, collections } from '../db.js';
import { requireUser, withProfile, listBusinessesFor } from '../middleware/auth.js';
import { parse } from '../lib/validate.js';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { HttpError } from '../lib/errors.js';
import {
  setSessionCookie, clearSessionCookie, readSessionCookie,
  exchangeRefreshToken, requireClientHeader
} from '../lib/session.js';

const router = Router();

const sessionLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

/* ---------- session ----------

   The browser signs in with Firebase directly, then hands the refresh token here
   once. From that moment the long-lived secret lives in an HttpOnly cookie and
   the tab keeps only an in-memory access token, which this endpoint re-mints. */

const sessionPayload = data => ({
  accessToken: data.access_token,
  expiresIn: data.expires_in || 3600,
  user: data.user ? { id: data.user.id, email: data.user.email } : null
});

/** Hands over a fresh sign-in: stores the refresh token, returns an access token. */
router.post('/session', sessionLimiter, requireClientHeader, async (req, res, next) => {
  try {
    const refreshToken = String(req.body?.refreshToken || '');
    if (!refreshToken) throw new HttpError(400, 'No session to store.');
    const data = await exchangeRefreshToken(refreshToken);
    setSessionCookie(res, data.refresh_token);
    res.json(sessionPayload(data));
  } catch (error) { next(error); }
});

/** Restores a session on page load, or renews one that is about to expire. */
router.get('/session', sessionLimiter, requireClientHeader, async (req, res, next) => {
  try {
    const stored = readSessionCookie(req);
    if (!stored) return res.status(204).end();
    try {
      const data = await exchangeRefreshToken(stored);
      setSessionCookie(res, data.refresh_token);
      res.json(sessionPayload(data));
    } catch (error) {
      clearSessionCookie(res); // the refresh token is spent or revoked
      throw error;
    }
  } catch (error) { next(error); }
});

router.delete('/session', sessionLimiter, requireClientHeader, async (req, res, next) => {
  try {
    clearSessionCookie(res);
    /* Dropping the cookie is the sign-out. Firebase has no revoke endpoint that
       works without a service account, and the id token it held expires within
       the hour on its own — so there is nothing to wait for on the way out. */
    res.status(204).end();
  } catch (error) { next(error); }
});

const profileSchema = z.object({
  name: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(40).optional(),
  avatar: z.string().trim().max(512).optional()
});

/** Called right after sign-in: creates the profile, links pending invitations. */
router.get('/me', requireUser, withProfile, async (req, res, next) => {
  try {
    const email = (req.user.email || '').toLowerCase();

    /* An invited member signs up with the invited address. The seat only binds
       once Firebase says that mailbox is confirmed — otherwise anyone who knows
       a colleague's address could register it and inherit their role. The claim
       is inside the signed token, so there is nothing to go and ask. */
    if (email && req.user.emailVerified === true) {
      await col(collections.members).updateMany(
        { email, status: 'invited' },
        { $set: { userId: req.user.id, status: 'active', updatedAt: new Date() } }
      );
      await col(collections.invitations).updateMany(
        { email, acceptedAt: null },
        { $set: { acceptedAt: new Date() } }
      );
    }

    const businesses = await listBusinessesFor(req.authIds || [req.user.id]);

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email || '',
        emailVerified: req.user.emailVerified === true,
        name: req.profile.name || '',
        phone: req.profile.phone || '',
        avatar: req.profile.avatar || ''
      },
      businesses: businesses.map(b => ({
        id: String(b._id),
        name: b.name,
        slug: b.slug,
        role: b.role,
        logo: b.logo || '',
        onboarded: Boolean(b.onboarded)
      }))
    });
  } catch (error) { next(error); }
});

router.patch('/me', requireUser, withProfile, async (req, res, next) => {
  try {
    const input = parse(profileSchema, req.body);
    /* withProfile has already found or created this profile, so update it by its
       own _id. Keying off a uid field here is what broke sign-up: a brand-new
       account matched nothing, the update returned null, and reading a name off
       null threw a 500 in the middle of creating an account. */
    const profile = await col(collections.profiles).findOneAndUpdate(
      { _id: req.profile._id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!profile) throw new HttpError(404, 'That account no longer exists.');

    // Every id this person is known by, so a rename reaches older seats too.
    await col(collections.members).updateMany(
      { userId: { $in: req.authIds?.length ? req.authIds : [req.user.id] } },
      { $set: { name: profile.name || '', updatedAt: new Date() } }
    );
    res.json({
      user: { id: req.user.id, email: req.user.email, name: profile.name || '', phone: profile.phone || '' }
    });
  } catch (error) { next(error); }
});

export default router;
