/* ISC Job Flow - the whole job as one free-form dependency graph.  (console-paste prototype)
 *
 * WHY: Fulcrum's Operations section degrades badly on a big job - 2608-1028-42 is 114 subassemblies
 * and 205 operations - and it never shows how they feed each other.
 *
 * THE DATA (proven on 2608-1028-42, 2026-10-30):
 *   GET /api/Jobs/{id}  ->  11.2 MB, ~2.9 s. One call, same-origin, session cookie.
 *   itemsToMake[].operations[] carry previousOperationIds / nextOperationIds.
 *   349 edges, ALL 349 resolve to operations inside the same job - the graph is self-contained.
 *   One connected component over all 205 ops; 257 of 349 edges cross subassembly boundaries;
 *   longest chain is 12 deep.
 * 11 MB is why this sits behind a button and never loads with the page.
 *
 * LAYOUT: force-directed, not columns. A strict column grid was the first attempt and it produced
 * a hairball - 257 cross-subassembly edges all crossing the same gutters. Here nodes repel each
 * other, edges act as springs, and a weak x-anchor pulls each node toward its dependency depth so
 * the thing still reads left-to-right without being imprisoned in a grid. Drag any node to tidy by
 * hand; the sim re-settles around it.
 *
 * `order` on an operation is a SPARSE sort key - a gap is not a completed step. Edges are the only
 * real sequence.
 *
 * Read-only. One GET, no writes.
 */
