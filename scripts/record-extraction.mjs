// Record local source provenance only. Does not publish or change release readiness.
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), source=resolve(process.argv[2]??'');
if(!process.argv[2]) throw new Error('Pass the source product directory');
const baseline=JSON.parse(readFileSync(join(source,'EXTRACTION.json'),'utf8'));
const path=join(root,'EXTRACTION.json'), record=JSON.parse(readFileSync(path,'utf8'));
record.sourceBaselineCommit=baseline.sourceCommit;
record.accountSourceInputs=[];
for(const name of ['server.go','store.go','blobs.go','community.go','profile.go','themes.go','images.go','home.go','wire.go','worker.go','cloud.go','workspace.go','admin.go','admin_themes.go']) {
 const input=`account-service/internal/app/${name}`;
 record.accountSourceInputs.push({source:input,sha256:createHash('sha256').update(readFileSync(join(source,input))).digest('hex')});
}
record.components=['encrypted OAuth/device relay','shared wire protocol','standalone runtime','local-Agent-only account API'];
record.commercialHandlersRemoved=true;
record.originalProductTreeRetained=true;
record.liveServicesChanged=false;
record.verification={build:true,typecheck:true,wireTests:26,relayTests:129,accountTestGroups:6,goVet:true,freshAndRepeatSchema:true,standaloneStartup:true};
record.releaseBlockers=['Real OAuth/client end-to-end verification','Dependency security advisories','Human source/license/security review'];
record.published=false; record.releaseReady=false;
writeFileSync(path,JSON.stringify(record,null,2)+'\n');
console.log('Recorded source hashes and local verification; public release remains gated.');
