import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export class Database {
  readonly pool:pg.Pool;
  readonly orm:ReturnType<typeof drizzle<typeof schema>>;
  constructor(url:string){this.pool=new pg.Pool({connectionString:url,max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});this.orm=drizzle(this.pool,{schema});}
  async transaction<T>(run:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    try{await client.query('BEGIN');const value=await run(client);await client.query('COMMIT');return value;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async close():Promise<void>{await this.pool.end();}
}
