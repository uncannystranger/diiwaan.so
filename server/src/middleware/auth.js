/* Authentication and tenant authorization.

   Nothing about identity or membership is read from the request body: the user
   comes from a verified Supabase token, and the role comes from MongoDB. A
   client can rename a businessId in the URL all it likes — requireBusiness only
   resolves businesses the caller is actually a member of. */

import { ObjectId } from 'mongodb';
import { col, collections } from '../db.js';
import { verifyAccessToken } from '../lib/supabase.js';
import { HttpError } from '../lib/errors.js';

const bearer = req => {
  const header = req.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
};

/** Attaches req.user when a valid token is present. Never rejects. */
export async function withUser(req, res, next) {
  try {
    const token = bearer(req);
    req.user = token ? await verifyAccessToken(token) : null;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  next();
}

/** Loads (or lazily creates) the MongoDB profile for the verified Supabase user. */
export async function withProfile(req, res, next) {
  try {
    if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
    const now = new Date();
    const result = await col(collections.profiles).findOneAndUpdate(
      { supabaseUserId: req.user.id },
      {
        $setOnInsert: { supabaseUserId: req.user.id, createdAt: now, name: '', phone: '', avatar: '' },
        $set: { email: req.user.email, updatedAt: now }
      },
      { upsert: true, returnDocument: 'after' }
    );
    req.profile = result;
    next();
  } catch (error) {
    next(error);
  }
}

const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

/**
 * Resolves :businessId (or :businessSlug) to a business the caller belongs to.
 * Attaches req.business and req.membership. Anything else 404s — an outsider
 * cannot even learn whether the tenant exists.
 */
export function requireBusiness(minimumRole = 'staff') {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new HttpError(401, 'Sign in to continue.');

      const { businessId } = req.params;
      if (!businessId || !ObjectId.isValid(businessId)) throw new HttpError(404, 'Business not found.');

      const business = await col(collections.businesses).findOne({ _id: new ObjectId(businessId) });
      if (!business) throw new HttpError(404, 'Business not found.');

      const membership = await col(collections.members).findOne({
        businessId: business._id,
        userId: req.user.id,
        status: 'active'
      });

      // Ownership is the fallback for the account that created the business.
      const role = membership?.role || (business.ownerId === req.user.id ? 'owner' : null);
      if (!role) throw new HttpError(404, 'Business not found.');
      if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
        throw new HttpError(403, 'Your role does not allow that.');
      }

      req.business = business;
      req.membership = membership || { role, businessId: business._id, userId: req.user.id };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Every business the caller can act on, newest first. */
export async function listBusinessesFor(userId) {
  const memberships = await col(collections.members)
    .find({ userId, status: 'active' })
    .toArray();
  const ids = memberships.map(m => m.businessId);
  const businesses = await col(collections.businesses)
    .find({ $or: [{ _id: { $in: ids } }, { ownerId: userId }] })
    .sort({ createdAt: -1 })
    .toArray();
  return businesses.map(business => ({
    ...business,
    role: memberships.find(m => String(m.businessId) === String(business._id))?.role
      || (business.ownerId === userId ? 'owner' : 'staff')
  }));
}
