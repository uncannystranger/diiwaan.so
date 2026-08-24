/* Branding uploads.

   A logo is a handful of kilobytes that belongs to exactly one business, so it
   is kept in MongoDB beside everything else that business owns and served back
   from this app's own origin. That removes a second storage service from the
   critical path — one fewer thing to configure, one fewer thing to be down —
   and keeps the strict image policy pointed at 'self'.

   Every file is checked for type, size and real magic bytes before it is
   stored, and served with a content type this server chose rather than one the
   uploader supplied. */

import { Router } from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireUser, requireBusiness } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { col, collections } from '../db.js';
import { audit } from '../services/analytics.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1 }
});

const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });

const SIGNATURES = [
  { mime: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' }
];

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* The filename and the declared Content-Type are both attacker-controlled; the
   first bytes of the file are not. */
function sniff(file) {
  const match = SIGNATURES.find(signature => signature.test(file.buffer));
  if (!match) throw new HttpError(415, 'That file is not a PNG, JPEG or WebP image.');
  if (!config.uploads.mimeTypes.includes(match.mime)) throw new HttpError(415, 'That image type is not allowed.');
  return match.mime;
}

router.post(
  '/businesses/:businessId/logo',
  uploadLimiter,
  requireUser,
  requireBusiness('manager'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, 'No image was uploaded.');
      if (req.file.size > config.uploads.maxBytes) {
        throw new HttpError(413, `Images must be ${Math.round(config.uploads.maxBytes / (1024 * 1024))} MB or smaller.`);
      }
      const mime = sniff(req.file);
      const body = req.file.buffer;

      const kind = req.query.kind === 'favicon' ? 'favicon' : 'logo';
      const asset = await col(collections.brandingAssets).insertOne({
        businessId: req.business._id,
        kind,
        mime,
        bytes: body.length,
        data: body,
        uploadedBy: req.user.id,
        createdAt: new Date()
      });

      const url = `/api/branding/${asset.insertedId}.${EXTENSIONS[mime]}`;
      const field = kind === 'favicon' ? 'branding.favicon' : 'logo';
      const update = field === 'logo'
        ? { logo: url, 'branding.logo': url }
        : { 'branding.favicon': url };

      await col(collections.businesses).updateOne(
        { _id: req.business._id },
        { $set: { ...update, updatedAt: new Date() } }
      );
      await audit({ businessId: req.business._id, actorId: req.user.id, action: 'branding.logo_uploaded', ip: req.ip });

      /* The one this replaces is no longer referenced by anything. Leaving it
         would grow the collection by a copy every time somebody adjusts a logo. */
      await col(collections.brandingAssets).deleteMany({
        businessId: req.business._id, kind, _id: { $ne: asset.insertedId }
      });

      res.status(201).json({ url });
    } catch (error) { next(error); }
  }
);

/* Public by design: a logo appears on the page customers see before they have
   any identity at all. The id is random, the payload is only ever an image this
   server sniffed itself, and the content type is ours rather than the
   uploader's — so there is nothing here to authorise and nothing to smuggle. */
router.get('/branding/:asset', async (req, res, next) => {
  try {
    const id = String(req.params.asset).replace(/\.[a-z0-9]+$/i, '');
    if (!ObjectId.isValid(id)) throw new HttpError(404, 'No such image.');

    const asset = await col(collections.brandingAssets).findOne({ _id: new ObjectId(id) });
    if (!asset) throw new HttpError(404, 'No such image.');

    const body = asset.data.buffer ? Buffer.from(asset.data.buffer) : Buffer.from(asset.data);
    const etag = `"${id}"`;
    if (req.get('if-none-match') === etag) return res.status(304).end();

    res.set({
      'Content-Type': asset.mime,
      'Content-Length': String(body.length),
      // Immutable: a new upload gets a new id, so this one never changes.
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline'
    });
    res.end(body);
  } catch (error) { next(error); }
});

export default router;
