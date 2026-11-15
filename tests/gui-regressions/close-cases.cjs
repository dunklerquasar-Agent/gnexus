// Real G Nexus UI scripts in two jsdom windows; native/Tauri side is a controlled MODEL.
// No real process, WebView2, filesystem, or device is opened.
'use strict';
const {JSDOM, VirtualConsole}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const ui=path.resolve(process.argv[2] || path.join(__dirname,'../../crates/g13-gui/ui'));
const {profileValueEqual:eq,applyProfileDelta:merge}=require(path.join(ui,'profile-delta.js'));
const clone=structuredClone, wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(f,msg,ms=2200)=>{const end=Date.now()+ms;while(!f()){if(Date.now()>end) throw Error('TIMEOUT: '+msg);await wait(3)}};
const files=['profile-delta.js','dev-mock.js','i18n.js','catalog.js','device.js','mouse-device.js','macro-editor.js','mouse.js','headset.js','app.js'];
const intercepted=['list_profiles','load_profile','load_profile_edit','save_profile','get_settings','window_ready','finish_window_close','close_overlay','create_profile','assign_game','record_start','record_stop'];
class Model {
 constructor(){this.profiles={demo:{name:'Demo',number:1,default:true,rules:[],banks:{M1:{},M2:{},M3:{}},macros:{}},second:{name:'Second',number:2,rules:[],banks:{M1:{},M2:{},M3:{}},macros:{}}};this.listeners={};this.gates=[];this.fails=[];this.log=[];this.pending=new Map();this.quit=false;this.exited=false;this.next=0;this.pages=[];this.errors=[]}
 hold(label,cmd){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});const g={label,cmd,promise,resolve,reject,started:false};this.gates.push(g);return g}
 fail(label,cmd){this.fails.push({label,cmd})}
 on(label,event,cb){(this.listeners[label]??={})[event]=cb;return ()=>{}}
 emit(label,event,payload){this.listeners[label]?.[event]?.({payload})}
 close(label){const token=++this.next;this.pending.set(label,token);this.emit(label,'flush-before-close',token);return token}
 shutdown(labels){this.quit=true;const req=labels.map(label=>[label,++this.next]);for(const [l,t] of req)this.pending.set(l,t);for(const [l,t] of req)this.emit(l,'flush-before-close',t);return req}
 cancel(){this.pending.clear();this.quit=false;for(const label of Object.keys(this.listeners))this.emit(label,'flush-close-cancelled',null)}
 async invoke(label,cmd,args={}){
  this.log.push({label,cmd,args:clone(args),phase:'begin'});
  const gate=this.gates.find(g=>g.label===label&&g.cmd===cmd&&!g.started);
  if(gate){gate.started=true;await gate.promise}
  const ix=this.fails.findIndex(f=>f.label===label&&f.cmd===cmd);
  if(ix>=0){this.fails.splice(ix,1);this.log.push({label,cmd,phase:'error'});throw Error('simulated failure: '+cmd)}
  let result;
  if(cmd==='list_profiles') result=Object.entries(this.profiles).map(([id,p],i)=>({id,number:i+1,name:p.name,default:!!p.default,apps:(p.rules||[]).map(r=>r.exe||r.title),error:null}));
  else if(cmd==='load_profile') result=clone(this.profiles[args.id]);
  else if(cmd==='load_profile_edit') result={profile:clone(this.profiles[args.id]),token:'session:'+args.id};
  else if(cmd==='save_profile'){
   const current=this.profiles[args.id];if(!current)throw Error('missing');
   const b=args.base.rules||[],e=args.profile.rules||[],c=current.rules||[];
   if(!eq(e,b)&&!eq(c,b)&&!eq(c,e))throw Error('RULES_CONFLICT');
   const next=merge(args.base,args.profile,current);next.rules=clone(eq(e,b)?c:e);this.profiles[args.id]=next;
   result={profile:clone(next),token:args.token};
  }else if(cmd==='get_settings')result={autostart:false,start_minimized:true,close_to_tray:true,overlay_key:'G25',language:'de',keyboard_layout:null};
  else if(cmd==='window_ready')result=true;
  else if(cmd==='close_overlay'){this.close(label);result=undefined}
  else if(cmd==='finish_window_close'){
   const actual=this.pending.get(label);this.log.push({label,cmd:'ACK',args:clone(args),valid:actual===args.token});
   if(actual!==args.token)result=false;
   else {
    this.pending.delete(label);
    if(!args.saved){if(this.quit)this.cancel();result=false}
    else if(this.quit){if(this.pending.size===0)this.exited=true;result=true}
    else result=true;
   }
  }else if(cmd==='create_profile'){
   this.profiles.created={name:args.name,number:3,rules:[],banks:{M1:{},M2:{},M3:{}},macros:{}};result='created';
  }else if(cmd==='record_start'||cmd==='record_stop'||cmd==='assign_game') result=cmd==='record_stop'?[]:undefined;
  else throw Error('unexpected command '+cmd);
  this.log.push({label,cmd,phase:'done'});return result;
 }
 page(label){
  const vc=new VirtualConsole();vc.on('jsdomError',e=>this.errors.push(label+': '+e));
  const dom=new JSDOM(fs.readFileSync(path.join(ui,'index.html'),'utf8'),{url:'https://local.test/?lang=de&os=windows&nomouse&nohs'+(label==='overlay'?'#overlay':''),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window;w.structuredClone=clone;w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.setInterval=()=>0;
  w.HTMLCanvasElement.prototype.getContext=function(){const g={addColorStop(){}};return{clearRect(){},fillRect(){},putImageData(){},drawImage(){},beginPath(){},arc(){},fill(){},stroke(){},createLinearGradient(){return g},createImageData(w,h){return{data:new Uint8ClampedArray(w*h*4)}}}};
  w.__shared=(cmd,args)=>this.invoke(label,cmd,args);w.__on=(name,cb)=>this.on(label,name,cb);
  const pieces=[];for(const f of files){pieces.push(fs.readFileSync(path.join(ui,f),'utf8'));if(f==='dev-mock.js')pieces.push(`{const old=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args={})=>${JSON.stringify(intercepted)}.includes(cmd)?window.__shared(cmd,args):old(cmd,args);const oldListen=window.__TAURI__.event.listen;window.__TAURI__.event.listen=(name,cb)=>['flush-before-close','flush-close-cancelled'].includes(name)?Promise.resolve(window.__on(name,cb)):oldListen(name,cb);}`)}
  pieces.push(`window.__api={S,save,loadEdit,flushProfile,flushAllEdits,closeOverlayFromPage,ask,G13Macros,invoke,failedSaves,pendingSaves,get closeBusy(){return closeBusy()}};`);
  w.eval(pieces.join('\n;\n'));this.pages.push(w);return w;
 }
 async ready(w){await until(()=>w.__api.S.editId==='demo','page boot');assert.equal(w.document.body.inert,false)}
 ack(label,token){return this.log.find(x=>x.cmd==='ACK'&&x.label===label&&x.args.token===token)}
 dispose(){for(const w of this.pages)w.close()}
}
let scenarioCount=0;
async function scenario(name,fn){if(process.env.ONLY && !name.includes(process.env.ONLY)) return;scenarioCount++;const b=new Model();try{await fn(b);assert.deepEqual(b.errors,[]);console.log('PASS '+name)}finally{await wait(25);b.dispose()}}
(async()=>{
 await scenario('startup cannot edit before close-listener registration',async b=>{
  const gate=b.hold('main','window_ready'),m=b.page('main');await until(()=>gate.started,'window_ready called',700);
  assert.equal(m.document.body.inert,true);assert.equal(m.__api.S.dto,null);assert.ok(b.listeners.main['flush-before-close']);
  gate.resolve();await b.ready(m);
 });
 await scenario('failed profile save refuses close and retains draft',async b=>{
  const m=b.page('main');await b.ready(m);b.fail('main','save_profile');m.__api.S.dto.banks.M1.G2='W';m.__api.save();const token=b.close('main');
  await until(()=>b.ack('main',token),'failed profile ack');await until(()=>!m.__api.closeBusy,'unfrozen');assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.S.dto.banks.M1.G2,'W');assert.ok(m.__api.failedSaves.has('demo'));assert.equal(b.profiles.demo.banks.M1.G2,undefined);assert.equal(m.document.body.inert,false);
 });
 await scenario('quit with two windows waits for both; one failure cancels and releases first',async b=>{
  const m=b.page('main'),o=b.page('overlay');await b.ready(m);await b.ready(o);const v=b.hold('overlay','save_profile');
  m.__api.S.dto.banks.M1.G1='Q';m.__api.save();o.__api.S.dto.banks.M2.G2='W';o.__api.save();
  const req=b.shutdown(['main','overlay']);const tm=req[0][1],to=req[1][1];await until(()=>b.ack('main',tm),'first ack');await until(()=>v.started,'second held');
  assert.equal(b.exited,false);assert.equal(m.document.body.inert,true);b.fail('overlay','save_profile');v.resolve();await until(()=>b.ack('overlay',to),'second failure');await until(()=>!m.__api.closeBusy&&!o.__api.closeBusy,'both released');
  assert.equal(b.ack('overlay',to).args.saved,false);assert.equal(b.exited,false);assert.equal(m.document.body.inert,false);assert.ok(o.__api.failedSaves.has('demo'));assert.equal(o.__api.S.dto.banks.M2.G2,'W');
 });
 await scenario('restart/quit succeeds only after both windows acknowledge',async b=>{
  const m=b.page('main'),o=b.page('overlay');await b.ready(m);await b.ready(o);const p=b.hold('overlay','save_profile');
  m.__api.S.dto.banks.M1.G1='Q';m.__api.save();o.__api.S.dto.banks.M2.G2='W';o.__api.save();const req=b.shutdown(['main','overlay']);
  await until(()=>p.started,'overlay held');await until(()=>b.ack('main',req[0][1]),'main held at barrier');assert.equal(b.exited,false);assert.equal(m.document.body.inert,true);p.resolve();await until(()=>b.exited,'last ack exits');assert.equal(b.profiles.demo.banks.M1.G1,'Q');assert.equal(b.profiles.demo.banks.M2.G2,'W');
 });
 await scenario('new close after cancellation is queued, not dropped',async b=>{
  const m=b.page('main');await b.ready(m);const v=b.hold('main','save_profile');m.__api.S.dto.banks.M1.G1='Q';m.__api.save();const first=b.close('main');await until(()=>v.started,'first held');
  b.cancel();const second=b.close('main');v.resolve();await until(()=>b.ack('main',second),'new token ack');assert.equal(b.ack('main',first).valid,false);assert.equal(b.ack('main',second).args.saved,true);assert.equal(b.ack('main',second).valid,true);
 });
 await scenario('late positive ack after cancel does not refreeze page',async b=>{
  const m=b.page('main');await b.ready(m);const a=b.hold('main','finish_window_close');const token=b.close('main');await until(()=>a.started,'ack held');b.cancel();a.resolve();await until(()=>b.ack('main',token),'stale ack');await until(()=>!m.__api.closeBusy,'unfrozen');assert.equal(m.document.body.inert,false);
 });
 await scenario('open name dialog vetoes close and stays available',async b=>{
  const m=b.page('main');await b.ready(m);const ask=m.__api.ask('Name','unfinished');assert.ok(m.document.querySelector('#prompt.open'));const token=b.close('main');
  await until(()=>b.ack('main',token),'dialog veto');await until(()=>!m.__api.closeBusy,'unfrozen');assert.equal(b.ack('main',token).args.saved,false);assert.ok(m.document.querySelector('#prompt.open'));m.document.querySelector('#prompt-cancel').click();await ask;
 });
 await scenario('in-flight profile creation is joined; new mutation is blocked',async b=>{
  const m=b.page('main');await b.ready(m);const c=b.hold('main','create_profile');const job=m.__api.invoke('create_profile',{name:'Created',from:null});await until(()=>c.started,'creation held');const token=b.close('main');
  await assert.rejects(m.__api.invoke('assign_game',{id:'demo',exe:'x',token:'session:demo'}),/WINDOW_CLOSING/);await wait(20);assert.equal(b.ack('main',token),undefined);c.resolve();await job;await until(()=>b.ack('main',token),'creation joined');assert.equal(b.ack('main',token).args.saved,true);assert.equal(b.profiles.created.name,'Created');
 });
 await scenario('in-flight macro recording start is detected and vetoes close',async b=>{
  const m=b.page('main');await b.ready(m);const r=b.hold('main','record_start');const job=m.__api.G13Macros.toggleRecord();await until(()=>r.started,'record start');const token=b.close('main');r.resolve();await job;await until(()=>b.ack('main',token),'record veto');assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.G13Macros.recording,true);
 });
 await scenario('in-flight navigation cannot replace draft after close begins',async b=>{
  const m=b.page('main');await b.ready(m);const l=b.hold('main','load_profile_edit');const nav=m.__api.loadEdit('second');await until(()=>l.started,'navigation held');const token=b.close('main');await until(()=>b.ack('main',token),'close ack');l.resolve();assert.equal(await nav,false);assert.equal(m.__api.S.editId,'demo');
 });
 await scenario('overlay page button uses same handshake',async b=>{
  const o=b.page('overlay');await b.ready(o);o.__api.S.dto.banks.M1.G3='E';o.__api.save();await o.__api.closeOverlayFromPage();await until(()=>b.log.some(x=>x.cmd==='ACK'&&x.label==='overlay'),'overlay ack');assert.equal(b.profiles.demo.banks.M1.G3,'E');
 });
 console.log(`ALL PASS: ${scenarioCount} controlled jsdom scenarios. Native side is a model, not Tauri/Windows.`);
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
