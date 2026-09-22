/** Small D1-compatible adapter for local development and integration tests, not a second backend. */
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function localDatabase(path=':memory:') {
  const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(readFileSync(new URL('../migrations/0001.sql',import.meta.url),'utf8'));
  class Statement {
    constructor(sql,args=[]){this.sql=sql;this.args=args;}
    bind(...args){return new Statement(this.sql,args);}
    async first(column){const row=db.prepare(this.sql).get(...this.args);return row?(column?row[column]:{...row}):null;}
    async all(){const result=db.prepare(this.sql).all(...this.args).map(r=>({...r}));return {success:true,results:result,meta:{changes:0}};}
    async run(){return this.syncRun();}
    syncRun(){const s=db.prepare(this.sql);const result=s.run(...this.args);return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
  }
  return {prepare:sql=>new Statement(sql),
    async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.syncRun());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}},
    async exec(sql){db.exec(sql);return {success:true};},close(){db.close();},raw:db};
}
