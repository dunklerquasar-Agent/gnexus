// Real UI scripts, with jsdom and a deterministic in-memory settings/event
// backend. No native Tauri/WebView2/Windows, real input, profile or device.
'use strict';
const {JSDOM, VirtualConsole} = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ui = path.resolve(process.argv[2] || path.join(__dirname, '../../crates/g13-gui/ui'));
const files = ['profile-delta.js', 'dev-mock.js', 'i18n.js', 'catalog.js', 'device.js',
  'mouse-device.js', 'macro-editor.js', 'mouse.js', 'headset.js', 'app.js'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(f, name, timeout=3000) {
  const end=Date.now()+timeout;
  while (!f()) { if (Date.now()>end) throw Error('timeout: '+name); await delay(5); }
}
class Backend {
  constructor() {
    this.speed=100; this.listeners=new Map(); this.readHolds=[]; this.failSet=false; this.errors=[]; this.reads=0;
  }
  holdNextRead(label) {
    let release; const h={label,started:false,promise:new Promise(r=>release=r),release};
    this.readHolds.push(h); return h;
  }
  send(speed) {
    this.speed=speed;
    for (const cb of this.listeners.values()) cb({payload:speed});
  }
  emitOld(speed) { for (const cb of this.listeners.values()) cb({payload:speed}); }
  async invoke(label, cmd, args) {
    if (cmd==='get_settings') {
      this.reads++;
      const snapshot={autostart:false,start_minimized:true,close_to_tray:true,overlay_key:'G25',
        language:'de',keyboard_layout:'qwertz',stick_mouse_speed:this.speed,auto_backup:'off',auto_backup_keep:10};
      const hold=this.readHolds.find(h=>h.label===label&&!h.started);
      if (hold) { hold.started=true; await hold.promise; }
      return snapshot;
    }
    if (cmd==='set_stick_mouse_speed') {
      if (this.failSet) { this.failSet=false; throw Error('synthetic disk failure'); }
      assert.ok(Number.isInteger(args.speed) && args.speed>=10 && args.speed<=200);
      this.send(args.speed); return null;
    }
    throw Error('unexpected '+cmd);
  }
  page(label, hash='') {
    const vc=new VirtualConsole(); vc.on('jsdomError', e=>this.errors.push(label+': '+String(e)));
    const dom=new JSDOM(fs.readFileSync(path.join(ui,'index.html'),'utf8'), {
      url:'https://local.test/?lang=de&os=windows&nomouse&nohs'+hash,
      runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc,
    });
    const w=dom.window; w.structuredClone=structuredClone;
    w.ResizeObserver=class { observe(){} unobserve(){} disconnect(){} }; w.setInterval=()=>0;
    w.HTMLCanvasElement.prototype.getContext=function(){const g={addColorStop(){}};return {clearRect(){},fillRect(){},putImageData(){},drawImage(){},beginPath(){},arc(){},fill(){},stroke(){},createLinearGradient(){return g},createImageData(width,height){return {data:new Uint8ClampedArray(width*height*4)}}}};
    w.__settings=(cmd,args)=>this.invoke(label,cmd,args);
    w.__speedListen=cb=>{this.listeners.set(label,cb); return ()=>this.listeners.delete(label)};
    const parts=[];
    for (const f of files) {
      parts.push(fs.readFileSync(path.join(ui,f),'utf8'));
      if (f==='dev-mock.js') parts.push(`{
        const old=window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke=(cmd,args={})=>['get_settings','set_stick_mouse_speed'].includes(cmd)?window.__settings(cmd,args):old(cmd,args);
        const oldListen=window.__TAURI__.event.listen;
        window.__TAURI__.event.listen=(name,cb)=>name==='stick-mouse-speed-changed'?Promise.resolve(window.__speedListen(cb)):oldListen(name,cb);
      }`);
    }
    parts.push('window.__api={S,setGlobalStickMouseSpeed,flushGlobalStickMouseSpeed,flushAllEdits};');
    w.eval(parts.join('\n;\n')); return w;
  }
}
async function run(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const b=new Backend(), pages=[];
  const make=(label,hash='')=>{const p=b.page(label,hash);pages.push(p);return p};
  const ready=async p=>until(()=>p.__api?.S.editId==='demo','boot');
  try { await fn({b,make,ready}); assert.deepEqual(b.errors,[]); console.log('PASS '+name); }
  finally { for(const p of pages)p.close(); }
}
(async()=>{
  await run('event during initial settings read does not leave boot stale',async({b,make,ready})=>{
    const hold=b.holdNextRead('main'), main=make('main'); await until(()=>hold.started,'boot read captured');
    b.send(160); hold.release(); await ready(main); await until(()=>main.__api.S.stickMouseSpeed===160,'boot follows newer event');
  });
  await run('event between write and delayed settings response is not lost',async({b,make,ready})=>{
    const main=make('main'), over=make('overlay','#overlay'); await ready(main);await ready(over);
    const hold=b.holdNextRead('main');main.__api.setGlobalStickMouseSpeed(120);
    const job=main.__api.flushGlobalStickMouseSpeed(); await until(()=>hold.started,'post-write old snapshot');
    b.send(150); hold.release(); assert.equal(await job,true);
    await until(()=>main.__api.S.stickMouseSpeed===150 && over.__api.S.stickMouseSpeed===150,'both views follow newest speed');
    assert.equal(b.speed,150);
  });
  await run('new event during a remote refresh forces a fresh read',async({b,make,ready})=>{
    const main=make('main');await ready(main);
    const hold=b.holdNextRead('main');b.send(130);await until(()=>hold.started,'remote snapshot');
    b.send(175);hold.release();await until(()=>main.__api.S.stickMouseSpeed===175,'newer remote value');
  });
  await run('delayed older notification cannot revert the displayed speed',async({b,make,ready})=>{
    const main=make('main');await ready(main);
    b.send(180);await until(()=>main.__api.S.stickMouseSpeed===180,'new speed');
    b.emitOld(120);await delay(100);assert.equal(main.__api.S.stickMouseSpeed,180);assert.equal(b.speed,180);
  });
  await run('pending local speed wins until its write completes',async({b,make,ready})=>{
    const main=make('main');await ready(main);main.__api.setGlobalStickMouseSpeed(125);
    b.send(170);assert.equal(main.__api.S.stickMouseSpeed,125);
    assert.equal(await main.__api.flushGlobalStickMouseSpeed(),true);
    await until(()=>main.__api.S.stickMouseSpeed===125 && b.speed===125,'local last write');
  });
  await run('failed local speed remains visible and can be explicitly retried',async({b,make,ready})=>{
    const main=make('main');await ready(main);main.__api.setGlobalStickMouseSpeed(125);b.failSet=true;
    assert.equal(await main.__api.flushGlobalStickMouseSpeed(),false);b.send(170);await delay(30);
    assert.equal(main.__api.S.stickMouseSpeed,125);assert.equal(await main.__api.flushAllEdits(),true);
    await until(()=>b.speed===125 && main.__api.S.stickMouseSpeed===125,'retry');
  });
  console.log('PASS all selected speed races (jsdom; modeled IPC/events, no hardware)');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
