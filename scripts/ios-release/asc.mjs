import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
const KID='2BH6NC23C4', ISS='6d956ebe-b0b8-43a9-8bb0-3ab92e66a4e1';
const key=fs.readFileSync(os.homedir()+`/.appstoreconnect/private_keys/AuthKey_${KID}.p8`);
const b=o=>Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
function jwt(){const h=b({alg:'ES256',kid:KID,typ:'JWT'});const n=Math.floor(Date.now()/1000);const p=b({iss:ISS,iat:n,exp:n+1100,aud:'appstoreconnect-v1'});
 const s=crypto.sign('sha256',Buffer.from(h+'.'+p),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');return h+'.'+p+'.'+s;}
export async function api(method,path,body){
 const r=await fetch('https://api.appstoreconnect.apple.com'+path,{method,headers:{Authorization:'Bearer '+jwt(),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const t=await r.text();let j;try{j=t?JSON.parse(t):{}}catch{j={raw:t}}return {status:r.status,json:j};}
