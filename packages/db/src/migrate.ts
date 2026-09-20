import { readFile,readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Database } from './database.js';

export async function migrate(db:Database,directory=new URL('../migrations/',import.meta.url)):Promise<void> {
  const files=(await readdir(directory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
  await db.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('humanize:migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS humanize_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for(const name of files){
      const source=await readFile(new URL(name,directory),'utf8');const checksum=createHash('sha256').update(source).digest('hex');
      const existing=await client.query<{checksum:string}>('SELECT checksum FROM humanize_migrations WHERE name=$1',[name]);
      if(existing.rows[0]){if(existing.rows[0].checksum!==checksum)throw Error('APPLIED_MIGRATION_CHANGED');continue;}
      await client.query(source);await client.query('INSERT INTO humanize_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
    }
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
  const db=new Database(process.env.DATABASE_URL);try{await migrate(db);console.log('Migrations applied');}finally{await db.close();}
}
