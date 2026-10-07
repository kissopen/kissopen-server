// Uses fresh temporary data and a generated test-only secret. Never touches a
// deployed server or existing database, and stops only the process it spawned.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=join(root,'packages/kissopen-server-self-host');
const work=mkdtempSync(join(tmpdir(),'kissopen-server-smoke-'));
const socket=createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r));
const port=socket.address().port; await new Promise(r=>socket.close(r));
// Intentionally do not inherit OAuth/third-party credentials from the shell.
const env={PATH:process.env.PATH,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),DB_PROVIDER:'pglite',
 DATA_DIR:join(work,'relay'),PGLITE_DIR:join(work,'relay/pglite'),HANDY_MASTER_SECRET:randomBytes(32).toString('hex'),
 PUBLIC_URL:`http://127.0.0.1:${port}`,COMMUNITY_AUTH_PUBLIC_URL:`http://127.0.0.1:${port}`};
function child(command) {
 const p=spawn(process.execPath,[join(runtime,'dist/standalone.mjs'),command],{cwd:runtime,env,stdio:['ignore','pipe','pipe']});
 let log=''; p.stdout.on('data',b=>{ log=(log+b).slice(-12000); }); p.stderr.on('data',b=>{ log=(log+b).slice(-12000); });
 const exit=new Promise((r,reject)=>{p.on('error',reject);p.on('exit',code=>r(code));});
 return {p,exit,log:()=>log.replaceAll(env.HANDY_MASTER_SECRET,'[REDACTED]')};
}
let active;
try {
 for(let i=0;i<2;i++) {
  const c=child('migrate'); const timeout=setTimeout(()=>c.p.kill('SIGTERM'),45000);
  const code=await c.exit; clearTimeout(timeout); if(code!==0) throw new Error(`Migration ${i+1} failed\n${c.log()}`);
  console.log(`Fresh relay migration / repeat ${i+1}: passed`);
 }
 // Validate the trimmed account SQL on a disposable PostgreSQL-compatible engine.
 const require=createRequire(join(root,'packages/kissopen-server/package.json'));
 const {PGlite}=require('@electric-sql/pglite');
 const communityToken=randomBytes(32).toString('base64url');
 const fixture=new PGlite(env.PGLITE_DIR);
 await fixture.query('INSERT INTO "CommunityIdentity" (id,provider,subject,name,"updatedAt") VALUES ($1,$2,$3,$4,NOW())', ['smoke-owner','github','smoke-only','Smoke']);
 await fixture.query('INSERT INTO "CommunityAccountSession" ("tokenHash","identityId","expiresAt") VALUES ($1,$2,$3)',
  [createHash('sha256').update(communityToken).digest('hex'),'smoke-owner',new Date(Date.now()+3600000)]);
 await fixture.close();
 const db=new PGlite(join(work,'accounts'));
 for(let i=0;i<2;i++) {
  for(const [file,name] of [['core.go','accountSchema'],['themes.go','themeSchema'],['admin.go','adminSchema']]) {
   const src=readFileSync(join(root,'accounts/internal/app',file),'utf8');
   const sql=src.match(new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60`))?.[1];
   if(!sql) throw new Error(`Missing ${name}`); await db.exec(sql);
  }
 }
 const tables=(await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows;
 if(tables.some(t=>/orders|plans|jobs|usage|cloud_workspaces|schedules/.test(t.table_name))) throw new Error('Unexpected commercial table');
 await db.close(); console.log('Account schema / repeat / no commercial tables: passed');
 active=child('serve'); let ready=false;
 for(let i=0;i<100;i++) {
  if(active.p.exitCode!==null) throw new Error(`Relay exited\n${active.log()}`);
  try {
   const result=await fetch(`${env.PUBLIC_URL}/v1/community/auth/providers`,{signal:AbortSignal.timeout(1500)});
   if(result.ok) { const body=await result.json(); if(JSON.stringify(body.providers)!=='[]') throw new Error('Unexpected inherited OAuth credentials'); ready=true; break; }
  } catch(e) { if(e.message.includes('Unexpected')) throw e; }
  await new Promise(r=>setTimeout(r,200));
 }
 if(!ready) throw new Error(`Relay did not become ready\n${active.log()}`);
 const unauth=await fetch(`${env.PUBLIC_URL}/v1/community/account`);
 if(unauth.status!==401) throw new Error('Account endpoint did not reject an unauthenticated request');
 console.log('Bundled relay startup / empty provider list / unauthenticated account rejected: passed');
 const nacl=require('tweetnacl');
 const restored=[];
 for(let device=0;device<2;device++) {
  const recipient=nacl.box.keyPair();
  const response=await fetch(`${env.PUBLIC_URL}/v1/community/workspace/session`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${communityToken}`},
   body:JSON.stringify({recipientKey:Buffer.from(recipient.publicKey).toString('base64')})});
  if(response.status!==200 || response.headers.get('cache-control')!=='no-store') throw new Error(`Account workspace restoration failed (${response.status})`);
  const result=await response.json();
  if(result.status!=='ready' || result.identityId!=='smoke-owner') throw new Error('Invalid workspace restoration identity');
  const envelope=Buffer.from(result.envelope,'base64');
  const seed=nacl.box.open(envelope.subarray(56),envelope.subarray(32,56),envelope.subarray(0,32),recipient.secretKey);
  if(!seed || seed.length!==32) throw new Error('Workspace envelope could not be opened');
  const signing=nacl.sign.keyPair.fromSeed(seed);
  if(Buffer.from(signing.publicKey).toString('hex')!==result.publicKey) throw new Error('Workspace public key mismatch');
  restored.push({publicKey:result.publicKey,token:result.workspaceToken});
  seed.fill(0); signing.secretKey.fill(0); recipient.secretKey.fill(0);
 }
 if(restored[0].publicKey!==restored[1].publicKey) throw new Error('Desktop and phone did not restore the same workspace');
 const linkedMachine='account-smoke-'+randomBytes(8).toString('hex');
 const linked=await fetch(`${env.PUBLIC_URL}/v1/machines`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${restored[0].token}`},body:JSON.stringify({id:linkedMachine,metadata:'opaque-encrypted-fixture'})});
 const discovered=await fetch(`${env.PUBLIC_URL}/v1/machines`,{headers:{Authorization:`Bearer ${restored[1].token}`}});
 if(linked.status!==200 || !discovered.ok || !JSON.stringify(await discovered.json()).includes(linkedMachine)) throw new Error('Same-account automatic device association failed');
 console.log('Server escrow / two device logins without peers / same workspace and desktop discovery: passed');
 async function signIn() {
  const keys=nacl.sign.keyPair(), challenge=randomBytes(32);
  const response=await fetch(`${env.PUBLIC_URL}/v1/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   publicKey:Buffer.from(keys.publicKey).toString('base64'),challenge:challenge.toString('base64'),
   signature:Buffer.from(nacl.sign.detached(challenge,keys.secretKey)).toString('base64'),
  })});
  if(response.status!==200) throw new Error(`Fresh encryption-key sign-in failed (${response.status})`);
  const body=await response.json(); if(!body.token) throw new Error('Missing relay token'); return body.token;
 }
 const owner=await signIn(), other=await signIn();
 const machineID='smoke-'+randomBytes(8).toString('hex');
 const created=await fetch(`${env.PUBLIC_URL}/v1/machines`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${owner}`},body:JSON.stringify({id:machineID,metadata:'opaque-encrypted-fixture'})});
 if(created.status!==200 || (await created.json()).machine?.id!==machineID) throw new Error('Machine creation failed on the real database');
 const ownList=await fetch(`${env.PUBLIC_URL}/v1/machines`,{headers:{Authorization:`Bearer ${owner}`}});
 const otherList=await fetch(`${env.PUBLIC_URL}/v1/machines`,{headers:{Authorization:`Bearer ${other}`}});
 if(!ownList.ok || !otherList.ok) throw new Error('Machine list failed');
 if(!JSON.stringify(await ownList.json()).includes(machineID) || JSON.stringify(await otherList.json()).includes(machineID)) throw new Error('Device account isolation failed');
 console.log('Real database encryption-key login / machine create / two-account isolation: passed');
 console.log(`Disposable smoke data retained at ${work}`);
} finally {
 if(active && active.p.exitCode===null) { active.p.kill('SIGTERM'); const timeout=setTimeout(()=>active.p.kill('SIGKILL'),5000); await active.exit; clearTimeout(timeout); }
}
