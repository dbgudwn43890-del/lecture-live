import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Starts its own disposable database: no production connection or env key is read.
// pgvector is replaced by real[] cosine solely because local PostgreSQL may lack
// the extension. Policies, grants, ownership FKs and cleanup functions are verbatim.
const root = resolve(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'lecue-security-storage-'));
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';
const run = (name, args) => execFileSync(join(bin, name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const port = '55443';
let started = false;
try {
  let sql = `create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema extensions; create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,public,extensions,storage to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to service_role;
create function extensions.cosine(a real[], b real[]) returns double precision language sql immutable as $$select 1-sum(x::double precision*y)/(sqrt(sum(x::double precision*x))*sqrt(sum(y::double precision*y))) from unnest(a,b) z(x,y)$$;
create operator extensions.<=> (leftarg=real[],rightarg=real[],function=extensions.cosine);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,created_at timestamptz default now());
create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated,service_role;\n`;
  for (const file of [
    '20260822010000_classrooms.sql', '20260825000000_optional_classrooms.sql',
    '20260828020000_lecture_materials.sql', '20260828040000_material_files.sql',
    '20260830010000_lecture_audio_uploads.sql', '20260831000000_session_materials.sql',
    '20260831020000_materials_belong_to_sessions.sql', '20260831030000_allow_material_chunk_insert.sql',
    '20260902040000_lecture_notes.sql', '20260908010000_security_ownership_storage.sql',
  ]) sql += readFileSync(join(root, 'supabase/migrations', file), 'utf8') + '\n';
  sql = sql.replace('create extension if not exists vector with schema extensions;', '')
    .replaceAll('extensions.vector(1536)', 'real[]').replaceAll('extensions.vector,', 'real[],');
  writeFileSync(join(directory, 'fixture.sql'), sql);
  run('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '--no-locale']);
  run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-k ${directory} -p ${port} -h ''`, 'start']);
  started = true;
  const args = ['-h', directory, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  writeFileSync(join(directory, 'migration.log'), run('psql', [...args, '-f', join(directory, 'fixture.sql')]));
  const result = run('psql', [...args, '-f', join(root, 'scripts/security/storage-ownership-regression.sql')]);
  writeFileSync(join(directory, 'regression.log'), result);
  console.log(result.split('\n').filter(line => line.startsWith('PASS:')).join('\n'));
} catch (error) {
  console.error(error.stderr?.toString() ?? error.message);
  process.exitCode = 1;
} finally {
  if (started) run('pg_ctl', ['-D', join(directory, 'data'), 'stop', '-m', 'fast']);
  console.log(`Synthetic fixture logs: ${directory}`);
}
