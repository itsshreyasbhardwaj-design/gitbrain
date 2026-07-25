-- GitBrain schema
--
-- Optional. GitBrain runs without Supabase, storing analyses in a bounded
-- in-memory LRU. Apply this migration only when you want analyses to survive
-- a restart and be shared across instances.
--
--   supabase db push
--   -- or paste into the SQL editor at https://supabase.com/dashboard

-- pgvector is enabled up front so semantic search can be added without a
-- second migration. Nothing in GitBrain writes embeddings today: search is
-- lexical BM25, which needs no vectors, costs nothing, and cannot hallucinate
-- a citation. The column below is the seam for adding hybrid retrieval later.
create extension if not exists vector;

create table if not exists public.analyses (
  id           text primary key,
  -- Clerk user id, or null for an anonymous (publicly shareable) analysis.
  owner_id     text,
  created_at   timestamptz not null default now(),
  name         text not null,
  -- The RepoSource discriminated union.
  source       jsonb not null,
  -- The AnalysisSummary projection, so list views never load the full report.
  summary      jsonb not null,
  -- The complete Analysis object.
  payload      jsonb not null
);

-- The dashboard's only query shape: newest first, filtered by owner.
create index if not exists analyses_owner_created_idx
  on public.analyses (owner_id, created_at desc);

create index if not exists analyses_created_idx
  on public.analyses (created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- GitBrain's server talks to PostgREST with the service role key, which
-- bypasses RLS. These policies exist so that if an anon or authenticated key
-- is ever used — deliberately or by mistake — the data is still not exposed.
-- ---------------------------------------------------------------------------

alter table public.analyses enable row level security;

-- Anonymous analyses are public by design: that is what makes a shared report
-- link work for someone who is not signed in.
drop policy if exists "anonymous analyses are readable" on public.analyses;
create policy "anonymous analyses are readable"
  on public.analyses for select
  using (owner_id is null);

-- An owned analysis is visible only to its owner. `auth.jwt() ->> 'sub'` is
-- the Clerk user id when Clerk is wired to Supabase as a JWT provider.
drop policy if exists "owners read their own analyses" on public.analyses;
create policy "owners read their own analyses"
  on public.analyses for select
  using (owner_id = (auth.jwt() ->> 'sub'));

drop policy if exists "owners delete their own analyses" on public.analyses;
create policy "owners delete their own analyses"
  on public.analyses for delete
  using (owner_id = (auth.jwt() ->> 'sub'));

-- Writes are server-only. No client-side insert policy is defined, so an anon
-- key cannot create rows even if it leaks.

-- ---------------------------------------------------------------------------
-- Embedding-ready seam
--
-- Created but unused. When hybrid retrieval is added, chunks are written here
-- and combined with the existing BM25 ranking rather than replacing it —
-- lexical matching is what makes exact identifier search work.
-- ---------------------------------------------------------------------------

create table if not exists public.analysis_chunks (
  id          bigserial primary key,
  analysis_id text not null references public.analyses (id) on delete cascade,
  file        text not null,
  start_line  int  not null,
  end_line    int  not null,
  content     text not null,
  -- 1536 dimensions matches text-embedding-3-small; change to suit your model.
  embedding   vector(1536)
);

create index if not exists analysis_chunks_analysis_idx
  on public.analysis_chunks (analysis_id);

-- IVFFlat needs training data, so it is only worth building once rows exist.
-- Left commented so the migration applies cleanly to an empty database.
-- create index analysis_chunks_embedding_idx
--   on public.analysis_chunks using ivfflat (embedding vector_cosine_ops)
--   with (lists = 100);

alter table public.analysis_chunks enable row level security;

drop policy if exists "chunks follow their analysis" on public.analysis_chunks;
create policy "chunks follow their analysis"
  on public.analysis_chunks for select
  using (
    exists (
      select 1 from public.analyses a
      where a.id = analysis_id
        and (a.owner_id is null or a.owner_id = (auth.jwt() ->> 'sub'))
    )
  );
