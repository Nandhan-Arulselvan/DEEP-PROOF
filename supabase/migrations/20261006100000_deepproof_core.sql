-- DeepProof core schema. PDFs live in IPFS/Pinata, never in PostgreSQL.
create extension if not exists pgcrypto;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  original_filename text not null check (char_length(original_filename) between 1 and 512),
  mime_type text not null check (mime_type = 'application/pdf'),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 26214400),
  sha256_hash char(64) not null check (sha256_hash ~ '^[0-9a-f]{64}$'),
  ipfs_cid text not null check (char_length(ipfs_cid) between 10 and 255),
  storage_provider text not null default 'pinata' check (storage_provider in ('pinata', 'ipfs')),
  upload_status text not null default 'complete' check (upload_status in ('pending', 'complete', 'partial_failure', 'failed')),
  blockchain_status text not null default 'not_registered' check (blockchain_status in ('not_registered', 'pending', 'registered', 'failed')),
  blockchain_network text,
  contract_address text,
  transaction_hash text,
  block_number bigint,
  on_chain_registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_owner_hash_unique unique (owner_id, sha256_hash),
  constraint documents_chain_data_consistent check (
    (blockchain_status <> 'registered') or
    (blockchain_network is not null and contract_address is not null and transaction_hash is not null and block_number is not null)
  )
);

create table if not exists public.verification_logs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  submitted_filename text check (char_length(submitted_filename) <= 512),
  expected_sha256_hash char(64) check (expected_sha256_hash is null or expected_sha256_hash ~ '^[0-9a-f]{64}$'),
  computed_sha256_hash char(64) not null check (computed_sha256_hash ~ '^[0-9a-f]{64}$'),
  result text not null check (result in ('match', 'mismatch', 'inconclusive')),
  verification_source text not null check (verification_source in ('supabase_reference', 'blockchain_reference', 'manual_reference')),
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.document_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (char_length(event_type) between 1 and 80),
  event_status text not null check (event_status in ('started', 'succeeded', 'failed', 'pending')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists documents_owner_created_idx on public.documents (owner_id, created_at desc);
create index if not exists documents_owner_filename_idx on public.documents (owner_id, original_filename);
create index if not exists documents_sha256_idx on public.documents (sha256_hash);
create index if not exists verification_logs_user_created_idx on public.verification_logs (user_id, created_at desc);
create index if not exists verification_logs_document_created_idx on public.verification_logs (document_id, created_at desc);
create index if not exists document_events_document_created_idx on public.document_events (document_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at before update on public.documents
for each row execute function public.set_updated_at();

alter table public.documents enable row level security;
alter table public.verification_logs enable row level security;
alter table public.document_events enable row level security;

-- Browser clients are read-only. Edge Functions use the service role only after
-- verifying the caller's JWT, so protected fields cannot be forged from the UI.
create policy "owners read their documents" on public.documents
  for select to authenticated using (owner_id = auth.uid());

create policy "users read their verification history" on public.verification_logs
  for select to authenticated using (user_id = auth.uid());

create policy "owners read their document events" on public.document_events
  for select to authenticated using (
    exists (select 1 from public.documents d where d.id = document_events.document_id and d.owner_id = auth.uid())
  );

revoke all on table public.documents, public.verification_logs, public.document_events from anon;
grant select on table public.documents, public.verification_logs, public.document_events to authenticated;
