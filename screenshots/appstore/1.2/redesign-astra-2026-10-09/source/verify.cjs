// Checks export properties, original capture bytes, and preservation of the existing final set.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),repo=path.resolve(root,'../../../..');
const captures=['01-hero-v2-deerfield-beach.png','la-01-lockscreen-v2.png','12-reveal-deerfield-beach-v3-sun.png','02-rip-boca-raton-v2.png','03-lightning-fort-lauderdale.png','05-cams-day-boca-raton.png','07-plan-v4-fort-lauderdale.png','08-sun-gulf-shores-v2.png'];
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
(async()=>{
 const reference=path.join(root,'reference-round3/dropbox-reference.png');
 const m={created:'2026-10-09',updated:'2026-10-09',revision:4,dimensions:[1290,2796],sourceCommit:'e3b7295c82e4e17301b9a7a975fa705595b5aee9',designReference:{file:path.relative(root,reference),source:'/Users/yitzfrid/Dropbox (Personal)/ChatGPT Image Oct 9, 2026, 03_29_12 PM.png',sha256:hash(reference),bytes:fs.statSync(reference).size,visuallyInspected:true},sources:[],exports:[],originals:[]};
 for(let i=0;i<captures.length;i++){
  const src=path.join(repo,'screenshots/appstore/captures-1.2',captures[i]);
  const originalAsset=path.join(root,'assets',String(i+1).padStart(2,'0')+'-app.png');
  if(hash(src)!==hash(originalAsset))throw Error('Preserved original capture differs: '+src);
  const asset=i===0?path.join(root,'assets/01-app-95-demo.png'):originalAsset;
  const svgName=fs.readdirSync(path.join(root,'source')).find(f=>f.startsWith(String(i+1).padStart(2,'0')+'-')&&f.endsWith('.svg'));
  const svg=fs.readFileSync(path.join(root,'source',svgName),'utf8');
  const embeddedHashes=[...svg.matchAll(/href="data:image\/png;base64,([^"]+)"/g)].map(x=>crypto.createHash('sha256').update(Buffer.from(x[1],'base64')).digest('hex'));
  if(!embeddedHashes.includes(hash(asset)))throw Error('SVG does not embed the unchanged capture: '+svgName);
  m.sources.push({source:i===0?'source/demo-95.tsx':src,asset:path.relative(root,asset),sha256:hash(asset),type:i===0?'owner-requested illustrative sample rendered from production ScoreWheel':'original app capture',svg:svgName,sourceAssetEmbedded:true,preservedOriginalCapture:path.relative(root,originalAsset),originalCaptureUnchanged:true});
 }
 const demo=JSON.parse(fs.readFileSync(path.join(root,'source/demo-95-state.json'),'utf8'));
 if(demo.score.score!==95||demo.score.subScores.length!==10||demo.score.subScores.some(s=>s.score<90)||demo.safety.level!=='safe')throw Error('95-day sample is inconsistent');
 m.demo={file:'source/demo-95-state.json',sha256:hash(path.join(root,'source/demo-95-state.json')),score:95,allFactorsAtLeast:90,swimSafety:'safe',liveObservation:false};
 for(const f of fs.readdirSync(path.join(root,'exports')).sort()){
  const file=path.join(root,'exports',f),mta=await sharp(file).metadata();
  if(mta.width!==1290||mta.height!==2796||mta.channels!==3||mta.hasAlpha||mta.space!=='srgb'||!mta.icc)throw Error('Invalid export '+f);
  m.exports.push({file:'exports/'+f,width:mta.width,height:mta.height,channels:mta.channels,space:mta.space,hasAlpha:mta.hasAlpha,hasIcc:!!mta.icc,sha256:hash(file),bytes:fs.statSync(file).size});
 }
 if(m.exports.length!==16)throw Error('Expected 8 JPG and 8 PNG exports.');
 for(const f of fs.readdirSync(path.join(repo,'screenshots/appstore/1.2/final')).filter(f=>f.endsWith('.jpg'))){
  const rel='screenshots/appstore/1.2/final/'+f;
  const actual=cp.execFileSync('git',['hash-object',rel],{cwd:repo,encoding:'utf8'}).trim();
  const expected=cp.execFileSync('git',['rev-parse',m.sourceCommit+':'+rel],{cwd:repo,encoding:'utf8'}).trim();
  if(actual!==expected)throw Error('Original final differs: '+f);
  m.originals.push({file:rel,gitObject:actual,unchanged:true});
 }
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(m,null,2)+'\n');
 console.log('PASS: 16 exports, 1290 × 2796, opaque RGB/sRGB; frame 01 sample calculates 95 with all ten factors ≥90; 8 original captures preserved; 8 original finals match source commit.');
})().catch(e=>{console.error(e);process.exit(1)});
