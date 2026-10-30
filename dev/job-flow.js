/* ISC Job Flow - the whole job as one graph, grouped by part number.  (console-paste prototype)
 *
 * WHY: Fulcrum's Operations section degrades badly on a big job - 2608-1028-42 is 114 part numbers
 * and 205 operations - and it never shows how they feed each other.
 *
 * THE DATA (proven on 2608-1028-42, 2026-10-30):
 *   GET /api/Jobs/{id}  ->  11.2 MB, ~2.9 s. One call, same-origin, session cookie.
 *   itemsToMake[].operations[] carry previousOperationIds / nextOperationIds.
 *   349 edges, ALL 349 resolve inside the same job. One connected component over all 205 ops.
 *   257 of 349 edges cross part boundaries; longest chain 12 deep; ~1.8 operations per part.
 * 11 MB is why this sits behind a button and never loads with the page.
 *
 * LAYOUT - two levels, and the order of attempts matters:
 *   1. Strict dependency columns  -> hairball. 257 cross-part edges all crossing the same gutters.
 *   2. Flat force-directed on 205 operations -> spread out, but parts scattered; you could not
 *      see a part number as a thing.
 *   3. THIS: one BOX per part number holding its own operations, and the force sim runs on the
 *      boxes. Within-part sequence is implicit (stacked in dependency order) so the only lines
 *      drawn are the ones that cross parts - which is the thing worth looking at.
 *
 * Repulsion is size-aware (bigger boxes push harder) or large parts overlap their neighbours.
 * A weak x-anchor by dependency depth keeps the whole thing reading left to right.
 *
 * `order` on an operation is a SPARSE sort key - a gap is not a completed step. Edges are the only
 * real sequence.
 *
 * Read-only. One GET, no writes.
 */
