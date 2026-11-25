-- نور: Islamic Q&A search. Run once in the Supabase SQL editor.
-- Content tables are read-only for the API; only the server (service role) writes.

create extension if not exists vector;

create table if not exists qa_ayahs (
  id text primary key,            -- "2:255"
  surah int not null,
  surah_name text not null,
  ayah int not null,
  text text not null,             -- uthmani script (Tanzil)
  tafsir text not null default '',-- al-Tafsir al-Muyassar
  tsv tsvector generated always as (to_tsvector('arabic', text || ' ' || tafsir)) stored,
  embedding vector(768)
);

create table if not exists qa_hadiths (
  id text primary key,            -- "bukhari:1"
  collection text not null,       -- صحيح البخاري | صحيح مسلم
  book_ar text not null default '',
  chapter_ar text not null default '',
  matn text not null,             -- the hadith text itself
  grade text not null default 'صحيح',
  url text not null default '',   -- verification link (sunnah.com)
  simple_explanation text,        -- cached plain-language meaning, generated on demand
  tsv tsvector generated always as (to_tsvector('arabic', book_ar || ' ' || chapter_ar || ' ' || matn)) stored,
  embedding vector(768)
);

create index if not exists qa_ayahs_tsv_idx on qa_ayahs using gin (tsv);
create index if not exists qa_hadiths_tsv_idx on qa_hadiths using gin (tsv);
create index if not exists qa_ayahs_emb_idx on qa_ayahs using hnsw (embedding vector_cosine_ops);
create index if not exists qa_hadiths_emb_idx on qa_hadiths using hnsw (embedding vector_cosine_ops);

alter table qa_ayahs enable row level security;
alter table qa_hadiths enable row level security;
revoke all on qa_ayahs from public, anon, authenticated;
revoke all on qa_hadiths from public, anon, authenticated;
grant all on qa_ayahs to service_role;
grant all on qa_hadiths to service_role;

-- Hybrid search: Arabic full-text rank + embedding cosine rank, fused with RRF.
-- Returns up to ka ayahs and kh hadiths; rows pass a relevance floor (fts hit or decent semantic match).
create or replace function qa_search(q text, emb vector(768), ka int default 5, kh int default 5)
returns table(kind text, id text, ref text, body text, extra text, grade text, url text, score real)
language sql stable as $$
  with aq as (
    select a.id, a.surah_name || ' ' || a.ayah::text as ref, a.text as body, a.tafsir as extra,
           ''::text as grade, ('https://quran.com/' || a.id) as url,
           ts_rank(a.tsv, websearch_to_tsquery('arabic', q)) as fts,
           row_number() over (order by ts_rank(a.tsv, websearch_to_tsquery('arabic', q)) desc) as fr,
           row_number() over (order by a.embedding <=> emb) as sr,
           1 - (a.embedding <=> emb) as sem
    from qa_ayahs a where a.embedding is not null
  ), asel as (
    select *, (1.0/(60+fr) + 1.0/(60+sr))::real as score from aq
    where fts > 0.005 or sem > 0.60
    order by score desc limit ka
  ), hq as (
    select h.id, (h.collection || ' - ' || h.book_ar) as ref, h.matn as body, h.chapter_ar as extra,
           h.grade, h.url,
           ts_rank(h.tsv, websearch_to_tsquery('arabic', q)) as fts,
           row_number() over (order by ts_rank(h.tsv, websearch_to_tsquery('arabic', q)) desc) as fr,
           row_number() over (order by h.embedding <=> emb) as sr,
           1 - (h.embedding <=> emb) as sem
    from qa_hadiths h where h.embedding is not null
  ), hsel as (
    select *, (1.0/(60+fr) + 1.0/(60+sr))::real as score from hq
    where fts > 0.005 or sem > 0.60
    order by score desc limit kh
  )
  select 'ayah'::text, id, ref, body, extra, grade, url, score from asel
  union all
  select 'hadith'::text, id, ref, body, extra, grade, url, score from hsel
$$;

revoke all on function qa_search(text, vector, int, int) from public, anon, authenticated;
grant execute on function qa_search(text, vector, int, int) to service_role;

grant usage on schema public to service_role;
