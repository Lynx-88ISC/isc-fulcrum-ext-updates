/* ISC Job Flow - the whole job as one dependency flow chart.  (console-paste prototype)
 *
 * WHY: Fulcrum's Operations section degrades badly on a big job - 2608-1028-42 is 114 subassemblies
 * and 205 operations - and it never shows how they feed each other.
 *
 * THE DATA (proven on 2608-1028-42, 2026-10-30):
 *   GET /api/Jobs/{id}  ->  11.2 MB, ~2.9 s. One call, same-origin, session cookie.
 *   itemsToMake[].operations[] carry previousOperationIds / nextOperationIds.
 *   349 edges, ALL 349 resolve to operations inside the same job - the graph is self-contained.
 *   One connected component covering all 205 ops; 257 of 349 edges cross subassembly boundaries;
 *   longest chain is 12 deep. So it really is a single flow chart, not 114 separate chains.
 *
 * 11 MB is why this is on a BUTTON and not something that loads with the page.
 *
 * Layering is longest-path: an operation sits one column right of its deepest predecessor, which
 * keeps every arrow pointing forward. Within a column, nodes are ordered by the average position
 * of their predecessors (one barycentre pass) to cut crossings - not a full Sugiyama, but enough.
 *
 * `order` on an operation is a SPARSE sort key - a gap is not a completed step, so never infer
 * sequence from it. The edges are the only real sequence.
 *
 * Read-only. Issues one GET and writes nothing.
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
  const NW=190, NH=46, GAPX=70, GAPY=14, PADX=40, PADY=60;

  const root=document.createElement('div');
  root.id='iscflow';
  root.style.cssText='position:fixed;inset:0;z-index:2147483600;background:'+C.page+';color:'+C.text+
    ';font:14px Inter,system-ui,sans-serif;display:flex;flex-direction:column;';
  document.body.appendChild(root);

  const bar=document.createElement('div');
  bar.style.cssText='flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:10px 14px;'+
    'background:'+C.panel+';border-bottom:1px solid '+C.line+';flex-wrap:wrap';
  bar.innerHTML='<span style="background:'+C.orange+';color:#1a1206;font-weight:700;font-size:11px;'+
    'padding:3px 7px;border-radius:5px">ISC</span><strong>Job Flow</strong>'+
    '<span class="sub" style="color:'+C.dim+';font-size:12.5px"></span>'+
    '<span style="flex:1"></span>'+
    '<label style="font-size:12px;color:'+C.dim+'"><input type="checkbox" class="hideDone"> hide complete/cancelled</label>'+
    '<button class="x" style="background:'+C.card+';color:'+C.text+';border:1px solid '+C.line+
    ';border-radius:6px;padding:6px 12px;cursor:pointer;font:600 12px Inter">Close</button>';
  root.appendChild(bar);
  bar.querySelector('.x').onclick=()=>root.remove();

  const body=document.createElement('div');
  body.style.cssText='flex:1;overflow:auto;position:relative';
  body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Loading the job from Fulcrum (one call, ~11 MB)...</div>';
  root.appendChild(body);

  const jobId = (location.pathname.match(/\/ui\/jobs\/([0-9a-f]{24})/)||[])[1];
  if (!jobId) { body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Open a job first - this reads the job in the address bar.</div>'; return; }

  (async () => {
    let j;
    try { j = await (await fetch('/api/Jobs/'+jobId,{credentials:'same-origin'})).json(); }
    catch(e){ body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Failed to load: '+e.message+'</div>'; return; }

    const nodes=[], byId=new Map();
    for (const it of (j.itemsToMake||[])) {
      const item=(it.itemReference&&(it.itemReference.number||it.itemReference.name))||'?';
      for (const o of (it.operations||[])) {
        const n={ id:o.id, item, op:(o.operation&&o.operation.name)||'?', status:o.status,
          eq:(o.scheduledEquipment&&o.scheduledEquipment.name)||null,
          hrs:+(((o.estimatedDurationTimeInSeconds||o.estimatedRunTimeInSeconds||0)/3600).toFixed(1)),
          prev:(o.previousOperationIds||[]).slice(), next:(o.nextOperationIds||[]).slice(),
          itemToMakeId:it.id, start:o.scheduledStartUtc };
        nodes.push(n); byId.set(n.id,n);
      }
    }
    // drop edges pointing outside this job rather than letting them break the layering
    nodes.forEach(n=>{ n.prev=n.prev.filter(p=>byId.has(p)); n.next=n.next.filter(x=>byId.has(x)); });

    function layout(list){
      const live=new Set(list.map(n=>n.id));
      const memo=new Map(), guard=new Set();
      const depth=id=>{
        if(memo.has(id)) return memo.get(id);
        if(guard.has(id)) return 0;             // cycles should not exist; refuse to hang if they do
        guard.add(id);
        const n=byId.get(id);
        const ps=n.prev.filter(p=>live.has(p));
        const d=ps.length?1+Math.max(...ps.map(depth)):0;
        guard.delete(id); memo.set(id,d); return d;
      };
      list.forEach(n=>n.col=depth(n.id));
      const cols=[];
      list.forEach(n=>{ (cols[n.col]=cols[n.col]||[]).push(n); });
      // barycentre: order each column by the mean row of its predecessors
      cols.forEach((col,ci)=>{
        if(ci===0){ col.sort((a,b)=> a.item<b.item?-1:a.item>b.item?1:0); }
        else {
          col.forEach(n=>{
            const ps=n.prev.filter(p=>live.has(p)).map(p=>byId.get(p).row).filter(r=>r!=null);
            n.bary = ps.length ? ps.reduce((s,v)=>s+v,0)/ps.length : 1e6;
          });
          col.sort((a,b)=> (a.bary-b.bary) || (a.item<b.item?-1:1));
        }
        col.forEach((n,i)=>{ n.row=i; n.x=PADX+n.col*(NW+GAPX); n.y=PADY+i*(NH+GAPY); });
      });
      return cols;
    }

    function render(){
      const hide=bar.querySelector('.hideDone').checked;
      const list=nodes.filter(n=>!hide || !/Complete|Cancelled/.test(n.status));
      const live=new Set(list.map(n=>n.id));
      const cols=layout(list);
      const w=PADX*2+(cols.length)*(NW+GAPX);
      const h=PADY*2+Math.max(...cols.map(c=>c.length))*(NH+GAPY);

      let edges='';
      for(const n of list) for(const p of n.prev){
        if(!live.has(p)) continue;
        const a=byId.get(p);
        const x1=a.x+NW, y1=a.y+NH/2, x2=n.x, y2=n.y+NH/2, mx=(x1+x2)/2;
        edges+='<path d="M'+x1+' '+y1+' C'+mx+' '+y1+' '+mx+' '+y2+' '+x2+' '+y2+
          '" fill="none" stroke="#3c4250" stroke-width="1.3"/>';
      }
      let boxes='';
      for(const n of list){
        const col=C[n.status]||C.Pending;
        boxes+='<g class="n" data-id="'+n.id+'" style="cursor:pointer">'+
          '<rect x="'+n.x+'" y="'+n.y+'" width="'+NW+'" height="'+NH+'" rx="6" fill="'+C.card+
          '" stroke="'+col+'" stroke-width="1.6"/>'+
          '<rect x="'+n.x+'" y="'+n.y+'" width="4" height="'+NH+'" rx="2" fill="'+col+'"/>'+
          '<text x="'+(n.x+12)+'" y="'+(n.y+18)+'" fill="'+C.text+'" font-size="11.5" font-weight="600">'+
            esc(n.item).slice(0,26)+'</text>'+
          '<text x="'+(n.x+12)+'" y="'+(n.y+34)+'" fill="'+C.dim+'" font-size="10.5">'+
            esc(n.op).slice(0,24)+(n.hrs?'  '+n.hrs+'h':'')+'</text>'+
          '<title>'+esc(n.item)+'\n'+esc(n.op)+'\n'+n.status+(n.eq?'\n'+esc(n.eq):'')+
            (n.hrs?'\n'+n.hrs+' h':'')+'\nclick to open in Job Tracking</title></g>';
      }
      body.innerHTML='<svg width="'+w+'" height="'+h+'" style="display:block">'+edges+boxes+'</svg>';
      bar.querySelector('.sub').textContent=
        j.name+' - '+list.length+' operations, '+cols.length+' stages, '+
        new Set(list.map(n=>n.item)).size+' subassemblies';
      body.onclick=ev=>{
        const g=ev.target.closest&&ev.target.closest('.n'); if(!g) return;
        const n=byId.get(g.dataset.id); if(!n) return;
        window.open('/jobtracking/#/operation?type=Job&jobId='+jobId+
          '&selectedOperationId='+n.id+'&selectedItemToMakeId='+n.itemToMakeId,'_blank');
      };
    }
    function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

    bar.querySelector('.hideDone').onchange=render;
    render();
    window.__flow={nodes, byId, render};
  })();
})();
