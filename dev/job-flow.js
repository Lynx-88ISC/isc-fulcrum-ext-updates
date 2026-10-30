/* ISC Job Flow - the whole job as one graph, columns by BOM level.  (console-paste prototype)
 *
 * WHY: Fulcrum's Operations section degrades badly on a big job - 2608-1028-42 is 114 part numbers
 * and 205 operations - and it never shows how they feed each other.
 *
 * THE DATA (proven on 2608-1028-42, 2026-10-30):
 *   GET /api/Jobs/{id}  ->  11.2 MB, ~2.9 s. One call, same-origin, session cookie.
 *   itemsToMake[].operations[] carry previousOperationIds / nextOperationIds; all 349 edges
 *   resolve inside the job. itemsToMake[].depth IS the BOM level - no tree walk needed.
 *   2608-1028-42: level 0 = 1 part, 1 = 4, 2 = 16, 3 = 83, 4 = 10. Five columns.
 * 11 MB is why this sits behind a button and never loads with the page.
 *
 * LAYOUT - fourth attempt, and the history is the justification:
 *   1. Columns by DEPENDENCY depth -> hairball; 257 cross-part edges crossing the same gutters.
 *   2. Flat force-directed on 205 operations -> spread, but a part number was not a visible thing.
 *   3. Force-directed on part-number boxes -> right structure, but the sim settled into a narrow
 *      band: the depth anchor and springs beat the repulsion.
 *   4. Columns by BOM LEVEL (deepest parts left, top assembly right), ordered by barycentre.
 *      Right structure, wrong proportions: level 3 is 83 parts, so that one column was a 6,000px
 *      wall against columns of 16, 4 and 1, and the whole graph read as a thin ribbon.
 *   5. THIS: same columns, but (a) an over-tall level WRAPS into sub-columns and stays one band,
 *      (b) vertical position is the MEDIAN y of what a box connects to, packed and swept both
 *      directions, which is what actually shortens the routes, and (c) hover/click highlighting,
 *      because 257 links through one gutter are unreadable at any spacing.
 *      2608-1028-42: 6,000px tall ribbon -> 2,220 x 2,047, median link travel 296px.
 *
 * Only CROSS-PART links are drawn - sequence inside a part is implied by the stack in its box.
 *
 * `order` on an operation is a SPARSE sort key: a gap is not a completed step. Edges are the only
 * real sequence. Read-only: one GET, no writes.
 */
