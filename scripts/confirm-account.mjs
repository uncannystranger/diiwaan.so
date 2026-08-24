/* Confirms a Supabase account by hand.

   Diiwaan's Supabase project requires an emailed link before anyone can sign in.
   Until the project's Site URL points at the deployed app, those links come back
   to localhost and cannot be clicked from a phone — which leaves real accounts
   stranded. This confirms one directly, exactly as the "Confirm user" button in
   the Supabase dashboard does.

     node scripts/confirm-account.mjs you@example.com

   It needs SUPABASE_SERVICE_ROLE_KEY in .env: the admin API will not accept the
   publishable key, and that is the point of the distinction. */

import 'dotenv/config';

const email = process.argv[2];
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !url || !key) {
  console.error('\nUsage: node scripts/confirm-account.mjs <email>\n');
  if (!url) console.error('  SUPABASE_URL is missing from .env');
  if (!key) console.error('  SUPABASE_SERVICE_ROLE_KEY is missing from .env — copy it from');
  if (!key) console.error('  Supabase → Project Settings → API Keys → service_role');
  process.exit(1);
}

const admin = (path, init = {}) => fetch(`${url}/auth/v1/admin${path}`, {
  ...init,
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
});

const found = await admin(`/users?filter=${encodeURIComponent(email)}`).then(r => r.json());
const user = (found.users || []).find(u => u.email?.toLowerCase() === email.toLowerCase());

if (!user) {
  console.error(`\nNo account for ${email}. Sign up first, then run this.\n`);
  process.exit(1);
}

if (user.email_confirmed_at) {
  console.log(`\n${email} was already confirmed. You can sign in.\n`);
  process.exit(0);
}

const updated = await admin(`/users/${user.id}`, {
  method: 'PUT',
  body: JSON.stringify({ email_confirm: true })
}).then(r => r.json());

if (updated.email_confirmed_at) {
  console.log(`\n${email} is confirmed. You can sign in now.\n`);
} else {
  console.error('\nThat did not work:', updated.msg || JSON.stringify(updated), '\n');
  process.exit(1);
}
