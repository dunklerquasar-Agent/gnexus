// Exercise translated loss warnings and HTML escaping in the actual UI script.
// The page runs in jsdom with dev-mock, not native Tauri or a real device.
'use strict';
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ui=path.resolve(process.argv[2] || path.join(__dirname, '../../crates/g13-gui/ui'));
const files=['profile-delta.js','dev-mock.js','i18n.js','catalog.js','device.js','mouse-device.js','macro-editor.js','mouse.js','headset.js','app.js'];
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(String(e)));
const dom=new JSDOM(fs.readFileSync(path.join(ui,'index.html'),'utf8'),{url:'https://local.test/?os=windows&nomouse&nohs',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
const w=dom.window;w.structuredClone=structuredClone;w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.setInterval=()=>0;
w.HTMLCanvasElement.prototype.getContext=function(){const g={addColorStop(){}};return{clearRect(){},fillRect(){},putImageData(){},drawImage(){},beginPath(){},arc(){},fill(){},stroke(){},createLinearGradient(){return g},createImageData(width,height){return{data:new Uint8ClampedArray(width*height*4)}}}};
const code=files.map(f=>fs.readFileSync(path.join(ui,f),'utf8')).join('\n;\n')+'\n;window.__report={S,showReport,setLang:(v)=>LANG=v};';
w.eval(code);
const warnings=[
 'Mode souris et vitesse du stick non exportés ; les directions enregistrées peuvent devenir actives.',
 'Mode manette du stick non exporté ; les directions enregistrées peuvent devenir actives.',
 'Zone morte et/ou cible manette du stick non exportées.',
 '<img src=x onerror=alert(1)>',
];
(async()=>{
 const end=Date.now()+3000;
 while(!w.__report.S.editId){if(Date.now()>end)throw Error('timeout: mock UI boot');await new Promise(r=>setTimeout(r,5));}
 try{
 for(const [lang,word] of [['en','not exported'],['de','nicht exportiert'],['it','esportat'],['es','exporta']]){
  w.__report.setLang(lang);w.__report.showReport('EXPORT','',warnings);
  const list=[...w.document.querySelectorAll('#report-list li')];assert.equal(list.length,4);
  for(const item of list.slice(0,3))assert.ok(item.textContent.includes(word),lang+': '+item.textContent);
  assert.equal(list[3].textContent,warnings[3]);assert.equal(list[3].querySelector('img'),null);
 }
 assert.deepEqual(errors,[]);console.log('PASS: localized mouse/gamepad/dead-zone warnings and dynamic HTML escaping (jsdom).');
 }finally{w.close()}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
