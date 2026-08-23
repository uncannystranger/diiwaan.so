-- Branding storage for Diiwaan.
-- Applied to the Supabase project once; safe to re-run.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding',
  'branding',
  true,
  5242880,
  array['image/png','image/jpeg','image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Policies only take effect once row level security is switched on. Supabase
-- ships storage.objects with it enabled, but saying so here makes the migration
-- self-contained and safe to run against a project where it was turned off.
alter table storage.objects enable row level security;

-- Anyone may read branding art: it is shown on public customer pages.
drop policy if exists "branding public read" on storage.objects;
create policy "branding public read"
  on storage.objects for select
  using (bucket_id = 'branding');

-- An authenticated owner may only write inside a folder named after their own user id.
drop policy if exists "branding owner write" on storage.objects;
create policy "branding owner write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "branding owner update" on storage.objects;
create policy "branding owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "branding owner delete" on storage.objects;
create policy "branding owner delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