(() => {
  const OLD = document.getElementById('iscflow');
  if (OLD) OLD.remove();

  const C = {
    page:'#0c0d12', panel:'#191a1f', card:'#27292e', line:'#2e3138',
    text:'#e6e6f0', dim:'#8a8f9c', orange:'#F58220',
    Pending:'#5b6579', Ready:'#3987e5', Paused:'#b8862f',
    Complete:'#199e70', Cancelled:'#6a3b3b', Running:'#199e70'
  };
  const NW=176, NH=42;

  const root=document.createElement('div');
  root.id='iscflow';
  root.style.cssText='position:fixed;inset:0;z-index:2147483600;background:'+C.page+';color:'+C.text+
    ';font:14px Inter,system-ui,sans-serif;display:flex;flex-direction:column;';
  document.body.appendChild(root);

  const bar=document.createElement('div');
  bar.style.cssText='flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px;'+
    'background:'+C.panel+';border-bottom:1px solid '+C.line+';flex-wrap:wrap;font-size:12px';
  const btn='background:'+C.card+';color:'+C.text+';border:1px solid '+C.line+
    ';border-radius:6px;padding:5px 10px;cursor:pointer;font:600 12px Inter';
  bar.innerHTML='<span style="background:'+C.orange+';color:#1a1206;font-weight:700;font-size:11px;'+
    'padding:3px 7px;border-radius:5px">ISC</span><strong>Job Flow</strong>'+
    '<span class="sub" style="color:'+C.dim+'"></span><span style="flex:1"></span>'+
    '<label style="color:'+C.dim+'"><input type="checkbox" class="hideDone"> hide complete/cancelled</label>'+
    '<label style="color:'+C.dim+'">spread <input type="range" class="spread" min="60" max="400" value="170" style="vertical-align:middle;width:110px"></label>'+
    '<button class="relax" style="'+btn+'">Re-settle</button>'+
    '<button class="fit" style="'+btn+'">Fit</button>'+
    '<button class="x" style="'+btn+'">Close</button>';
  root.appendChild(bar);
  bar.querySelector('.x').onclick=()=>root.remove();

  const body=document.createElement('div');
  body.style.cssText='flex:1;overflow:hidden;position:relative;cursor:grab';
  body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Loading the job from Fulcrum (one call, ~11 MB)...</div>';
  root.appendChild(body);

  const jobId=(location.pathname.match(/\/ui\/jobs\/([0-9a-f]{24})/)||[])[1];
  if(!jobId){ body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Open a job first.</div>'; return; }
  const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  (async () => {
    let j;
    try { j=await (await fetch('/api/Jobs/'+jobId,{credentials:'same-origin'})).json(); }
    catch(e){ body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Failed to load: '+esc(e.message)+'</div>'; return; }

    const nodes=[], byId=new Map();
    for(const it of (j.itemsToMake||[])){
      const item=(it.itemReference&&(it.itemReference.number||it.itemReference.name))||'?';
      for(const o of (it.operations||[])){
        const n={ id:o.id, item, op:(o.operation&&o.operation.name)||'?', status:o.status,
          eq:(o.scheduledEquipment&&o.scheduledEquipment.name)||null,
          hrs:+(((o.estimatedDurationTimeInSeconds||o.estimatedRunTimeInSeconds||0)/3600).toFixed(1)),
          prev:(o.previousOperationIds||[]).slice(), next:(o.nextOperationIds||[]).slice(),
          itemToMakeId:it.id, x:0,y:0,vx:0,vy:0,fixed:false };
        nodes.push(n); byId.set(n.id,n);
      }
    }
    nodes.forEach(n=>{ n.prev=n.prev.filter(p=>byId.has(p)); n.next=n.next.filter(x=>byId.has(x)); });

    // dependency depth drives the weak x-anchor, so flow still reads left to right
    const memo=new Map(), guard=new Set();
    const depth=id=>{
      if(memo.has(id)) return memo.get(id);
      if(guard.has(id)) return 0;                 // cycles should not exist; do not hang if they do
      guard.add(id);
      const n=byId.get(id);
      const d=n.prev.length?1+Math.max(...n.prev.map(depth)):0;
      guard.delete(id); memo.set(id,d); return d;
    };
    nodes.forEach(n=>n.depth=depth(n.id));
    const maxDepth=Math.max(...nodes.map(n=>n.depth));

    let view={x:0,y:0,k:1}, live=nodes, edges=[], svg=null, running=0;
    const SP=()=>+bar.querySelector('.spread').value;

    function seed(){
      const colH=Math.max(1,Math.ceil(live.length/(maxDepth+1)));
      const byDepth=new Map();
      live.forEach(n=>{ const a=byDepth.get(n.depth)||[]; a.push(n); byDepth.set(n.depth,a); });
      byDepth.forEach(arr=>arr.forEach((n,i)=>{
        n.ax=n.depth*SP()*2.2;                      // anchor
        n.x=n.ax+(Math.random()-0.5)*40;
        n.y=(i-arr.length/2)*(NH+26)+(Math.random()-0.5)*40;
        n.vx=n.vy=0;
      }));
    }

    function tick(){
      const S=SP(), rep=S*S*0.9;
      for(let i=0;i<live.length;i++){
        const a=live[i];
        for(let k=i+1;k<live.length;k++){
          const b=live[k];
          let dx=a.x-b.x, dy=a.y-b.y;
          let d2=dx*dx+dy*dy; if(d2<1) { d2=1; dx=Math.random()-0.5; dy=Math.random()-0.5; }
          if(d2>rep*9) continue;                    // ignore distant pairs - keeps 205 nodes cheap
          const f=rep/d2, d=Math.sqrt(d2);
          const ux=dx/d*f, uy=dy/d*f;
          a.vx+=ux; a.vy+=uy; b.vx-=ux; b.vy-=uy;
        }
      }
      for(const e of edges){
        const a=e.a,b=e.b;
        const dx=b.x-a.x, dy=b.y-a.y, d=Math.sqrt(dx*dx+dy*dy)||1;
        const want=S*1.6, f=(d-want)*0.012;
        const ux=dx/d*f, uy=dy/d*f;
        a.vx+=ux; a.vy+=uy; b.vx-=ux; b.vy-=uy;
      }
      for(const n of live){
        n.vx+=(n.ax-n.x)*0.012;                     // weak pull to its depth column
        n.vy*=0.86; n.vx*=0.86;
        if(!n.fixed){ n.x+=Math.max(-28,Math.min(28,n.vx)); n.y+=Math.max(-28,Math.min(28,n.vy)); }
      }
    }

    function build(){
      const hide=bar.querySelector('.hideDone').checked;
      live=nodes.filter(n=>!hide||!/Complete|Cancelled/.test(n.status));
      const ok=new Set(live.map(n=>n.id));
      edges=[];
      for(const n of live) for(const p of n.prev) if(ok.has(p)) edges.push({a:byId.get(p),b:n});
      seed();
      bar.querySelector('.sub').textContent=j.name+' - '+live.length+' operations, '+edges.length+
        ' links, '+new Set(live.map(n=>n.item)).size+' subassemblies';
      relax(420);
    }

    function relax(n){ running=n; if(running) requestAnimationFrame(step); }
    function step(){
      for(let i=0;i<3 && running>0;i++,running--) tick();
      draw();
      if(running>0) requestAnimationFrame(step);
    }

    function draw(){
      if(!svg){
        body.innerHTML='<svg style="width:100%;height:100%;display:block"><g class="vp"></g></svg>';
        svg=body.querySelector('svg');
        wire();
      }
      const vp=svg.querySelector('.vp');
      let e='';
      for(const ed of edges){
        const x1=ed.a.x+NW/2, y1=ed.a.y, x2=ed.b.x-NW/2, y2=ed.b.y, mx=(x1+x2)/2;
        e+='<path d="M'+f(x1)+' '+f(y1)+' C'+f(mx)+' '+f(y1)+' '+f(mx)+' '+f(y2)+' '+f(x2)+' '+f(y2)+
           '" fill="none" stroke="#39404e" stroke-width="1.2"/>';
      }
      let b='';
      for(const n of live){
        const col=C[n.status]||C.Pending;
        const x=n.x-NW/2, y=n.y-NH/2;
        b+='<g class="n" data-id="'+n.id+'">'+
          '<rect x="'+f(x)+'" y="'+f(y)+'" width="'+NW+'" height="'+NH+'" rx="6" fill="'+C.card+
            '" stroke="'+col+'" stroke-width="1.5"/>'+
          '<rect x="'+f(x)+'" y="'+f(y)+'" width="4" height="'+NH+'" rx="2" fill="'+col+'"/>'+
          '<text x="'+f(x+11)+'" y="'+f(y+17)+'" fill="'+C.text+'" font-size="11" font-weight="600">'+
            esc(n.item).slice(0,24)+'</text>'+
          '<text x="'+f(x+11)+'" y="'+f(y+32)+'" fill="'+C.dim+'" font-size="10">'+
            esc(n.op).slice(0,22)+(n.hrs?'  '+n.hrs+'h':'')+'</text>'+
          '<title>'+esc(n.item)+'\n'+esc(n.op)+'\n'+n.status+(n.eq?'\n'+esc(n.eq):'')+
            (n.hrs?'\n'+n.hrs+' h':'')+'\nclick to open in Job Tracking</title></g>';
      }
      vp.innerHTML=e+b;
      vp.setAttribute('transform','translate('+f(view.x)+','+f(view.y)+') scale('+view.k.toFixed(3)+')');
    }
    const f=v=>Math.round(v*10)/10;

    function fit(){
      if(!live.length) return;
      const xs=live.map(n=>n.x), ys=live.map(n=>n.y);
      const x0=Math.min(...xs)-NW, x1=Math.max(...xs)+NW, y0=Math.min(...ys)-NH, y1=Math.max(...ys)+NH;
      const r=body.getBoundingClientRect();
      view.k=Math.min(r.width/(x1-x0), r.height/(y1-y0), 1.4);
      view.x=-x0*view.k+(r.width-(x1-x0)*view.k)/2;
      view.y=-y0*view.k+(r.height-(y1-y0)*view.k)/2;
      draw();
    }

    function wire(){
      let pan=null, drag=null;
      body.onmousedown=ev=>{
        const g=ev.target.closest&&ev.target.closest('g.n');
        if(g){ const n=byId.get(g.dataset.id); drag={n,moved:false}; n.fixed=true; }
        else { pan={x:ev.clientX-view.x,y:ev.clientY-view.y}; body.style.cursor='grabbing'; }
      };
      window.addEventListener('mousemove',ev=>{
        if(drag){ drag.moved=true;
          drag.n.x=(ev.clientX-view.x)/view.k; drag.n.y=(ev.clientY-view.y)/view.k;
          relax(90);
        } else if(pan){ view.x=ev.clientX-pan.x; view.y=ev.clientY-pan.y; draw(); }
      });
      window.addEventListener('mouseup',ev=>{
        if(drag){
          if(!drag.moved){
            window.open('/jobtracking/#/operation?type=Job&jobId='+jobId+'&selectedOperationId='+
              drag.n.id+'&selectedItemToMakeId='+drag.n.itemToMakeId,'_blank');
          }
          drag.n.fixed=false; drag=null;
        }
        pan=null; body.style.cursor='grab';
      });
      body.addEventListener('wheel',ev=>{
        ev.preventDefault();
        const r=body.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
        const k=Math.max(0.12,Math.min(3,view.k*(ev.deltaY<0?1.12:1/1.12)));
        view.x=mx-(mx-view.x)*(k/view.k); view.y=my-(my-view.y)*(k/view.k); view.k=k;
        draw();
      },{passive:false});
    }

    bar.querySelector('.hideDone').onchange=()=>{ build(); setTimeout(fit,900); };
    bar.querySelector('.spread').onchange=()=>{ seed(); relax(420); setTimeout(fit,900); };
    bar.querySelector('.relax').onclick=()=>relax(420);
    bar.querySelector('.fit').onclick=fit;

    build();
    setTimeout(fit,1000);
    window.__flow={nodes,byId,live:()=>live,edges:()=>edges,fit,relax};
  })();
})();
