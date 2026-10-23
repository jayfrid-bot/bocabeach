// Editable artwork. Frames 02–08 use unchanged screenshots; frame 01 uses a
// requested 95-point sample rendered from the real score engine and component.
// Run from the repository: node screenshots/appstore/1.2/redesign-astra-2026-10-09/source/compose.cjs
const fs=require('node:fs');
const path=require('node:path');
const sharp=require('sharp');
const root=path.resolve(__dirname,'..');
const W=1290,H=2796,INK='#102c3a',IVORY='#fff7e8',LIME='#e8f1ba';
const selectedFrame=process.argv.find(a=>a.startsWith('--frame='))?.split('=')[1];
const dims={};
function data(file){return 'data:image/png;base64,'+fs.readFileSync(path.join(root,'assets',file)).toString('base64')}
function esc(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;')}
function text(s,x,y,size=40,fill=IVORY,weight=500,spacing=-.5){return `<text x="${x}" y="${y}" font-family="Avenir Next, Helvetica Neue, Arial" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}">${esc(s)}</text>`}
function img(file,x,y,w,h,fit='xMidYMid slice'){return `<image href="${data(file)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${fit}"/>`}
let serial=0;
function ui(file,x,y,w,crop,r=36){
 const {width:iw,height:ih}=dims[file]; const [cx,cy,cw,ch]=crop||[0,0,iw,ih];const h=w*ch/cw;const id='ui'+(++serial);
 return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#fff" filter="url(#shadow)"/><g clip-path="url(#${id})"><svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${cx} ${cy} ${cw} ${ch}">${img(file,0,0,iw,ih,'none')}</svg></g>`;
}
function phone(file,x,y,w,{full=false,cropH=null,cropY=0}={}){
 const {width:iw,height:ih}=dims[file];const inner=w-42;const st=full?0:91;const screenH=(cropH||ih)*inner/iw+st;const h=screenH+42;const id='phone'+(++serial);
 return `<rect x="${x-5}" y="${y+240}" width="9" height="98" rx="4" fill="#8a8a86"/><rect x="${x+w-3}" y="${y+322}" width="9" height="148" rx="4" fill="#696c6c"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="122" fill="#858580" filter="url(#shadow)"/><rect x="${x+5}" y="${y+5}" width="${w-10}" height="${h-10}" rx="118" fill="#171b1d"/><defs><clipPath id="${id}"><rect x="${x+21}" y="${y+21}" width="${inner}" height="${screenH}" rx="101"/></clipPath></defs><g clip-path="url(#${id})"><rect x="${x+21}" y="${y+21}" width="${inner}" height="${screenH}" fill="#f3f7fb"/><svg x="${x+21}" y="${y+21+st}" width="${inner}" height="${screenH-st}" viewBox="0 ${cropY} ${iw} ${cropH||ih}">${img(file,0,0,iw,ih,'none')}</svg>${!full?`<rect x="${x+w/2-125}" y="${y+37}" width="250" height="54" rx="27" fill="#071012"/>`:''}</g>`;
}
function base(n,bg,light=false,opacity=.55,underlay=''){
 const fg=light?INK:IVORY;
 return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${light?'#fff7e8':'#021b28'}" stop-opacity="${opacity}"/><stop offset=".42" stop-color="${light?'#fff7e8':'#021b28'}" stop-opacity="${opacity*.3}"/><stop offset=".72" stop-opacity="0"/></linearGradient><linearGradient id="metal"><stop stop-color="#f4efe2"/><stop offset=".04" stop-color="#7b9395"/><stop offset=".4" stop-color="#102729"/><stop offset=".9" stop-color="#748687"/><stop offset="1" stop-color="#d2d5ca"/></linearGradient><filter id="shadow" x="-35%" y="-25%" width="170%" height="165%"><feDropShadow dx="0" dy="28" stdDeviation="27" flood-color="#001525" flood-opacity=".34"/></filter></defs><rect width="${W}" height="${H}" fill="${light?'#eee4d4':INK}"/>${img(bg,0,0,W,H)}<rect width="${W}" height="${H}" fill="url(#shade)"/>${underlay}${img('app-icon.png',90,86,49,49,'none')}${text('IS IT BEACH DAY?',160,122,27,fg,700,3.8)}${text(String(n).padStart(2,'0')+' / 08',1090,120,24,fg,500,2)}`;
}
function headline(lines,{y=343,size=153,gap=157,light=false,accent=LIME}={}){return lines.map((s,i)=>text(s,85,y+i*gap,size,i===lines.length-1?accent:(light?INK:IVORY),800,-7)).join('')}
function subtitle(lines,y,light=false){return lines.map((s,i)=>text(s,90,y+i*57,47,light?INK:IVORY,500,-.6)).join('')}
function pillRow(chips,y,{gap=18,height=72,size=31,startX=null}={}){
 const total=chips.reduce((n,c)=>n+c[1],0)+gap*(chips.length-1);
 let x=startX??(W-total)/2;
 return chips.map(([label,w])=>{const chip=`<rect x="${x}" y="${y}" width="${w}" height="${height}" rx="${height/2}" fill="${INK}" fill-opacity=".78" stroke="${IVORY}" stroke-opacity=".65" stroke-width="1.7"/><text x="${x+w/2}" y="${y+height/2+11}" text-anchor="middle" font-family="Avenir Next, Helvetica Neue, Arial" font-size="${size}" font-weight="600" letter-spacing=".7" fill="${IVORY}">${label}</text>`;x+=w+gap;return chip;}).join('');
}
function frameOne(){
 const footerShade=`<defs><linearGradient id="frame01-footer" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${INK}" stop-opacity="0"/><stop offset="1" stop-color="${INK}" stop-opacity=".9"/></linearGradient></defs><rect x="0" y="2030" width="1290" height="766" fill="url(#frame01-footer)"/>`;
 const sources=[['NOAA',180],['NWS',170],['BUOYS',210],['SATELLITE',280],['RADAR',198]];
 let x=90;
 const lines=sources.map(([label,w],i)=>{const center=x+w/2;x+=w+18;return `<path d="M ${center} 842 C ${center} 875, ${center+(645-center)*.25} 890, ${center+(645-center)*.35} 920" fill="none" stroke="${IVORY}" stroke-opacity=".42" stroke-width="2.5"/>`;}).join('');
 return base(1,'coast-day.png',false,.55,footerShade)+headline(['Know before','you go.'])+subtitle(['20+ live feeds. One score.','Just decide.'],631)+lines+pillRow(sources,770)+ui('01-app-95-demo.png',140,920,1010,[0,0,1170,1530],48)+text('PLUS THE DETAILS THAT MATTER',90,2314,26,IVORY,600,3)+pillRow([['CAMS',195],['TIDES',195],['FLAGS',195],['LIGHTNING',340]],2350,{gap:24,startX:90})+pillRow([['WATER QUALITY',355],['SAND TEMP',280],['RIP CURRENTS',355]],2448,{gap:24,startX:90})+pillRow([['SEAWEED',320],['CROWDS',300],['UV',220]],2546,{gap:24,startX:90});
}
async function save(name,svg){if(selectedFrame&&!name.startsWith(selectedFrame+'-'))return;svg+='</svg>';fs.writeFileSync(path.join(root,'source',name+'.svg'),svg);await sharp(Buffer.from(svg)).removeAlpha().withIccProfile('srgb').png().toFile(path.join(root,'exports',name+'.png'));await sharp(Buffer.from(svg)).removeAlpha().withIccProfile('srgb').jpeg({quality:96,chromaSubsampling:'4:4:4'}).toFile(path.join(root,'exports',name+'.jpg'));await sharp(Buffer.from(svg)).resize(645).jpeg({quality:90}).toFile(path.join(root,'preview',name+'.jpg'));console.log(name+' 1290 × 2796');}
async function main(){
 for(const f of fs.readdirSync(path.join(root,'assets')).filter(f=>f.endsWith('.png')))dims[f]=await sharp(path.join(root,'assets',f)).metadata();
 await save('01-know',frameOne());
 await save('02-lock-screen',base(2,'coast-day.png',false,.8,`<rect width="1290" height="2796" fill="#051a32" opacity=".45"/>`)+headline(['Your beach.','At a glance.'])+subtitle(['Live conditions on your Lock Screen.'],631)+phone('02-app.png',212,830,866,{full:true}));
 await save('03-own-score',base(3,'coast-sand.png',true,.45)+headline(['Your kind of','beach day.'],{light:true,accent:'#28706e'})+subtitle(['A score tuned to what','you come to the beach for.'],631,true)+text('MADE FOR YOU',90,963,28,INK,700,4)+ui('03-app.png',90,1055,1110,[0,1410,1170,1122],54)+`<line x1="90" x2="1200" y1="2410" y2="2410" stroke="${INK}" opacity=".28"/>`+text('Same beach. Your priorities.',90,2507,48,INK,600,-1)+text('PERSONALIZE WITH BEACH DAY PLUS',90,2595,26,INK,600,3));
 await save('04-rip-currents',base(4,'coast-storm.png',false,.3)+headline(['Check the','rip current','risk.'],{size:146,gap:149,y:331,accent:'#f3d786'})+subtitle(['Hourly forecasts. Lifeguard reports.'],771)+ui('04-app.png',90,942,1110,[46,46,1078,724],42)+ui('04-app.png',90,1765,1110,[46,812,1078,541],42)+`<rect x="0" y="2440" width="1290" height="356" fill="#071e2a" opacity=".45"/>`+text('Always follow lifeguard flags.',90,2575,42,IVORY,600,-.5)+text('Conditions are guidance. Local flags come first.',90,2650,30,IVORY,500,-.2));
 await save('05-lightning',base(5,'coast-storm.png',false,.3)+headline(['See nearby','lightning.'],{accent:'#f3d786'})+subtitle(['Strike distance, direction and timing.'],631)+text('KEEP CHANGING CONDITIONS IN VIEW',90,967,27,IVORY,600,3)+ui('05-app.png',90,1055,1110,[46,10,1078,1144],42)+text('NEAREST STRIKE · RECENT ACTIVITY',90,2570,27,IVORY,600,3));
 await save('06-cams',base(6,'coast-sand.png',true,.5)+headline(['See the beach','before you go.'],{size:141,light:true,accent:'#28706e'})+subtitle(['Fresh views from beach cameras.'],631,true)+ui('06-app.png',90,829,1110,[46,203,1078,872],42)+ui('06-app.png',90,1790,1110,[46,1118,1078,868],42));
 await save('07-plan',base(7,'coast-sand.png',true,.45)+headline(['Find your best','beach hours.'],{size:143,light:true,accent:'#28706e'})+subtitle(['Compare the week.','Make time for the coast.'],631,true)+phone('07-app.png',140,916,1010,{cropH:2392,cropY:140})+text('THE WEEK AHEAD',90,842,27,INK,700,4));
 await save('08-sunset',base(8,'coast-sunset.png',false,.4)+headline(['Be there for','golden hour.'],{size:150,accent:'#ffdcaa'})+subtitle(['Sunset timing and a forecast','for the evening’s color.'],631)+ui('08-app.png',175,1550,940,[46,130,522,563],96)+text('STAY FOR THE LAST LIGHT.',90,2690,27,IVORY,700,3));
 const names=fs.readdirSync(path.join(root,'exports')).filter(f=>f.endsWith('.jpg')).sort();
 const thumbW=322,thumbH=699,gap=24,margin=32,cols=4;
 const tiles=await Promise.all(names.map(async(f,i)=>({input:await sharp(path.join(root,'exports',f)).resize(thumbW,thumbH).toBuffer(),left:margin+(i%cols)*(thumbW+gap),top:margin+Math.floor(i/cols)*(thumbH+gap)})));
 await sharp({create:{width:margin*2+cols*thumbW+(cols-1)*gap,height:margin*2+2*thumbH+gap,channels:3,background:'#102c3a'}}).composite(tiles).jpeg({quality:95,chromaSubsampling:'4:4:4'}).toFile(path.join(root,'contact-sheet.jpg'));
 const strip=await Promise.all(names.map(async(f,i)=>({input:await sharp(path.join(root,'exports',f)).resize(258,559).toBuffer(),left:i*274,top:0})));
 await sharp({create:{width:2176,height:559,channels:3,background:'#102c3a'}}).composite(strip).jpeg({quality:95}).toFile(path.join(root,'contact-strip.jpg'));
}
main().catch(e=>{console.error(e);process.exit(1)});
