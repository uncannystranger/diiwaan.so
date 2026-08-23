import { z } from 'zod';
import { HttpError } from './errors.js';

export const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(422, 'Some details need fixing.', result.error.issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message
    })));
  }
  return result.data;
};

export const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #D68C45');

export const slugSchema = z.string()
  .trim()
  .toLowerCase()
  .min(2, 'A little longer, please')
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Letters, numbers and dashes only');

export const slugify = value => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'queue';

export const businessCreateSchema = z.object({
  name: z.string().trim().min(2, 'Give your business a name').max(120),
  category: z.string().trim().max(60).optional().default(''),
  description: z.string().trim().max(400).optional().default(''),
  city: z.string().trim().max(80).optional().default(''),
  country: z.string().trim().max(80).optional().default(''),
  address: z.string().trim().max(160).optional().default(''),
  phone: z.string().trim().max(40).optional().default(''),
  email: z.string().trim().email().optional().or(z.literal('')).default(''),
  timezone: z.string().trim().max(60).optional().default('Africa/Mogadishu'),
  slug: slugSchema.optional()
});

export const businessUpdateSchema = businessCreateSchema.partial().extend({
  logo: z.string().max(512).optional(),
  queueSettings: z.object({
    name: z.string().trim().max(60).optional(),
    prefix: z.string().trim().max(1).optional(),
    avgServiceMin: z.number().int().min(1).max(240).optional(),
    opensAt: z.string().trim().max(5).optional(),
    closesAt: z.string().trim().max(5).optional()
  }).optional()
});

export const brandingSchema = z.object({
  preset: z.string().trim().max(32).optional(),
  primary: hex.optional(),
  emphasis: hex.optional(),
  accent: hex.optional(),
  base: hex.optional(),
  tint: hex.optional(),
  surface: z.enum(['aurora', 'gradient', 'calm', 'bold']).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  typography: z.enum(['diiwaan', 'serif-forward', 'plain']).optional(),
  logo: z.string().max(512).optional(),
  favicon: z.string().max(512).optional()
});

export const experienceSchema = z.object({
  headline: z.string().trim().max(80).optional(),
  subheading: z.string().trim().max(180).optional(),
  ticketNote: z.string().trim().max(200).optional(),
  calledMessage: z.string().trim().max(160).optional(),
  closedMessage: z.string().trim().max(200).optional(),
  pausedMessage: z.string().trim().max(200).optional(),
  instructions: z.string().trim().max(300).optional(),
  requirePhone: z.boolean().optional(),
  askService: z.boolean().optional(),
  showPeopleAhead: z.boolean().optional(),
  showEstimate: z.boolean().optional(),
  showProgress: z.boolean().optional()
});

export const qrSchema = z.object({
  shape: z.enum(['square', 'rounded', 'dot']).optional(),
  foreground: hex.optional(),
  background: hex.optional(),
  eyeColor: hex.or(z.literal('')).optional(),
  eyeStyle: z.enum(['square', 'rounded']).optional(),
  logoOnCode: z.boolean().optional(),
  logoScale: z.number().min(0.1).max(0.3).optional(),
  quietZone: z.number().int().min(4).max(8).optional(),
  errorCorrection: z.enum(['L', 'M', 'Q', 'H']).optional(),
  signHeadline: z.string().trim().max(80).optional(),
  signInstruction: z.string().trim().max(120).optional(),
  signFootnote: z.string().trim().max(120).optional(),
  displayLayout: z.enum(['split', 'code', 'board']).optional(),
  displayShowServing: z.boolean().optional(),
  displayShowWaiting: z.boolean().optional(),
  displayShowNext: z.boolean().optional(),
  displayScale: z.number().min(0.7).max(1.6).optional()
});

export const serviceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional().default(''),
  estimatedDuration: z.number().int().min(1).max(240).optional().default(10),
  color: z.string().max(32).optional().default(''),
  active: z.boolean().optional().default(true)
});

export const joinSchema = z.object({
  name: z.string().trim().min(1, 'Please tell us your name').max(80),
  phone: z.string().trim().max(32).optional().default(''),
  serviceId: z.string().trim().optional().nullable(),
  /* A field the form hides and no person can see, let alone type into. Scripts
     that fill every input give themselves away here. */
  company: z.string().max(120).optional().default(''),
  /* Milliseconds the form was on screen before it was sent. */
  elapsed: z.coerce.number().int().min(0).max(86_400_000).optional().default(0)
});

export const memberInviteSchema = z.object({
  email: z.string().trim().email('That email does not look right'),
  name: z.string().trim().max(80).optional().default(''),
  role: z.enum(['manager', 'staff']).default('staff'),
  serviceIds: z.array(z.string()).optional().default([])
});
