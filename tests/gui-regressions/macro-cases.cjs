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
const intercepted=['list_profiles','load_profile','load_profile_edit','save_profile','get_settings','window_ready','finish_window_close','close_overlay','create_profile','assign_game','record_start','record_stop','macro_library','save_library_macro','delete_library_macro','import_config','reset_config','backup_now'];
class Model {
 constructor(){this.profiles={demo:{name:'Demo',number:1,default:true,rules:[],banks:{M1:{},M2:{},M3:{}},macros:{}},second:{name:'Second',number:2,rules:[],banks:{M1:{},M2:{},M3:{}},macros:{}}};this.listeners={};this.gates=[];this.fails=[];this.log=[];this.pending=new Map();this.quit=false;this.exited=false;this.next=0;this.pages=[];this.errors=[];this.library={}}
 hold(label,cmd){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});const g={label,cmd,promise,resolve,reject,started:false};this.gates.push(g);return g}
 fail(label,cmd,error='simulated failure: '+cmd){this.fails.push({label,cmd,error})}
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
  if(ix>=0){const [{error}]=this.fails.splice(ix,1);this.log.push({label,cmd,phase:'error'});throw Error(error)}
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
  else if(cmd==='macro_library')result=clone(this.library);
  else if(cmd==='save_library_macro'){
   const prev=Object.hasOwn(this.library,args.name)?this.library[args.name]:null;
   if(args.old&&args.old!==args.name&&args.expected!=null)throw Error('MACRO_LIBRARY_NAME_EXISTS:'+args.name);
   if(eq(prev,args.mac)&&(!args.old||args.old===args.name||!Object.hasOwn(this.library,args.old)))return undefined;
   if(!eq(prev,args.expected??null))throw Error('MACRO_LIBRARY_CONFLICT:'+args.name);
   if(args.old&&args.old!==args.name){const was=Object.hasOwn(this.library,args.old)?this.library[args.old]:null;if(!eq(was,args.expectedOld??null))throw Error('MACRO_LIBRARY_CONFLICT:'+args.old);delete this.library[args.old]}
   this.library[args.name]=clone(args.mac);result=undefined;
  }
  else if(cmd==='delete_library_macro'){
   if(Object.hasOwn(this.library,args.name)&&!eq(this.library[args.name],args.expected??null))throw Error('MACRO_LIBRARY_CONFLICT:'+args.name);
   delete this.library[args.name];result=undefined;
  }
  else if(cmd==='import_config'||cmd==='reset_config'){this.library={imported:{mode:'once',steps:['down I','up I']}};result=cmd==='import_config'?1:undefined}
  else if(cmd==='backup_now')result='fixture-time';
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
 page(label,withMouse=false){
  const vc=new VirtualConsole();vc.on('jsdomError',e=>this.errors.push(label+': '+e));
  const dom=new JSDOM(fs.readFileSync(path.join(ui,'index.html'),'utf8'),{url:'https://local.test/?lang=de&os=windows&nohs'+(withMouse?'&host':'&nomouse')+(label==='overlay'?'#overlay':''),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window;w.structuredClone=clone;w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.setInterval=()=>0;
  w.HTMLCanvasElement.prototype.getContext=function(){const g={addColorStop(){}};return{clearRect(){},fillRect(){},putImageData(){},drawImage(){},beginPath(){},arc(){},fill(){},stroke(){},createLinearGradient(){return g},createImageData(w,h){return{data:new Uint8ClampedArray(w*h*4)}}}};
  w.__shared=(cmd,args)=>this.invoke(label,cmd,args);w.__on=(name,cb)=>this.on(label,name,cb);
  const pieces=[];for(const f of files){pieces.push(fs.readFileSync(path.join(ui,f),'utf8'));if(f==='dev-mock.js')pieces.push(`{const old=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args={})=>${JSON.stringify(intercepted)}.includes(cmd)?window.__shared(cmd,args):old(cmd,args);const oldListen=window.__TAURI__.event.listen;window.__TAURI__.event.listen=(name,cb)=>['flush-before-close','flush-close-cancelled'].includes(name)?Promise.resolve(window.__on(name,cb)):oldListen(name,cb);}`)}
  pieces.push(`window.__api={S,save,loadEdit,flushProfile,flushAllEdits,closeOverlayFromPage,replaceConfig,ask,G13Macros,MacroLib,Mouse,openPicker,renderPicker,invoke,failedSaves,pendingSaves,get closeBusy(){return closeBusy()}};`);
  w.eval(pieces.join('\n;\n'));this.pages.push(w);return w;
 }
 async ready(w){await until(()=>w.__api.S.editId==='demo','page boot');assert.equal(w.document.body.inert,false)}
 ack(label,token){return this.log.find(x=>x.cmd==='ACK'&&x.label===label&&x.args.token===token)}
 dispose(){for(const w of this.pages)w.close()}
}
let scenarioCount=0, knownGapCount=0;
async function scenario(name,fn){if(process.env.ONLY && !name.includes(process.env.ONLY)) return;scenarioCount++;if(name.startsWith('EXPECTED GAP:')) knownGapCount++;const b=new Model();try{await fn(b);assert.deepEqual(b.errors,[]);console.log('PASS '+name)}finally{await wait(25);b.dispose()}}
(async()=>{
 const mA={mode:'once',steps:['down A','up A']},mB={mode:'once',steps:['down B','up B']};
 const confirm=async m=>{await until(()=>m.document.querySelector('#prompt.open'),'confirmation');m.document.querySelector('#prompt-ok').click()};
 await scenario('close flushes debounced macro copy and waits for acknowledgement',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const gate=b.hold('main','save_library_macro');
  assert.equal(m.__api.G13Macros.add(),'macro-1');m.__api.G13Macros.changed();const token=b.close('main');
  await until(()=>gate.started,'library write started');assert.equal(b.ack('main',token),undefined);assert.ok(b.profiles.demo.macros['macro-1']);
  gate.resolve();await until(()=>b.ack('main',token),'close ack');assert.equal(b.ack('main',token).args.saved,true);assert.ok(b.library['macro-1']);
 });
 await scenario('failed library save vetoes close, displays queued data, retry succeeds',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();b.fail('main','save_library_macro');
  m.__api.MacroLib.put('alpha',mA);const token=b.close('main');await until(()=>b.ack('main',token),'failed ack');await until(()=>!m.__api.closeBusy,'unfrozen');
  assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.MacroLib.pending.length,1);assert.equal(b.library.alpha,undefined);
  assert.ok(!m.document.querySelector('#macro-save-banner').classList.contains('hidden'));assert.match(m.document.querySelector('#macro-draft-data').textContent,/alpha/);
  m.document.querySelector('#macro-draft-retry').click();await until(()=>m.__api.MacroLib.pending.length===0,'retry saved');assert.deepEqual(b.library.alpha,mA);
  const second=b.close('main');await until(()=>b.ack('main',second),'retry ack');assert.equal(b.ack('main',second).args.saved,true);
 });
 await scenario('existing profile macro edited while library loads is queued and saved',async b=>{
  const m=b.page('main');await b.ready(m);const load=b.hold('main','macro_library');const job=m.__api.MacroLib.ensure();await until(()=>load.started,'library load held');
  m.__api.S.dto.macros.alpha=structuredClone(mA);m.__api.G13Macros.sel='alpha';m.__api.G13Macros.changed();const token=b.close('main');
  await wait(30);assert.equal(b.ack('main',token),undefined);load.resolve();await job;await until(()=>b.ack('main',token),'load and save ack');
  assert.equal(b.ack('main',token).args.saved,true);assert.deepEqual(b.library.alpha,mA);assert.deepEqual(b.profiles.demo.macros.alpha,mA);
 });
 await scenario('late initial library read must not overwrite unseen concurrent same-name value',async b=>{
  b.library.shared=mA;const main=b.page('main'),over=b.page('overlay');await b.ready(main);await b.ready(over);await main.__api.MacroLib.ensure();
  const load=b.hold('overlay','macro_library');const loading=over.__api.MacroLib.ensure();await until(()=>load.started,'overlay load held');
  const mC={mode:'toggle',steps:['down C','up C']};over.__api.S.dto.macros.shared=structuredClone(mC);over.__api.G13Macros.sel='shared';over.__api.G13Macros.changed();
  main.__api.MacroLib.put('shared',mB);assert.equal(await main.__api.MacroLib.flush(),true);load.resolve();await loading;
  const ok=await over.__api.MacroLib.flush();assert.deepEqual(b.library.shared,mB,'new remote value must stay intact');
  assert.equal(ok,false,'unobserved remote value must not become the expected base');assert.equal(over.__api.MacroLib.pending.length,1);
  assert.equal(over.__api.MacroLib.blocked,true);assert.match(over.document.querySelector('#macro-save-message').textContent,/noch nicht geladen/);
  assert.equal(over.document.querySelector('#macro-draft-retry').disabled,true);assert.equal(await over.__api.MacroLib.flush(),false);
  assert.equal(await over.__api.flushProfile('demo'),true);over.document.querySelector('#macro-draft-discard').click();await confirm(over);
  await until(()=>over.__api.MacroLib.pending.length===0,'discard');assert.deepEqual(b.profiles.demo.macros.shared,mC);assert.deepEqual(b.library.shared,mB);
 });
 await scenario('unobserved absent name and dependent rename remain safe',async b=>{
  const m=b.page('main');await b.ready(m);const h=b.hold('main','macro_library');const loading=m.__api.MacroLib.ensure();await until(()=>h.started,'load held');
  m.__api.MacroLib.put('old',mA);m.__api.MacroLib.put('new',mB,'old');h.resolve();await loading;
  assert.equal(m.__api.MacroLib.blocked,false);assert.equal(await m.__api.MacroLib.flush(),true);assert.equal(b.library.old,undefined);assert.deepEqual(b.library.new,mB);
 });
 await scenario('unobserved identical put is idempotent',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);const h=b.hold('main','macro_library');const loading=m.__api.MacroLib.ensure();await until(()=>h.started,'load held');
  m.__api.MacroLib.put('shared',mA);h.resolve();await loading;assert.equal(m.__api.MacroLib.blocked,false);assert.equal(await m.__api.MacroLib.flush(),true);assert.deepEqual(b.library.shared,mA);
 });
 await scenario('unobserved delete of an existing value is blocked',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);const h=b.hold('main','macro_library');const loading=m.__api.MacroLib.ensure();await until(()=>h.started,'load held');
  m.__api.MacroLib.remove('shared');h.resolve();await loading;assert.equal(await m.__api.MacroLib.flush(),false);assert.deepEqual(b.library.shared,mA);
  const token=b.close('main');await until(()=>b.ack('main',token),'blocked close');assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.MacroLib.pending.length,1);
 });
 await scenario('G13 picker waits for library before assigning a noncolliding new macro',async b=>{
  b.library['macro-1']=mA;const m=b.page('main');await b.ready(m);const h=b.hold('main','macro_library');
  m.__api.openPicker('G1');m.__api.S.pickerTab='macros';m.__api.renderPicker();await until(()=>h.started,'picker load held');
  m.document.querySelector('#macro-new-assign').click();assert.equal(m.__api.S.dto.banks.M1.G1,undefined);assert.equal(Object.keys(m.__api.S.dto.macros).length,0);
  h.resolve();await until(()=>m.__api.MacroLib.items,'picker loaded');m.document.querySelector('#macro-new-assign').click();
  assert.equal(m.__api.S.dto.banks.M1.G1.macro,'macro-2');assert.ok(m.__api.S.dto.macros['macro-2']);assert.equal(await m.__api.flushAllEdits(),true);
  assert.deepEqual(b.library['macro-1'],mA);assert.ok(b.library['macro-2']);assert.equal(b.profiles.demo.banks.M1.G1.macro,'macro-2');
 });
 await scenario('mouse host picker waits for library before assigning a noncolliding new macro',async b=>{
  b.library['macro-1']=mA;const m=b.page('main',true);await b.ready(m);await until(()=>m.__api.Mouse.host()&&m.__api.Mouse.draft,'mock mouse ready');const h=b.hold('main','macro_library');
  m.__api.Mouse.pickButton(3,'G4');m.__api.S.pickerTab='macros';m.__api.renderPicker();await until(()=>h.started,'mouse picker load held');
  const before=structuredClone(m.__api.Mouse.draft.buttons[3]);m.document.querySelector('#macro-new-assign').click();assert.deepEqual(structuredClone(m.__api.Mouse.draft.buttons[3]),before);assert.equal(Object.keys(m.__api.Mouse.draftMacros()).length,0);
  h.resolve();await until(()=>m.__api.MacroLib.items,'mouse picker loaded');m.document.querySelector('#macro-new-assign').click();
  assert.equal(m.__api.Mouse.draft.buttons[3].macro,'macro-2');assert.ok(m.__api.Mouse.draftMacros()['macro-2']);assert.equal(await m.__api.MacroLib.flush(),true);
  assert.deepEqual(b.library['macro-1'],mA);assert.ok(b.library['macro-2']);
 });
 await scenario('stale picker must not assign a macro after cached library is replaced',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.openPicker('G1');m.__api.S.pickerTab='macros';m.__api.renderPicker();
  const tile=m.document.querySelector('[data-libmacro="shared"]');assert.ok(tile);m.__api.MacroLib.configReplaced();b.library={imported:mB};tile.click();
  assert.equal(m.__api.S.dto.banks.M1.G1,undefined,'stale library tile must not bind a nonexistent macro');assert.equal(Object.hasOwn(m.__api.S.dto.macros,'shared'),false);
 });
 await scenario('G13 picker can copy prototype-like library macro names safely',async b=>{
  Object.defineProperty(b.library,'__proto__',{value:mA,enumerable:true,configurable:true,writable:true});b.library.constructor=mB;
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.openPicker('G1');m.__api.S.pickerTab='macros';m.__api.renderPicker();
  const tile=m.document.querySelector('[data-libmacro="__proto__"]');assert.ok(tile,'library must list __proto__ as an own name');tile.click();
  assert.equal(Object.hasOwn(m.__api.S.dto.macros,'__proto__'),true);assert.deepEqual(structuredClone(m.__api.S.dto.macros['__proto__']),mA);assert.equal(m.__api.S.dto.banks.M1.G1.macro,'__proto__');
  assert.equal(await m.__api.flushProfile('demo'),true);assert.equal(Object.hasOwn(b.profiles.demo.macros,'__proto__'),true);
 });
 await scenario('G13 editor can copy prototype-like library names without prototype mutation',async b=>{
  Object.defineProperty(b.library,'__proto__',{value:mA,enumerable:true,configurable:true,writable:true});const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();
  m.__api.G13Macros.render();const tile=m.document.querySelector('#macro-list .macro-item.lib[data-name="__proto__"]');assert.ok(tile);tile.click();
  assert.equal(Object.hasOwn(m.__api.S.dto.macros,'__proto__'),true);assert.deepEqual(structuredClone(m.__api.S.dto.macros['__proto__']),mA);assert.equal(await m.__api.flushProfile('demo'),true);
  assert.equal(Object.hasOwn(b.profiles.demo.macros,'__proto__'),true);
 });
 await scenario('mouse host picker can copy prototype-like library names into its draft',async b=>{
  Object.defineProperty(b.library,'__proto__',{value:mA,enumerable:true,configurable:true,writable:true});const m=b.page('main',true);await b.ready(m);await until(()=>m.__api.Mouse.host()&&m.__api.Mouse.draft,'mock mouse ready');await m.__api.MacroLib.ensure();
  m.__api.Mouse.pickButton(3,'G4');m.__api.S.pickerTab='macros';m.__api.renderPicker();const tile=m.document.querySelector('[data-libmacro="__proto__"]');assert.ok(tile);tile.click();
  assert.equal(Object.hasOwn(m.__api.Mouse.draftMacros(),'__proto__'),true);assert.deepEqual(structuredClone(m.__api.Mouse.draftMacros()['__proto__']),mA);assert.equal(m.__api.Mouse.draft.buttons[3].macro,'__proto__');
 });
 await scenario('stale picker does not overwrite a newly present profile macro',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.openPicker('G1');m.__api.S.pickerTab='macros';m.__api.renderPicker();
  const tile=m.document.querySelector('[data-libmacro="shared"]');assert.ok(tile);m.__api.S.dto.macros.shared=structuredClone(mB);tile.click();
  assert.deepEqual(structuredClone(m.__api.S.dto.macros.shared),mB);assert.equal(m.__api.S.dto.banks.M1.G1,undefined);
 });
 await scenario('stale editor library tile is refused after replacement',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.G13Macros.render();const tile=m.document.querySelector('#macro-list .macro-item.lib[data-name="shared"]');assert.ok(tile);
  m.__api.MacroLib.configReplaced();b.library={imported:mB};tile.click();await wait(15);assert.equal(Object.hasOwn(m.__api.S.dto.macros,'shared'),false);
 });
 await scenario('delete confirmation cannot remove a replaced library value',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.G13Macros.render();
  const button=m.document.querySelector('#macro-list .macro-item.lib[data-name="shared"] [data-act="unlib"]');assert.ok(button);button.click();await until(()=>m.document.querySelector('#prompt.open'),'remove confirmation');
  m.__api.MacroLib.configReplaced();b.library.shared=mB;await m.__api.MacroLib.ensure();m.document.querySelector('#prompt-ok').click();await wait(450);
  assert.deepEqual(b.library.shared,mB,'confirmation for old macro must not delete replacement');assert.equal(m.__api.MacroLib.pending.length,0);
 });
 await scenario('confirmed library removal succeeds without deleting profile copies',async b=>{
  b.library.shared=mA;b.profiles.second.macros.shared=structuredClone(mA);const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.G13Macros.render();
  m.document.querySelector('#macro-list .macro-item.lib[data-name="shared"] [data-act="unlib"]').click();await confirm(m);
  await until(()=>!Object.hasOwn(b.library,'shared'),'library entry deleted');assert.deepEqual(b.profiles.second.macros.shared,mA);assert.equal(m.__api.MacroLib.pending.length,0);
 });
 await scenario('cancelled library removal leaves entry intact',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.G13Macros.render();
  m.document.querySelector('#macro-list .macro-item.lib[data-name="shared"] [data-act="unlib"]').click();await until(()=>m.document.querySelector('#prompt.open'),'remove confirmation');m.document.querySelector('#prompt-cancel').click();
  await wait(30);assert.deepEqual(b.library.shared,mA);assert.equal(m.__api.MacroLib.pending.length,0);
 });
 await scenario('remote update during removal confirmation triggers CAS conflict',async b=>{
  b.library.shared=mA;const m=b.page('main'),o=b.page('overlay');await b.ready(m);await b.ready(o);await m.__api.MacroLib.ensure();await o.__api.MacroLib.ensure();m.__api.G13Macros.render();
  m.document.querySelector('#macro-list .macro-item.lib[data-name="shared"] [data-act="unlib"]').click();await until(()=>m.document.querySelector('#prompt.open'),'remove confirmation');
  o.__api.MacroLib.put('shared',mB);assert.equal(await o.__api.MacroLib.flush(),true);m.document.querySelector('#prompt-ok').click();await until(()=>m.__api.MacroLib.error,'CAS conflict');
  assert.deepEqual(b.library.shared,mB);assert.equal(m.__api.MacroLib.pending.length,1);assert.match(m.__api.MacroLib.error,/MACRO_LIBRARY_CONFLICT/);
 });
 await scenario('local queue change invalidates earlier removal confirmation',async b=>{
  b.library.shared=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.G13Macros.render();
  m.document.querySelector('#macro-list .macro-item.lib[data-name="shared"] [data-act="unlib"]').click();await until(()=>m.document.querySelector('#prompt.open'),'remove confirmation');
  m.__api.MacroLib.put('other',mB);m.document.querySelector('#prompt-ok').click();await wait(450);assert.deepEqual(b.library.shared,mA);assert.deepEqual(b.library.other,mB);
 });
 await scenario('new name waits for library load and avoids existing library name',async b=>{
  b.library['macro-1']=mB;const m=b.page('main');await b.ready(m);const load=b.hold('main','macro_library');const job=m.__api.MacroLib.ensure();await until(()=>load.started,'load held');
  assert.equal(m.__api.G13Macros.add(),null);assert.equal(m.__api.S.dto.macros['macro-1'],undefined);load.resolve();await job;
  assert.equal(m.__api.G13Macros.add(),'macro-2');m.__api.G13Macros.changed();assert.equal(await m.__api.flushAllEdits(),true);
  assert.deepEqual(b.library['macro-1'],mB);assert.ok(b.library['macro-2']);
 });
 await scenario('delete is serialized behind older in-flight put and cannot resurrect it',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const save=b.hold('main','save_library_macro');
  m.__api.MacroLib.put('alpha',mA);const flush=m.__api.MacroLib.flush();await until(()=>save.started,'put held');m.__api.MacroLib.remove('alpha');
  await wait(35);assert.ok(!b.log.some(x=>x.cmd==='delete_library_macro'&&x.phase==='begin'));save.resolve();assert.equal(await flush,true);
  assert.equal(b.library.alpha,undefined);assert.equal(m.__api.MacroLib.pending.length,0);
 });
 await scenario('rename and later edit are ordered, old library name removed',async b=>{
  b.library.old=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();
  m.__api.MacroLib.put('old',mA);m.__api.MacroLib.put('new',mA,'old');m.__api.MacroLib.put('new',mB);
  assert.equal(await m.__api.flushAllEdits(),true);assert.equal(b.library.old,undefined);assert.deepEqual(b.library.new,mB);
 });
 await scenario('newer same-name edit during slow write is sent afterward',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const save=b.hold('main','save_library_macro');
  m.__api.MacroLib.put('alpha',mA);const flush=m.__api.MacroLib.flush();await until(()=>save.started,'first put held');m.__api.MacroLib.put('alpha',mB);
  assert.equal(m.__api.MacroLib.pending.length,2);save.resolve();assert.equal(await flush,true);assert.deepEqual(b.library.alpha,mB);
  assert.equal(b.log.filter(x=>x.cmd==='save_library_macro'&&x.phase==='begin').length,2);
 });
 await scenario('different names in one window are sent in order',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const save=b.hold('main','save_library_macro');
  m.__api.MacroLib.put('alpha',mA);m.__api.MacroLib.put('beta',mB);const flush=m.__api.MacroLib.flush();await until(()=>save.started,'first held');
  assert.equal(b.log.filter(x=>x.cmd==='save_library_macro'&&x.phase==='begin').length,1);save.resolve();assert.equal(await flush,true);
  assert.deepEqual(b.library,{alpha:mA,beta:mB});
 });
 await scenario('load error with queued edit refuses close and succeeds after retry',async b=>{
  const m=b.page('main');await b.ready(m);b.fail('main','macro_library');m.__api.MacroLib.put('alpha',mA);
  await until(()=>m.__api.MacroLib.loadError!==null,'load failed');
  // Fail the explicit close retry as well: the first failure was consumed by the background load.
  b.fail('main','macro_library');const token=b.close('main');await until(()=>b.ack('main',token),'close veto');await until(()=>!m.__api.closeBusy,'unfrozen');
  assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.MacroLib.pending.length,1);assert.equal(b.library.alpha,undefined);
  m.document.querySelector('#macro-draft-retry').click();await until(()=>m.__api.MacroLib.pending.length===0,'retry');assert.deepEqual(b.library.alpha,mA);
 });
 await scenario('load error without a queued edit is visible but does not prevent close',async b=>{
  const m=b.page('main');await b.ready(m);b.fail('main','macro_library');assert.equal(await m.__api.MacroLib.ensure(),null);
  assert.ok(!m.document.querySelector('#macro-save-banner').classList.contains('hidden'));m.__api.G13Macros.render();await wait(50);
  assert.equal(b.log.filter(x=>x.cmd==='macro_library'&&x.phase==='begin').length,1);
  const token=b.close('main');await until(()=>b.ack('main',token),'close ack');assert.equal(b.ack('main',token).args.saved,true);
 });
 await scenario('flushAllEdits joins held macro write before returning',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const save=b.hold('main','save_library_macro');m.__api.MacroLib.put('alpha',mA);
  let done=false;const flush=m.__api.flushAllEdits().then(x=>{done=true;return x});await until(()=>save.started,'write held');assert.equal(done,false);save.resolve();assert.equal(await flush,true);assert.deepEqual(b.library.alpha,mA);
 });
 await scenario('explicit discard requires confirmation, preserves the profile copy',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.S.dto.macros.alpha=structuredClone(mA);m.__api.G13Macros.sel='alpha';m.__api.G13Macros.changed();
  b.fail('main','save_library_macro');assert.equal(await m.__api.flushAllEdits(),false);assert.deepEqual(b.profiles.demo.macros.alpha,mA);
  m.document.querySelector('#macro-draft-discard').click();await confirm(m);await until(()=>m.__api.MacroLib.pending.length===0,'discarded');
  assert.deepEqual(b.profiles.demo.macros.alpha,mA);assert.equal(b.library.alpha,undefined);
 });
 await scenario('discard confirmation is invalidated by a newer queued change',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();b.fail('main','save_library_macro');m.__api.MacroLib.put('alpha',mA);assert.equal(await m.__api.MacroLib.flush(),false);
  m.document.querySelector('#macro-draft-discard').click();await until(()=>m.document.querySelector('#prompt.open'),'discard prompt');m.__api.MacroLib.put('beta',mB);
  m.document.querySelector('#prompt-ok').click();await wait(30);assert.equal(m.__api.MacroLib.pending.length,2);assert.match(m.document.querySelector('#toast').textContent,/Warteschlange hat sich geändert/);
 });
 await scenario('synthetic edit during config import is held and blocked against new library',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const gate=b.hold('main','import_config');const task=m.__api.replaceConfig(false);await confirm(m);await until(()=>gate.started,'import held');
  m.__api.MacroLib.put('late',mA);gate.resolve();await task;await wait(450);
  assert.equal(m.__api.MacroLib.blocked,true);assert.equal(m.__api.MacroLib.pending.length,1);assert.equal(b.library.late,undefined);assert.ok(b.library.imported);
  assert.equal(await m.__api.MacroLib.flush(),false);assert.ok(!b.log.some(x=>x.cmd==='save_library_macro'));
 });
 await scenario('partial config replacement blocks a concurrent macro queue',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const gate=b.hold('main','import_config');const task=m.__api.replaceConfig(false);await confirm(m);await until(()=>gate.started,'import held');
  m.__api.MacroLib.put('late',mA);b.fail('main','import_config','CONFIG_MAY_BE_PARTIAL: synthetic write error');gate.resolve();await task;await wait(450);
  assert.equal(m.__api.MacroLib.blocked,true);assert.equal(m.__api.MacroLib.pending.length,1);assert.equal(await m.__api.MacroLib.flush(),false);
  assert.ok(!b.log.some(x=>x.cmd==='save_library_macro'));assert.ok(m.__api.failedSaves.has('demo'));
 });
 await scenario('stale library read after configuration replacement is ignored',async b=>{
  b.library.old=mA;const m=b.page('main');await b.ready(m);const h=b.hold('main','macro_library');const loading=m.__api.MacroLib.ensure();await until(()=>h.started,'stale load held');
  m.__api.MacroLib.configReplaced();b.library={imported:mB};h.resolve();assert.equal(await loading,null);assert.equal(m.__api.MacroLib.items,null);
  const fresh=await m.__api.MacroLib.ensure();assert.deepEqual(structuredClone(fresh.imported),mB);assert.equal(fresh.old,undefined);
 });
 await scenario('library read cannot start while a configuration import is in flight',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const h=b.hold('main','import_config');const task=m.__api.replaceConfig(false);await confirm(m);await until(()=>h.started,'import held');
  m.__api.MacroLib.items=null;const before=b.log.filter(x=>x.cmd==='macro_library'&&x.phase==='begin').length;assert.equal(await m.__api.MacroLib.ensure(),null);
  assert.equal(b.log.filter(x=>x.cmd==='macro_library'&&x.phase==='begin').length,before);m.__api.MacroLib.put('late',mA);h.resolve();await task;
  assert.equal(m.__api.MacroLib.blocked,true);assert.equal(b.library.late,undefined);
 });
 await scenario('concurrent profile and macro drafts both survive config import',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const h=b.hold('main','import_config');const task=m.__api.replaceConfig(false);await confirm(m);await until(()=>h.started,'import held');
  m.__api.S.dto.name='local profile draft';m.__api.save();m.__api.MacroLib.put('late',mA);h.resolve();await task;
  assert.equal(m.__api.MacroLib.blocked,true);assert.equal(m.__api.MacroLib.pending.length,1);assert.ok(m.__api.failedSaves.has('demo'));assert.equal(m.__api.S.dto.name,'local profile draft');
  assert.equal(await m.__api.flushAllEdits(),false);assert.equal(b.library.late,undefined);
 });
 await scenario('failed macro queue prevents manual backup',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();b.fail('main','save_library_macro');m.__api.MacroLib.put('alpha',mA);m.document.querySelector('#set-backup-now').click();
  await until(()=>m.__api.MacroLib.error,'save error');await wait(30);assert.ok(!b.log.some(x=>x.cmd==='backup_now'));assert.equal(m.__api.MacroLib.pending.length,1);
 });
 await scenario('manual backup waits for queued library write',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const save=b.hold('main','save_library_macro');m.__api.MacroLib.put('alpha',mA);
  m.document.querySelector('#set-backup-now').click();await until(()=>save.started,'save held');assert.ok(!b.log.some(x=>x.cmd==='backup_now'));save.resolve();
  await until(()=>b.log.some(x=>x.cmd==='backup_now'&&x.phase==='done'),'backup issued');assert.deepEqual(b.library.alpha,mA);
 });
 await scenario('two windows preserve different library names with shared model',async b=>{
  const a=b.page('main'),o=b.page('overlay');await b.ready(a);await b.ready(o);await a.__api.MacroLib.ensure();await o.__api.MacroLib.ensure();
  a.__api.MacroLib.put('alpha',mA);o.__api.MacroLib.put('beta',mB);assert.equal(await a.__api.MacroLib.flush(),true);assert.equal(await o.__api.MacroLib.flush(),true);
  assert.deepEqual(b.library,{alpha:mA,beta:mB});
 });
 await scenario('same macro changed in another window conflicts and retains local queue',async b=>{
  b.library.shared=mA;const a=b.page('main'),o=b.page('overlay');await b.ready(a);await b.ready(o);await a.__api.MacroLib.ensure();await o.__api.MacroLib.ensure();
  a.__api.MacroLib.put('shared',mB);o.__api.MacroLib.put('shared',mA);assert.equal(await a.__api.MacroLib.flush(),true);assert.equal(await o.__api.MacroLib.flush(),false);
  assert.deepEqual(b.library.shared,mB);assert.equal(o.__api.MacroLib.pending.length,1);assert.match(o.document.querySelector('#macro-save-message').textContent,/an anderer Stelle geändert/);
  const token=b.close('overlay');await until(()=>b.ack('overlay',token),'conflict close');assert.equal(b.ack('overlay',token).args.saved,false);assert.deepEqual(b.library.shared,mB);
 });
 await scenario('identical same-name changes are an idempotent success',async b=>{
  b.library.shared=mA;const a=b.page('main'),o=b.page('overlay');await b.ready(a);await b.ready(o);await a.__api.MacroLib.ensure();await o.__api.MacroLib.ensure();
  a.__api.MacroLib.put('shared',mB);o.__api.MacroLib.put('shared',mB);assert.equal(await a.__api.MacroLib.flush(),true);assert.equal(await o.__api.MacroLib.flush(),true);assert.deepEqual(b.library.shared,mB);
 });
 await scenario('rename to an existing library name is refused before profile changes',async b=>{
  b.library.old=mA;b.library.taken=mB;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();
  m.__api.S.dto.macros.old=structuredClone(mA);m.__api.G13Macros.sel='old';m.__api.G13Macros.render();const input=m.document.querySelector('.macro-name');input.value='taken';input.dispatchEvent(new m.Event('change',{bubbles:true}));
  assert.ok(m.__api.S.dto.macros.old);assert.equal(Object.hasOwn(m.__api.S.dto.macros,'taken'),false);assert.equal(input.value,'old');assert.deepEqual(b.library.taken,mB);
 });
 await scenario('stale delete cannot remove a changed macro',async b=>{
  b.library.shared=mA;const a=b.page('main'),o=b.page('overlay');await b.ready(a);await b.ready(o);await a.__api.MacroLib.ensure();await o.__api.MacroLib.ensure();
  a.__api.MacroLib.put('shared',mB);o.__api.MacroLib.remove('shared');assert.equal(await a.__api.MacroLib.flush(),true);assert.equal(await o.__api.MacroLib.flush(),false);
  assert.deepEqual(b.library.shared,mB);assert.equal(o.__api.MacroLib.pending.length,1);
 });
 await scenario('stale rename preserves both the changed source and destination',async b=>{
  b.library.old=mA;const a=b.page('main'),o=b.page('overlay');await b.ready(a);await b.ready(o);await a.__api.MacroLib.ensure();await o.__api.MacroLib.ensure();
  a.__api.MacroLib.put('old',mB);o.__api.MacroLib.put('new',mA,'old');assert.equal(await a.__api.MacroLib.flush(),true);assert.equal(await o.__api.MacroLib.flush(),false);
  assert.deepEqual(b.library.old,mB);assert.equal(b.library.new,undefined);assert.equal(o.__api.MacroLib.pending.length,1);
 });
 await scenario('already applied rename is idempotent after a lost response',async b=>{
  b.library.old=mA;const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();m.__api.MacroLib.put('new',mA,'old');
  delete b.library.old;b.library.new=structuredClone(mA);assert.equal(await m.__api.MacroLib.flush(),true);assert.deepEqual(b.library.new,mA);assert.equal(b.library.old,undefined);
 });
 await scenario('overlay makes failed macro queue visible and opens recovery',async b=>{
  const o=b.page('overlay');await b.ready(o);const style=o.document.createElement('style');style.textContent=fs.readFileSync(path.join(ui,'style.css'),'utf8');o.document.head.append(style);
  await o.__api.MacroLib.ensure();b.fail('overlay','save_library_macro');o.__api.MacroLib.put('alpha',mA);const token=b.close('overlay');
  await until(()=>b.ack('overlay',token),'failed close');await until(()=>!o.__api.closeBusy,'unfrozen');
  assert.equal(b.ack('overlay',token).args.saved,false);assert.equal(o.getComputedStyle(o.document.querySelector('#macro-save-banner')).display,'flex');
  o.document.querySelector('#macro-save-review').click();assert.ok(o.document.querySelector('#advanced.open'));assert.ok(!o.document.querySelector('#macro-draft').classList.contains('hidden'));
 });
 await scenario('overlay makes failed profile draft visible',async b=>{
  const o=b.page('overlay');await b.ready(o);const style=o.document.createElement('style');style.textContent=fs.readFileSync(path.join(ui,'style.css'),'utf8');o.document.head.append(style);
  b.fail('overlay','save_profile');o.__api.S.dto.name='Not saved';o.__api.save();const token=b.close('overlay');
  await until(()=>b.ack('overlay',token),'failed close');await until(()=>!o.__api.closeBusy,'unfrozen');
  assert.equal(b.ack('overlay',token).args.saved,false);assert.equal(o.getComputedStyle(o.document.querySelector('#profile-save-banner')).display,'flex');
 });
 await scenario('profile edit while library write is held is checked again before close',async b=>{
  const m=b.page('main');await b.ready(m);await m.__api.MacroLib.ensure();const save=b.hold('main','save_library_macro');m.__api.MacroLib.put('alpha',mA);const token=b.close('main');
  await until(()=>save.started,'library held');m.__api.S.dto.name='later profile edit';m.__api.save();save.resolve();await until(()=>b.ack('main',token),'close ack');
  assert.equal(b.ack('main',token).args.saved,true);assert.equal(b.profiles.demo.name,'later profile edit');assert.deepEqual(b.library.alpha,mA);
 });
 await scenario('overlay page refuses to request close if its macro queue fails',async b=>{
  const o=b.page('overlay');await b.ready(o);await o.__api.MacroLib.ensure();b.fail('overlay','save_library_macro');
  o.__api.MacroLib.put('alpha',mA);await o.__api.closeOverlayFromPage();
  assert.equal(o.__api.MacroLib.pending.length,1);assert.equal(b.library.alpha,undefined);
  assert.ok(!b.log.some(x=>x.cmd==='close_overlay'&&x.phase==='begin'),'close should not be requested before the macro queue can drain');
  assert.equal(await o.__api.MacroLib.flush(),true);await o.__api.closeOverlayFromPage();
  await until(()=>b.log.some(x=>x.cmd==='ACK'&&x.label==='overlay'),'overlay close ack');
  assert.deepEqual(b.library.alpha,mA);assert.ok(b.log.some(x=>x.cmd==='ACK'&&x.args.saved));
 });
 await scenario('mouse draft blocks close until explicitly reverted',async b=>{
  b.library.shared=mA;const m=b.page('main',true);await b.ready(m);await until(()=>m.__api.Mouse.host()&&m.__api.Mouse.draft,'mock mouse ready');await m.__api.MacroLib.ensure();
  m.__api.Mouse.pickButton(3,'G4');m.__api.S.pickerTab='macros';m.__api.renderPicker();const tile=m.document.querySelector('[data-libmacro="shared"]');assert.ok(tile);tile.click();assert.equal(m.__api.Mouse.dirty(),true);
  const token=b.close('main');await until(()=>b.ack('main',token),'modeled close ack');assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.Mouse.dirty(),true);
  await until(()=>!m.__api.closeBusy,'unfrozen');const revert=m.document.querySelector('.ms-revert');assert.ok(revert);revert.click();assert.equal(m.__api.Mouse.dirty(),false);
  const second=b.close('main');await until(()=>b.ack('main',second),'close after revert');assert.equal(b.ack('main',second).args.saved,true);
 });
 await scenario('mouse draft created during a slow macro save vetoes close',async b=>{
  const m=b.page('main',true);await b.ready(m);await until(()=>m.__api.Mouse.host()&&m.__api.Mouse.draft,'mock mouse ready');await m.__api.MacroLib.ensure();
  const hold=b.hold('main','save_library_macro');m.__api.MacroLib.put('alpha',mA);const token=b.close('main');await until(()=>hold.started,'macro save held');
  m.__api.Mouse.draft.buttons[3]='Q';assert.equal(m.__api.Mouse.dirty(),true);hold.resolve();
  await until(()=>b.ack('main',token),'modeled close ack');assert.equal(b.ack('main',token).args.saved,false);assert.equal(m.__api.Mouse.dirty(),true);
 });
 await scenario('mouse save in progress vetoes close even before status arrives',async b=>{
  const m=b.page('main',true);await b.ready(m);await until(()=>m.__api.Mouse.host()&&m.__api.Mouse.draft,'mock mouse ready');
  assert.equal(m.__api.Mouse.dirty(),false);m.__api.Mouse.saving=true;
  const token=b.close('main');await until(()=>b.ack('main',token),'modeled close ack');assert.equal(b.ack('main',token).args.saved,false);
  await until(()=>!m.__api.closeBusy,'unfrozen');m.__api.Mouse.saving=false;const second=b.close('main');await until(()=>b.ack('main',second),'close after save');assert.equal(b.ack('main',second).args.saved,true);
 });
 console.log(`ALL ASSERTIONS PASS: ${scenarioCount-knownGapCount} controlled jsdom checks, ${knownGapCount} documented expected gap(s); IPC, native close and library are models.`);
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