(() => {
  const OLD=document.getElementById('iscflow'); if(OLD) OLD.remove();

  const C={ page:'#0c0d12', panel:'#191a1f', card:'#22242a', box:'#15171c', line:'#2e3138',
    text:'#e6e6f0', dim:'#8a8f9c', orange:'#F58220',
    Pending:'#5b6579', Ready:'#3987e5', Paused:'#b8862f', Complete:'#199e70',
    Cancelled:'#6a3b3b', Running:'#199e70' };
  const GW=186, HEAD=19, OPH=25, PADB=7, COLGAP=210, SUBGAP=26, PAD=70;

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
    '<span class="sub" style="color:'+C.dim+'"></span>'+
    '<span class="focus" style="color:'+C.orange+';font-weight:600"></span>'+
    '<span style="flex:1"></span>'+
    '<label style="color:'+C.dim+'"><input type="checkbox" class="hideDone"> hide complete/cancelled</label>'+
    '<label style="color:'+C.dim+'">gap <input type="range" class="gap" min="4" max="90" value="22" style="vertical-align:middle;width:110px"></label>'+
    '<button class="all" style="'+btn+'">Show all</button>'+
    '<button class="tidy" style="'+btn+'">Re-order</button><button class="fit" style="'+btn+'">Fit</button>'+
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

  /* Filled status cards need a text colour per fill. Picked by sRGB relative luminance rather
     than by eye: Ready/Paused/Complete are light enough that dark ink reads better, Pending and
     Cancelled are not. Hard-coding one text colour fails one end of the palette or the other. */
  const INK={};
  const ink=hex=>{
    if(INK[hex]) return INK[hex];
    const c=[1,3,5].map(i=>parseInt(hex.substr(i,2),16)/255)
      .map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4));
    const L=0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
    return INK[hex]=(1.05/(L+0.05) > (L+0.05)/0.0545) ? '#ffffff' : '#10140f';
  };

  (async () => {
    let j;
    try { j=await (await fetch('/api/Jobs/'+jobId,{credentials:'same-origin'})).json(); }
    catch(e){ body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Failed to load: '+esc(e.message)+'</div>'; return; }

    const ops=[], byId=new Map(), itemDepth=new Map();
    for(const it of (j.itemsToMake||[])){
      const item=(it.itemReference&&(it.itemReference.number||it.itemReference.name))||'?';
      if(!itemDepth.has(item)) itemDepth.set(item, it.depth||0);
      for(const o of (it.operations||[])){
        ops.push({ id:o.id, item, op:(o.operation&&o.operation.name)||'?', status:o.status,
          eq:(o.scheduledEquipment&&o.scheduledEquipment.name)||null,
          hrs:+(((o.estimatedDurationTimeInSeconds||o.estimatedRunTimeInSeconds||0)/3600).toFixed(1)),
          prev:(o.previousOperationIds||[]).slice(), order:o.order, itemToMakeId:it.id });
      }
    }
    ops.forEach(n=>byId.set(n.id,n));
    ops.forEach(n=>{ n.prev=n.prev.filter(p=>byId.has(p)); });

    let cols=[], bands=[], groups=[], gByItem=new Map(), links=[], svg=null, view={x:0,y:0,k:1};
    let focus=null, hoverCss=null;

    /* Focus: the whole upstream + downstream chain of one part. With 257 cross-part links
       through one gutter, no amount of spacing makes the bundle readable - you have to be able
       to ask "what feeds THIS". Hover is the cheap version (direct neighbours, CSS only, no
       redraw); click is the sticky version and redraws. */
    function chain(g){
      const seen=new Set([g]);
      const walk=(n,dir)=>{ for(const m of n[dir]) if(!seen.has(m)){ seen.add(m); walk(m,dir); } };
      walk(g,'in'); walk(g,'out');
      return seen;
    }
    const GAP=()=>+bar.querySelector('.gap').value;

    function build(){
      const hide=bar.querySelector('.hideDone').checked;
      const live=ops.filter(n=>!hide||!/Complete|Cancelled/.test(n.status));
      const ok=new Set(live.map(n=>n.id));

      focus=null; if(bar.querySelector('.focus')) bar.querySelector('.focus').textContent='';
      gByItem=new Map();
      for(const n of live){
        let g=gByItem.get(n.item);
        if(!g){ g={item:n.item, lvl:itemDepth.get(n.item)||0, ops:[], x:0,y:0,fixed:false}; gByItem.set(n.item,g); }
        g.ops.push(n);
      }
      groups=[...gByItem.values()];
      groups.forEach(g=>{
        g.ops.sort((a,b)=>(a.order||0)-(b.order||0));
        g.h=HEAD+g.ops.length*OPH+PADB;
        g.ops.forEach(o=>o.g=g);
      });

      links=[];
      for(const n of live) for(const p of n.prev){
        if(!ok.has(p)) continue;
        const a=byId.get(p); if(a.item===n.item) continue;
        links.push({a,b:n});
      }
      groups.forEach(g=>{ g.in=[]; g.out=[]; });
      for(const l of links){ l.a.g.out.push(l.b.g); l.b.g.in.push(l.a.g); }

      // deepest BOM level on the LEFT, top assembly on the RIGHT - parts flow into assemblies
      const maxL=Math.max(...groups.map(g=>g.lvl));
      cols=[];
      groups.forEach(g=>{ const c=maxL-g.lvl; (cols[c]=cols[c]||[]).push(g); g.col=c; });
      cols.forEach((c,i)=>{ if(!c) cols[i]=[]; });
      tidy();
      bar.querySelector('.sub').textContent=j.name+' - '+groups.length+' part numbers, '+
        live.length+' operations, '+links.length+' cross-part links, '+cols.length+' BOM levels';
    }

    /* Layout: columns by BOM level, but a level with 83 parts would be a 6000px wall against
       columns of 16, 4 and 1 - so any over-tall level WRAPS into sub-columns and stays one band.
       Vertical position is then the MEDIAN y of whatever a box connects to, packed to avoid
       overlap and repeated both directions. Median beats mean here: one far-away neighbour
       should not drag a box halfway up the canvas. That is what shortens the routes. */
    const LIMIT=2300;

    function tidy(){
      // seed order, then sweep medians both ways
      cols.forEach(col=>col.sort((a,b)=> a.item<b.item?-1:a.item>b.item?1:0));
      wrap(); pack();
      for(let pass=0; pass<26; pass++){
        const l2r = pass%2===0;
        const order = l2r ? bands.map((b,i)=>i) : bands.map((b,i)=>i).reverse();
        for(const bi of order){
          for(const sub of bands[bi]){
            if(sub.length<2) continue;
            sub.forEach(g=>{
              const nb = l2r ? g.in : g.out;
              const ys = nb.map(n=>n.y).filter(v=>typeof v==='number').sort((a,b)=>a-b);
              g.want = ys.length ? (ys.length%2 ? ys[(ys.length-1)/2]
                                   : (ys[ys.length/2-1]+ys[ys.length/2])/2) : g.y;
            });
            sub.sort((a,b)=>a.want-b.want);
          }
          pack();
        }
      }
      pack();
    }

    function wrap(){
      const gap=GAP();
      bands=[];
      cols.forEach((col,ci)=>{
        const nat=col.reduce((s,g)=>s+g.h+gap,0);
        const n=Math.max(1,Math.ceil(nat/LIMIT));
        const per=Math.ceil(col.length/n);
        const subs=[];
        for(let i=0;i<n;i++) subs.push(col.slice(i*per,(i+1)*per));
        bands[ci]=subs.filter(s=>s.length);
      });
    }

    function pack(){
      const gap=GAP();
      let x=PAD;
      bands.forEach((subs,bi)=>{
        subs.forEach(sub=>{
          let y=0;
          sub.forEach(g=>{ g.x=x+GW/2; g.y=y+g.h/2; y+=g.h+gap; });
          const tot=y-gap;
          sub.forEach(g=>g.y-=tot/2);
          x+=GW+SUBGAP;
        });
        x+=COLGAP-SUBGAP;
        bands[bi].x0 = x;
      });
    }

    const opPos=o=>{ const g=o.g, i=g.ops.indexOf(o);
      return { y:g.y-g.h/2+HEAD+i*OPH+OPH/2, left:g.x-GW/2, right:g.x+GW/2 }; };

    function draw(){
      if(!svg){ body.innerHTML='<svg style="width:100%;height:100%;display:block"><g class="vp"></g></svg>';
        svg=body.querySelector('svg'); wire(); }
      groups.forEach((g,i)=>g.idx=i);
      const inFocus = focus ? chain(focus) : null;
      let e='';
      for(const l of links){
        const A=opPos(l.a), B=opPos(l.b);
        const x1=A.right, y1=A.y, x2=B.left, y2=B.y, mx=(x1+x2)/2;
        const ga=l.a.g, gb=l.b.g;
        const on = !inFocus || (inFocus.has(ga)&&inFocus.has(gb));
        const hot = inFocus && (ga===focus||gb===focus);
        e+='<path data-a="'+ga.idx+'" data-b="'+gb.idx+'" d="M'+f(x1)+' '+f(y1)+' C'+f(mx)+' '+f(y1)+
           ' '+f(mx)+' '+f(y2)+' '+f(x2)+' '+f(y2)+'" fill="none" stroke="'+
           (on?(hot?C.orange:'#6f7d9c'):'#49536a')+'" stroke-width="'+(on?(hot?2:1.3):1)+
           '" stroke-opacity="'+(on?(hot?1:0.7):0.05)+'"/>';
      }
      let head='';
      bands.forEach((subs,bi)=>{
        if(!subs.length||!subs[0].length) return;
        const all=subs.flat();
        const x=Math.min(...all.map(g=>g.x-GW/2));
        const top=Math.min(...all.map(g=>g.y-g.h/2));
        head+='<text x="'+f(x)+'" y="'+f(top-26)+'" fill="'+C.dim+'" font-size="12" font-weight="700">'+
          'BOM level '+all[0].lvl+'  -  '+all.length+' parts'+(subs.length>1?' ('+subs.length+' columns)':'')+
          '</text>';
      });
      let b='';
      for(const g of groups){
        const x=g.x-GW/2, y=g.y-g.h/2;
        const nb=[g.idx].concat(g.in.map(n=>n.idx), g.out.map(n=>n.idx));
        const lit = !inFocus || inFocus.has(g);
        b+='<g class="g" data-item="'+esc(g.item)+'" data-i="'+g.idx+'" data-nb="'+nb.join(' ')+
          '" opacity="'+(lit?1:0.12)+'">'+
          '<rect x="'+f(x)+'" y="'+f(y)+'" width="'+GW+'" height="'+f(g.h)+'" rx="7" fill="'+C.box+
            '" stroke="'+(g===focus?C.orange:C.line)+'" stroke-width="'+(g===focus?2:1.2)+'"/>'+
          '<text x="'+f(x+9)+'" y="'+f(y+13.5)+'" fill="'+C.text+'" font-size="10.5" font-weight="700">'+
            esc(g.item).slice(0,27)+'</text>';
        g.ops.forEach((o,i)=>{
          const oy=y+HEAD+i*OPH, col=C[o.status]||C.Pending;
          b+='<g class="n" data-id="'+o.id+'">'+
            '<rect x="'+f(x+5)+'" y="'+f(oy+2)+'" width="'+(GW-10)+'" height="'+(OPH-4)+'" rx="4" fill="'+
              col+'" stroke="'+col+'" stroke-width="1.3"/>'+
            '<text x="'+f(x+10)+'" y="'+f(oy+15)+'" fill="'+ink(col)+'" font-size="10" font-weight="600">'+
              esc(o.op).slice(0,20)+(o.hrs?'  '+o.hrs+'h':'')+'</text>'+
            '<title>'+esc(o.item)+'\n'+esc(o.op)+'\n'+o.status+(o.eq?'\n'+esc(o.eq):'')+
              (o.hrs?'\n'+o.hrs+' h':'')+'\nclick to open in Job Tracking</title></g>';
        });
        b+='</g>';
      }
      const vp=svg.querySelector('.vp');
      vp.innerHTML=e+head+b;
      vp.setAttribute('transform','translate('+f(view.x)+','+f(view.y)+') scale('+view.k.toFixed(3)+')');
    }

    function fit(){
      if(!groups.length) return;
      const x0=Math.min(...groups.map(g=>g.x-GW/2))-PAD, x1=Math.max(...groups.map(g=>g.x+GW/2))+PAD;
      const y0=Math.min(...groups.map(g=>g.y-g.h/2))-PAD, y1=Math.max(...groups.map(g=>g.y+g.h/2))+PAD;
      const r=body.getBoundingClientRect();
      view.k=Math.min(r.width/(x1-x0), r.height/(y1-y0), 1.4);
      view.x=-x0*view.k+(r.width-(x1-x0)*view.k)/2;
      view.y=-y0*view.k+(r.height-(y1-y0)*view.k)/2;
      draw();
    }

    function hover(i){
      if(!hoverCss){ hoverCss=document.createElement('style'); root.appendChild(hoverCss); }
      if(i==null||focus){ hoverCss.textContent=''; return; }
      hoverCss.textContent=
        '#iscflow .vp g.g:not([data-nb~="'+i+'"]){opacity:.13}'+
        '#iscflow .vp path:not([data-a="'+i+'"]):not([data-b="'+i+'"]){stroke-opacity:.04}'+
        '#iscflow .vp path[data-a="'+i+'"],#iscflow .vp path[data-b="'+i+'"]'+
          '{stroke:'+C.orange+';stroke-width:2;stroke-opacity:1}';
    }

    function setFocus(g){
      focus = (focus===g) ? null : g;
      hover(null);
      const s=bar.querySelector('.focus');
      s.textContent = focus ? ('focus: '+focus.item+' ('+chain(focus).size+' parts) - click it again or Show all') : '';
      draw();
    }

    function wire(){
      let pan=null, drag=null;
      body.onmouseover=ev=>{
        const gEl=ev.target.closest&&ev.target.closest('g.g');
        hover(gEl?gEl.dataset.i:null);
      };
      body.onmouseleave=()=>hover(null);
      body.onmousedown=ev=>{
        const gEl=ev.target.closest&&ev.target.closest('g.g');
        if(gEl){ const g=gByItem.get(gEl.dataset.item);
          const nEl=ev.target.closest('g.n');
          drag={g, node:nEl?byId.get(nEl.dataset.id):null, moved:false}; }
        else { pan={x:ev.clientX-view.x,y:ev.clientY-view.y}; body.style.cursor='grabbing'; }
      };
      window.addEventListener('mousemove',ev=>{
        if(drag&&drag.g){ drag.moved=true;
          drag.g.x=(ev.clientX-view.x)/view.k; drag.g.y=(ev.clientY-view.y)/view.k; draw(); }
        else if(pan){ view.x=ev.clientX-pan.x; view.y=ev.clientY-pan.y; draw(); }
      });
      window.addEventListener('mouseup',()=>{
        if(drag){
          if(!drag.moved){
            if(drag.node){
              window.open('/jobtracking/#/operation?type=Job&jobId='+jobId+'&selectedOperationId='+
                drag.node.id+'&selectedItemToMakeId='+drag.node.itemToMakeId,'_blank');
            } else setFocus(drag.g);   // part header click isolates its chain
          }
          drag=null;
        }
        pan=null; body.style.cursor='grab';
      });
      body.addEventListener('wheel',ev=>{
        ev.preventDefault();
        const r=body.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
        const k=Math.max(0.05,Math.min(3,view.k*(ev.deltaY<0?1.12:1/1.12)));
        view.x=mx-(mx-view.x)*(k/view.k); view.y=my-(my-view.y)*(k/view.k); view.k=k; draw();
      },{passive:false});
    }

    bar.querySelector('.hideDone').onchange=()=>{ build(); fit(); };
    bar.querySelector('.gap').onchange=()=>{ wrap(); pack(); fit(); };
    bar.querySelector('.all').onclick=()=>{ if(focus) setFocus(focus); };
    bar.querySelector('.tidy').onclick=()=>{ tidy(); draw(); };
    bar.querySelector('.fit').onclick=fit;

    build(); fit();
    window.__flow={ops,groups:()=>groups,cols:()=>cols,links:()=>links,fit,tidy};
  })();
})();
