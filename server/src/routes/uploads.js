/* Branding uploads.

   Images go to Supabase Storage and MongoDB keeps the URL — a logo has no
   business being a megabyte of base64 inside a queue document. Every file is
   checked for type, size and real magic bytes before it leaves this process. */

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireUser, requireBusiness } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { serviceFetch, storagePublicUrl } from '../lib/supabase.js';
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

      const objectPath = `${req.user.id}/${req.business.slug}-${Date.now()}.${EXTENSIONS[mime]}`;
      const response = await serviceFetch(
        `/storage/v1/object/${config.supabase.brandingBucket}/${objectPath}`,
        { method: 'POST', headers: { 'Content-Type': mime, 'x-upsert': 'true' }, body }
      );
      if (!response.ok) {
        throw new HttpError(502, `Storage rejected the upload: ${(await response.text()).slice(0, 140)}`);
      }

      const url = storagePublicUrl(objectPath);
      const field = req.query.kind === 'favicon' ? 'branding.favicon' : 'logo';
      const update = field === 'logo'
        ? { logo: url, 'branding.logo': url }
        : { 'branding.favicon': url };

      await col(collections.businesses).updateOne(
        { _id: req.business._id },
        { $set: { ...update, updatedAt: new Date() } }
      );
      await audit({ businessId: req.business._id, actorId: req.user.id, action: 'branding.logo_uploaded', ip: req.ip });

      res.status(201).json({ url });
    } catch (error) { next(error); }
  }
);

export default router;
