/* Authentication and tenant authorization.

   Nothing about identity or membership is read from the request body: the user
   comes from a verified Firebase token, and the role comes from MongoDB. A
   client can rename a businessId in the URL all it likes — requireBusiness only
   resolves businesses the caller is actually a member of. */

import { ObjectId } from 'mongodb';
import { col, collections } from '../db.js';
import { verifyFirebaseToken } from '../lib/firebase.js';
import { HttpError } from '../lib/errors.js';

const bearer = req => {
  const header = req.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
};

/**
 * Attaches req.user when a valid Firebase token is present. Never rejects —
 * routes decide whether being signed out matters.
 */
export async function withUser(req, res, next) {
  try {
    const token = bearer(req);
    req.user = token ? await verifyFirebaseToken(token) : null;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  next();
}

/**
 * Loads (or lazily creates) the MongoDB profile for the verified user.
 *
 * Accounts made before Firebase carry a `legacyUserId`, and the businesses and
 * memberships they own were written against that id. Matching on the verified
 * email attaches the Firebase uid to the existing profile rather than starting
 * a second one, so an owner still reaches the business they already created —
 * and no existing identifier is ever rewritten.
 *
 * Only a verified email is trusted for that link. An unverified one would let
 * anyone who can type an address inherit somebody else's queue.
 */
export async function withProfile(req, res, next) {
  try {
    if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));

    const now = new Date();
    const profiles = col(collections.profiles);
    const email = req.user.email || '';
    const verified = req.user.emailVerified === true;

    let profile = await profiles.findOne({ firebaseUid: req.user.id });

    /* An account can arrive here already having a second record: signing up
       before confirming the address creates a Firebase-keyed profile, while the
       work done under the old provider still sits on a legacy-keyed one. Once
       the address is confirmed the two are the same person, so they are merged
       into one rather than left to collide on the next lookup. */
    if (verified && email) {
      const older = await profiles.findOne({
        email,
        firebaseUid: { $exists: false },
        legacyUserId: { $exists: true }
      });

      if (older && profile) {
        /* The legacy id is uniquely indexed, so the old record has to let go of
           it before the surviving one can take it. Taking the whole document
           first means that if the hand-over then fails, it can be put back
           exactly as it was rather than vanishing. */
        const taken = await profiles.findOneAndDelete({ _id: older._id });
        if (taken) {
          try {
            await profiles.updateOne(
              { _id: profile._id },
              {
                $set: {
                  legacyUserId: taken.legacyUserId,
                  // Keep whatever the older record knew that this one does not.
                  name: profile.name || taken.name || '',
                  phone: profile.phone || taken.phone || '',
                  avatar: profile.avatar || taken.avatar || '',
                  updatedAt: now
                }
              }
            );
          } catch (error) {
            await profiles.insertOne(taken).catch(() => {});
            throw error;
          }
          profile = await profiles.findOne({ _id: profile._id });
        }
      } else if (older) {
        profile = await profiles.findOneAndUpdate(
          { _id: older._id },
          { $set: { firebaseUid: req.user.id, updatedAt: now } },
          { returnDocument: 'after' }
        );
      }
    }

    if (!profile) {
      profile = await profiles.findOneAndUpdate(
        { firebaseUid: req.user.id },
        {
          $setOnInsert: {
            firebaseUid: req.user.id, createdAt: now, name: '', phone: '', avatar: ''
          },
          $set: { email, updatedAt: now }
        },
        { upsert: true, returnDocument: 'after' }
      );
    } else if (email && profile.email !== email) {
      await profiles.updateOne({ _id: profile._id }, { $set: { email, updatedAt: now } });
      profile = { ...profile, email };
    }

    req.profile = profile;
    /* Every id this person is known by. Ownership and membership are matched
       against all of them, so an account that predates Firebase keeps its work. */
    req.authIds = [profile.firebaseUid, profile.legacyUserId, req.user.id]
      .filter(Boolean)
      .filter((id, index, all) => all.indexOf(id) === index);
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

      /* Matched against every uid this person is known by, so a business
         created under one provider is still theirs after signing in with the
         other. Falls back to the token's uid on routes that resolve a business
         without having loaded the profile. */
      const ids = req.authIds?.length ? req.authIds : [req.user.id];

      const membership = await col(collections.members).findOne({
        businessId: business._id,
        userId: { $in: ids },
        status: 'active'
      });

      // Ownership is the fallback for the account that created the business.
      const role = membership?.role || (ids.includes(business.ownerId) ? 'owner' : null);
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
/** Accepts one uid or several — a person linked across providers has several. */
export async function listBusinessesFor(userId) {
  const owners = (Array.isArray(userId) ? userId : [userId]).filter(Boolean);
  if (!owners.length) return [];

  const memberships = await col(collections.members)
    .find({ userId: { $in: owners }, status: 'active' })
    .toArray();
  const ids = memberships.map(m => m.businessId);
  const businesses = await col(collections.businesses)
    .find({ $or: [{ _id: { $in: ids } }, { ownerId: { $in: owners } }] })
    .sort({ createdAt: -1 })
    .toArray();
  return businesses.map(business => ({
    ...business,
    role: memberships.find(m => String(m.businessId) === String(business._id))?.role
      || (owners.includes(business.ownerId) ? 'owner' : 'staff')
  }));
}
