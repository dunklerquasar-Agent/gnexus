// Real UI scripts; the window-close IPC and device status are test doubles.
// This runs no application, device, real input injector or real profile.
'use strict';
const {JSDOM, VirtualConsole}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ui=path.resolve(process.argv[2] || path.join(__dirname, '../../crates/g13-gui/ui'));
const files=['profile-delta.js','dev-mock.js','i18n.js','catalog.js','device.js','mouse-device.js','macro-editor.js','mouse.js','headset.js','app.js'];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,name,ms=3000){const end=Date.now()+ms;while(!f()){if(Date.now()>end)throw Error('timeout: '+name);await wait(5)}}
function rig() {
  const errors=[],acks=[];let hold=null;
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(String(e)));
  const dom=new JSDOM(fs.readFileSync(path.join(ui,'index.html'),'utf8'),{
    url:'https://local.test/?lang=de&os=windows&nohs&host',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc,
  });
  const w=dom.window;w.structuredClone=structuredClone;w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.setInterval=()=>0;
  w.HTMLCanvasElement.prototype.getContext=function(){const g={addColorStop(){}};return {clearRect(){},fillRect(){},putImageData(){},drawImage(){},beginPath(){},arc(){},fill(){},stroke(){},createLinearGradient(){return g},createImageData(width,height){return {data:new Uint8ClampedArray(width*height*4)}}}};
  w.__gate=async(cmd,args,original)=>{
    if(cmd==='finish_window_close'){acks.push(structuredClone(args));return false;}
    if(cmd==='save_library_macro' && hold && !hold.started){hold.started=true;await hold.promise;}
    return original(cmd,args);
  };
  const parts=[];for(const f of files){parts.push(fs.readFileSync(path.join(ui,f),'utf8'));if(f==='dev-mock.js')parts.push(`{const original=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args={})=>window.__gate(cmd,args,original);}`)}
  parts.push('window.__api={S,Mouse,MacroLib,flushBeforeClose,get closeBusy(){return closeBusy()}};');
  w.eval(parts.join('\n;\n'));
  return {w,errors,acks,holdSave(){let release;hold={started:false,promise:new Promise(r=>release=r),release};return hold;}};
}
async function ready(r){await until(()=>r.w.__api?.S.editId==='demo'&&r.w.__api.Mouse.host()&&r.w.__api.Mouse.draft,'mock UI boot');}
async function run(name,fn){
  if(process.env.ONLY && !name.includes(process.env.ONLY))return;
  const r=rig();try{await ready(r);await fn(r);assert.deepEqual(r.errors,[]);console.log('PASS '+name)}finally{r.w.close()}
}
(async()=>{
  await run('dirty mouse draft vetoes close until explicitly reverted',async r=>{
    const {Mouse,flushBeforeClose}=r.w.__api;Mouse.draft.buttons[3]='Q';assert.equal(Mouse.dirty(),true);
    await flushBeforeClose({payload:1});assert.equal(r.acks[0].saved,false);assert.equal(Mouse.dirty(),true);
    await until(()=>!r.w.__api.closeBusy,'close cancellation');r.w.document.querySelector('.ms-revert').click();assert.equal(Mouse.dirty(),false);
    await flushBeforeClose({payload:2});assert.equal(r.acks[1].saved,true);
  });
  await run('draft created while another save is pending is rechecked',async r=>{
    const {Mouse,MacroLib,flushBeforeClose}=r.w.__api;await MacroLib.ensure();const hold=r.holdSave();
    MacroLib.put('check',{mode:'once',steps:['down A','up A']});const close=flushBeforeClose({payload:1});await until(()=>hold.started,'macro save held');
    Mouse.draft.buttons[3]='Q';assert.equal(Mouse.dirty(),true);hold.release();await close;assert.equal(r.acks[0].saved,false);assert.equal(Mouse.dirty(),true);
  });
  await run('an in-flight mouse save vetoes close even with a clean draft',async r=>{
    const {Mouse,flushBeforeClose}=r.w.__api;assert.equal(Mouse.dirty(),false);Mouse.saving=true;
    await flushBeforeClose({payload:1});assert.equal(r.acks[0].saved,false);await until(()=>!r.w.__api.closeBusy,'close cancellation');
    Mouse.saving=false;await flushBeforeClose({payload:2});assert.equal(r.acks[1].saved,true);
  });
  console.log('PASS selected close checks (jsdom; modeled IPC/device, not native Windows)');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
