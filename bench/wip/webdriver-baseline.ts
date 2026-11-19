import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = '/Users/devin/repos/safari-harness';
const dir = '/Users/devin/bench-waits';
const source = (name:string) => readFileSync(`${root}/extension/${name}`, 'utf8');
const swift = readFileSync(`${root}/scripts/bench.swift`, 'utf8');
const shim = swift.split('let runtimeShim = #"""')[1].split('"""#')[0];
const fixture = `<label>Kept <input id="keep"></label><label>Rejected <input id="reject" oninput="this.value=''"></label><label>Plan <select id="plan"><option>A</option><option>B</option></select></label><button id="idle">Idle</button>`;
const bridge = `window.webkit={messageHandlers:{bench:{postMessage:()=>{}},benchStart:{postMessage:()=>Promise.resolve({content:true,dialogs:{accept:false,text:null},tab:1,window:1})}}};`;
const server = Bun.serve({hostname:'127.0.0.1',port:38472,fetch(req){
  const path=new URL(req.url).pathname;
  if(['/dialogs.js','/start.js','/content.js'].includes(path)) return new Response(source(path.slice(1)),{headers:{'Content-Type':'text/javascript'}});
  if(path==='/shim.js') return new Response(bridge+shim,{headers:{'Content-Type':'text/javascript'}});
  return new Response(`<!doctype html><html><head><title>Wait baseline</title>${path==='/safari'?'<script src="/dialogs.js"></script><script src="/shim.js"></script>':''}</head><body>${fixture}${path==='/safari'?'<script src="/start.js"></script><script src="/content.js"></script>':''}</body></html>`,{headers:{'Content-Type':'text/html'}});
}});
async function measure() {
  const dispatch = (op:string,args:unknown[])=>window.__benchSend(JSON.stringify({__safariHarness:1,id:++window.__waitId,op,args})).then(JSON.parse);
  window.__waitId=10000;
  const cases=[
    {name:'a_type_kept',op:'type',args:(i:number)=>['#keep',`sample-${i}`],setup:()=>{const e=document.querySelector('#keep') as HTMLInputElement;e.value='';e.focus();}},
    {name:'b_type_rejected',op:'type',args:(i:number)=>['#reject',`sample-${i}`],setup:()=>{const e=document.querySelector('#reject') as HTMLInputElement;e.value='';e.focus();}},
    {name:'c_select_changed',op:'select',args:()=>['#plan','B'],setup:()=>{const e=document.querySelector('#plan') as HTMLSelectElement;e.value='A';e.focus();}},
    {name:'d_select_unchanged',op:'select',args:()=>['#plan','B'],setup:()=>{const e=document.querySelector('#plan') as HTMLSelectElement;e.value='B';e.focus();}},
    {name:'e_idle_click',op:'click',args:()=>['#idle'],setup:()=>{(document.querySelector('#idle') as HTMLElement).focus();}},
  ];
  const results=[];
  for(const c of cases){
    const samples:number[]=[];const replies:unknown[]=[];
    for(let i=0;i<20;i++){
      c.setup();
      const begin=performance.now();const reply=await dispatch(c.op,c.args(i));const ms=performance.now()-begin;
      if(reply.error||reply.value?.ok!==true) throw Error(JSON.stringify({case:c.name,i,reply}));
      if(c.op==='type'&&reply.value.kept!==(c.name==='a_type_kept')) throw Error('Unexpected kept: '+JSON.stringify(reply));
      if(c.op==='select'&&(document.querySelector('#plan') as HTMLSelectElement).value!=='B') throw Error('Select did not retain B');
      samples.push(ms);replies.push(reply);
    }
    const sorted=[...samples].sort((a,b)=>a-b);
    results.push({case:c.name,n:20,median_ms:+((sorted[9]+sorted[10])/2).toFixed(2),p90_ms:+sorted[17].toFixed(2),samples_ms:samples.map(n=>+n.toFixed(2)),...(c.op==='type'?{kept:replies.map((r:any)=>r.value.kept)}:{}),replies});
  }
  return {userAgent:navigator.userAgent,visibility:document.visibilityState,results};
}
const measureJS = measure.toString();
const base='http://127.0.0.1:4444';
const session=process.env.SAFARI_SESSION;
if(!session) throw Error('Set SAFARI_SESSION from POST /session');
async function wd(path:string,body:unknown){
  const r=await fetch(`${base}/session/${session}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json() as any;
  if(data.value?.error) throw Error(JSON.stringify(data));return data.value;
}
try {
  console.log('content_sha256='+createHash('sha256').update(source('content.js')).digest('hex'));
  console.log('N=20; ms=performance.now dispatch-to-resolved-reply; setup excluded; median=middle-pair mean; p90=nearest rank; no warmups; default waits; current dialogs.js present');
  await wd('/timeouts',{script:120000});
  await wd('/url',{url:'http://127.0.0.1:38472/safari'});
  const safari=await wd('/execute/async',{script:`const done=arguments[arguments.length-1];(${measureJS})().then(x=>done({ok:true,...x}),e=>done({error:String(e.stack||e)}));`,args:[]});
  writeFileSync(`${dir}/safari-raw.json`,JSON.stringify(safari,null,2));
  if(!safari.ok)throw Error(JSON.stringify(safari));
  console.log('SAFARI '+JSON.stringify({userAgent:safari.userAgent,visibility:safari.visibility}));
  for(const {replies,...summary} of safari.results)console.log(JSON.stringify(summary));
  const name=createHash('sha256').update(swift).digest('hex').slice(0,16);
  const runner=`${root}/.build/bench-${name}`;
  const requests=[{load:'http://127.0.0.1:38472/wk'},{op:'eval',args:[`(${measureJS})()`],timeout:120000}];
  writeFileSync(`${dir}/wk-requests.jsonl`,requests.map(r=>JSON.stringify(r)).join('\n')+'\n');
  console.log('WK_COMMAND='+runner+' '+root+'/extension < '+dir+'/wk-requests.jsonl');
  const p=Bun.spawn([runner,`${root}/extension`],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  p.stdin.write(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');p.stdin.end();
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  writeFileSync(`${dir}/wk-raw.jsonl`,out);writeFileSync(`${dir}/wk-stderr.log`,err);
  if(code!==0)throw Error(`WK exit ${code}: ${err}`);
  const rows=out.trim().split('\n').map(JSON.parse);const wk=rows[1]?.value?.result;
  if(!wk?.results)throw Error(out);
  console.log('WKWEBVIEW '+JSON.stringify({userAgent:wk.userAgent,visibility:wk.visibility}));
  for(const {replies,...summary} of wk.results)console.log(JSON.stringify(summary));
} finally { server.stop(true); }