(() => {
  const OLD=document.getElementById('iscflow'); if(OLD) OLD.remove();

  const C={ page:'#0c0d12', panel:'#191a1f', card:'#22242a', box:'#15171c', line:'#2e3138',
    text:'#e6e6f0', dim:'#8a8f9c', orange:'#F58220',
    Pending:'#5b6579', Ready:'#3987e5', Paused:'#b8862f', Complete:'#199e70',
    Cancelled:'#6a3b3b', Running:'#199e70' };
  const GW=182, HEAD=19, OPH=25, PADB=7;

  const root=document.createElement('div'); root.id='iscflow';
  root.style.cssText='position:fixed;inset:0;z-index:2147483600;background:'+C.page+';color:'+C.text+
    ';font:14px Inter,system-ui,sans-serif;display:flex;flex-direction:column';
  document.body.appendChild(root);

  const btn='background:'+C.card+';color:'+C.text+';border:1px solid '+C.line+
    ';border-radius:6px;padding:5px 10px;cursor:pointer;font:600 12px Inter';
  const bar=document.createElement('div');
  bar.style.cssText='flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px;'+
    'background:'+C.panel+';border-bottom:1px solid '+C.line+';flex-wrap:wrap;font-size:12px';
  bar.innerHTML='<span style="background:'+C.orange+';color:#1a1206;font-weight:700;font-size:11px;'+
    'padding:3px 7px;border-radius:5px">ISC</span><strong>Job Flow</strong>'+
    '<span class="sub" style="color:'+C.dim+'"></span><span style="flex:1"></span>'+
    '<label style="color:'+C.dim+'"><input type="checkbox" class="hideDone"> hide complete/cancelled</label>'+
    '<label style="color:'+C.dim+'">spread <input type="range" class="spread" min="80" max="600" value="260" style="vertical-align:middle;width:120px"></label>'+
    '<button class="relax" style="'+btn+'">Re-settle</button><button class="fit" style="'+btn+'">Fit</button>'+
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
  const f=v=>Math.round(v*10)/10;

  (async () => {
    let j;
    try { j=await (await fetch('/api/Jobs/'+jobId,{credentials:'same-origin'})).json(); }
    catch(e){ body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Failed to load: '+esc(e.message)+'</div>'; return; }

    const ops=[], byId=new Map();
    for(const it of (j.itemsToMake||[])){
      const item=(it.itemReference&&(it.itemReference.number||it.itemReference.name))||'?';
      for(const o of (it.operations||[])){
        const n={ id:o.id, item, op:(o.operation&&o.operation.name)||'?', status:o.status,
          eq:(o.scheduledEquipment&&o.scheduledEquipment.name)||null,
          hrs:+(((o.estimatedDurationTimeInSeconds||o.estimatedRunTimeInSeconds||0)/3600).toFixed(1)),
          prev:(o.previousOperationIds||[]).slice(), next:(o.nextOperationIds||[]).slice(),
          itemToMakeId:it.id };
        ops.push(n); byId.set(n.id,n);
      }
    }
    ops.forEach(n=>{ n.prev=n.prev.filter(p=>byId.has(p)); });

    const memo=new Map(), guard=new Set();
    const depth=id=>{ if(memo.has(id)) return memo.get(id);
      if(guard.has(id)) return 0;                  // cycles should not exist; do not hang if they do
      guard.add(id); const n=byId.get(id);
      const d=n.prev.length?1+Math.max(...n.prev.map(depth)):0;
      guard.delete(id); memo.set(id,d); return d; };
    ops.forEach(n=>n.depth=depth(n.id));

    let groups=[], gByItem=new Map(), gEdges=[], opEdges=[], svg=null, running=0;
    let view={x:0,y:0,k:1};
    const SP=()=>+bar.querySelector('.spread').value;

    function build(){
      const hide=bar.querySelector('.hideDone').checked;
      const live=ops.filter(n=>!hide||!/Complete|Cancelled/.test(n.status));
      const ok=new Set(live.map(n=>n.id));

      gByItem=new Map();
      for(const n of live){
        let g=gByItem.get(n.item);
        if(!g){ g={item:n.item, ops:[], x:0,y:0,vx:0,vy:0,fixed:false}; gByItem.set(n.item,g); }
        g.ops.push(n);
      }
      groups=[...gByItem.values()];
      groups.forEach(g=>{
        g.ops.sort((a,b)=>a.depth-b.depth);
        g.depth=Math.min(...g.ops.map(o=>o.depth));
        g.h=HEAD+g.ops.length*OPH+PADB;
        g.r=Math.sqrt(GW*GW+g.h*g.h)/2;
        g.ops.forEach(o=>o.g=g);
      });

      // only cross-part links are drawn: within-part sequence is already implied by the stack
      opEdges=[]; const agg=new Map();
      for(const n of live) for(const p of n.prev){
        if(!ok.has(p)) continue;
        const a=byId.get(p); if(a.item===n.item) continue;
        opEdges.push({a,b:n});
        const key=a.item+'\u0000'+n.item;
        agg.set(key,(agg.get(key)||0)+1);
      }
      gEdges=[...agg.entries()].map(([k,w])=>{
        const [ai,bi]=k.split('\u0000');
        return {a:gByItem.get(ai), b:gByItem.get(bi), w};
      }).filter(e=>e.a&&e.b);

      const maxD=Math.max(...groups.map(g=>g.depth));
      const byD=new Map();
      groups.forEach(g=>{ const a=byD.get(g.depth)||[]; a.push(g); byD.set(g.depth,a); });
      byD.forEach(arr=>arr.forEach((g,i)=>{
        g.ax=g.depth*SP()*1.9;
        g.x=g.ax+(Math.random()-0.5)*60;
        g.y=(i-arr.length/2)*(g.h+40)+(Math.random()-0.5)*60;
        g.vx=g.vy=0;
      }));

      bar.querySelector('.sub').textContent=j.name+' - '+groups.length+' part numbers, '+
        live.length+' operations, '+opEdges.length+' cross-part links';
      relax(520);
    }

    function tick(){
      const S=SP();
      for(let i=0;i<groups.length;i++){
        const a=groups[i];
        for(let k=i+1;k<groups.length;k++){
          const b=groups[k];
          let dx=a.x-b.x, dy=a.y-b.y;
          let d2=dx*dx+dy*dy; if(d2<1){ d2=1; dx=Math.random()-0.5; dy=Math.random()-0.5; }
          const want=(a.r+b.r)*1.25+S*0.45;        // size-aware: big boxes push harder
          if(d2>want*want*4) continue;
          const d=Math.sqrt(d2), f=(want*want)/d2*2.2;
          a.vx+=dx/d*f; a.vy+=dy/d*f; b.vx-=dx/d*f; b.vy-=dy/d*f;
        }
      }
      for(const e of gEdges){
        const a=e.a,b=e.b, dx=b.x-a.x, dy=b.y-a.y, d=Math.sqrt(dx*dx+dy*dy)||1;
        const want=S*1.5, fo=(d-want)*0.014*Math.min(3,e.w);
        a.vx+=dx/d*fo; a.vy+=dy/d*fo; b.vx-=dx/d*fo; b.vy-=dy/d*fo;
      }
      for(const g of groups){
        g.vx+=(g.ax-g.x)*0.014;                    // weak left-to-right anchor by depth
        g.vx*=0.85; g.vy*=0.85;
        if(!g.fixed){ g.x+=Math.max(-34,Math.min(34,g.vx)); g.y+=Math.max(-34,Math.min(34,g.vy)); }
      }
    }
    function relax(n){ running=n; requestAnimationFrame(step); }
    function step(){ for(let i=0;i<3&&running>0;i++,running--) tick(); draw(); if(running>0) requestAnimationFrame(step); }

    const opPos=o=>{ const g=o.g, i=g.ops.indexOf(o);
      return { x:g.x, y:g.y-g.h/2+HEAD+i*OPH+OPH/2, left:g.x-GW/2, right:g.x+GW/2 }; };

    function draw(){
      if(!svg){ body.innerHTML='<svg style="width:100%;height:100%;display:block"><g class="vp"></g></svg>';
        svg=body.querySelector('svg'); wire(); }
      let e='';
      for(const ed of opEdges){
        const A=opPos(ed.a), B=opPos(ed.b);
        const x1=A.right, y1=A.y, x2=B.left, y2=B.y, mx=(x1+x2)/2;
        e+='<path d="M'+f(x1)+' '+f(y1)+' C'+f(mx)+' '+f(y1)+' '+f(mx)+' '+f(y2)+' '+f(x2)+' '+f(y2)+
           '" fill="none" stroke="#3f4756" stroke-width="1.25"/>';
      }
      let b='';
      for(const g of groups){
        const x=g.x-GW/2, y=g.y-g.h/2;
        b+='<g class="g" data-item="'+esc(g.item)+'">'+
          '<rect x="'+f(x)+'" y="'+f(y)+'" width="'+GW+'" height="'+f(g.h)+'" rx="7" fill="'+C.box+
            '" stroke="'+C.line+'" stroke-width="1.2"/>'+
          '<text x="'+f(x+9)+'" y="'+f(y+13.5)+'" fill="'+C.text+'" font-size="10.5" font-weight="700">'+
            esc(g.item).slice(0,26)+'</text>';
        g.ops.forEach((o,i)=>{
          const oy=y+HEAD+i*OPH, col=C[o.status]||C.Pending;
          b+='<g class="n" data-id="'+o.id+'">'+
            '<rect x="'+f(x+5)+'" y="'+f(oy+2)+'" width="'+(GW-10)+'" height="'+(OPH-4)+'" rx="4" fill="'+
              C.card+'" stroke="'+col+'" stroke-width="1.3"/>'+
            '<rect x="'+f(x+5)+'" y="'+f(oy+2)+'" width="3.5" height="'+(OPH-4)+'" rx="1.8" fill="'+col+'"/>'+
            '<text x="'+f(x+14)+'" y="'+f(oy+15)+'" fill="'+C.text+'" font-size="10">'+
              esc(o.op).slice(0,20)+(o.hrs?'  '+o.hrs+'h':'')+'</text>'+
            '<title>'+esc(o.item)+'\n'+esc(o.op)+'\n'+o.status+(o.eq?'\n'+esc(o.eq):'')+
              (o.hrs?'\n'+o.hrs+' h':'')+'\nclick to open in Job Tracking</title></g>';
        });
        b+='</g>';
      }
      const vp=svg.querySelector('.vp');
      vp.innerHTML=e+b;
      vp.setAttribute('transform','translate('+f(view.x)+','+f(view.y)+') scale('+view.k.toFixed(3)+')');
    }

    function fit(){
      if(!groups.length) return;
      const x0=Math.min(...groups.map(g=>g.x-GW/2))-40, x1=Math.max(...groups.map(g=>g.x+GW/2))+40;
      const y0=Math.min(...groups.map(g=>g.y-g.h/2))-40, y1=Math.max(...groups.map(g=>g.y+g.h/2))+40;
      const r=body.getBoundingClientRect();
      view.k=Math.min(r.width/(x1-x0), r.height/(y1-y0), 1.4);
      view.x=-x0*view.k+(r.width-(x1-x0)*view.k)/2;
      view.y=-y0*view.k+(r.height-(y1-y0)*view.k)/2;
      draw();
    }

    function wire(){
      let pan=null, drag=null;
      body.onmousedown=ev=>{
        const gEl=ev.target.closest&&ev.target.closest('g.g');
        if(gEl){ const g=gByItem.get(gEl.dataset.item);
          const nEl=ev.target.closest('g.n');
          drag={g, node:nEl?byId.get(nEl.dataset.id):null, moved:false}; if(g) g.fixed=true; }
        else { pan={x:ev.clientX-view.x,y:ev.clientY-view.y}; body.style.cursor='grabbing'; }
      };
      window.addEventListener('mousemove',ev=>{
        if(drag&&drag.g){ drag.moved=true;
          drag.g.x=(ev.clientX-view.x)/view.k; drag.g.y=(ev.clientY-view.y)/view.k; relax(110); }
        else if(pan){ view.x=ev.clientX-pan.x; view.y=ev.clientY-pan.y; draw(); }
      });
      window.addEventListener('mouseup',()=>{
        if(drag){
          if(!drag.moved&&drag.node){
            window.open('/jobtracking/#/operation?type=Job&jobId='+jobId+'&selectedOperationId='+
              drag.node.id+'&selectedItemToMakeId='+drag.node.itemToMakeId,'_blank');
          }
          if(drag.g) drag.g.fixed=false; drag=null;
        }
        pan=null; body.style.cursor='grab';
      });
      body.addEventListener('wheel',ev=>{
        ev.preventDefault();
        const r=body.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
        const k=Math.max(0.08,Math.min(3,view.k*(ev.deltaY<0?1.12:1/1.12)));
        view.x=mx-(mx-view.x)*(k/view.k); view.y=my-(my-view.y)*(k/view.k); view.k=k; draw();
      },{passive:false});
    }

    bar.querySelector('.hideDone').onchange=()=>{ build(); setTimeout(fit,1100); };
    bar.querySelector('.spread').onchange=()=>{ build(); setTimeout(fit,1100); };
    bar.querySelector('.relax').onclick=()=>relax(520);
    bar.querySelector('.fit').onclick=fit;

    build(); setTimeout(fit,1200);
    window.__flow={ops,groups:()=>groups,gEdges:()=>gEdges,opEdges:()=>opEdges,fit,relax};
  })();
})();
