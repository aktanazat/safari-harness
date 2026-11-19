import { writeFileSync } from 'node:fs';
const fixture=`<!doctype html><title>Settlement proof</title><input id="field"><select id="choice"><option>A</option><option>B</option></select><button id="idle">Idle</button><p id="out">Before</p><script>
window.proofs=[];
function later(source){
  const started=performance.now();
  setTimeout(source,200);
  requestAnimationFrame(()=>setTimeout(()=>{
    let receipt;
    const take=e=>receipt=JSON.parse(e.detail);
    document.addEventListener('__sh_receipt_answer',take);
    document.dispatchEvent(new CustomEvent('__sh_receipt_ask',{detail:JSON.stringify({since:0})}));
    document.removeEventListener('__sh_receipt_answer',take);
    proofs.push({afterRenderingMs:performance.now()-started,field:field.value,choice:choice.value,text:out.textContent,receipt});
  },50));
}
field.oninput=()=>later("field.value='rewritten'");
choice.oninput=()=>later("choice.value='A'");
idle.onclick=()=>later("out.textContent='After'");
</script>`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(fixture,{headers:{'Content-Type':'text/html'}})});
try {
  const requests=[{load:`http://127.0.0.1:${server.port}/`},
    {op:'type',args:['#field','sample']},{pageEval:'({proof:window.proofs.at(-1),field:document.querySelector("#field").value})'},
    {op:'select',args:['#choice','B']},{pageEval:'({proof:window.proofs.at(-1),choice:document.querySelector("#choice").value})'},
    {op:'select',args:['#choice','A']},{pageEval:'({proof:window.proofs.at(-1),choice:document.querySelector("#choice").value})'},
    {op:'click',args:['#idle']},{pageEval:'({proof:window.proofs.at(-1),text:document.querySelector("#out").textContent})'},
  ];
  const p=Bun.spawn(['/Users/devin/repos/safari-harness/.build/bench-afc1bf9c73a75991','/Users/devin/repos/safari-harness/extension'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  p.stdin.write(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');p.stdin.end();
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  writeFileSync('/Users/devin/bench-waits/settlement-proof.jsonl',out);
  console.log(out);if(code)throw Error(err);
}finally{server.stop(true);}
