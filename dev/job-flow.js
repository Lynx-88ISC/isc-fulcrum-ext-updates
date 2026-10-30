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
 * FILTERS DO NOT CHANGE TOPOLOGY. Hidden operations are spliced out, not cut out. The BOM and
 * the routing agree on this job - 256 BOM pairs, 256 routing pairs, no gap - so any part that
 * appears not to reach the top assembly is a bug in this file, not bad data in Fulcrum.
 *
 * `order` on an operation is a SPARSE sort key: a gap is not a completed step. Edges are the only
 * real sequence. Read-only: one GET, no writes.
 */
const ISCOpenFlow = () => {
  const OLD=document.getElementById('iscflow'); if(OLD) OLD.remove();

  const C={ page:'#0c0d12', panel:'#191a1f', card:'#22242a', box:'#15171c', line:'#2e3138',
    text:'#e6e6f0', dim:'#8a8f9c', orange:'#F58220', bad:'#e5484d', badBox:'#2e1317', bom:'#8f7ae6', wo:'#4fd1d9',
    Pending:'#5b6579', Ready:'#3987e5', Paused:'#b8862f', Complete:'#199e70',
    Cancelled:'#6a3b3b', Running:'#2fd18b' };
  const GW=186, HEAD=19, OPH=32, CARDH=19, TAB=11, PADB=7, COLGAP=210, SUBGAP=26, PAD=70;

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
    '<span class="woCount" style="color:'+C.wo+';font-weight:600"></span>'+
    '<span class="bom" style="color:'+C.bom+';font-weight:600"></span>'+
    '<span class="oop" style="color:'+C.bad+';font-weight:600"></span>'+
    '<span class="focus" style="color:'+C.orange+';font-weight:600"></span>'+
    '<span style="flex:1"></span>'+
    '<label style="color:'+C.dim+'"><input type="checkbox" class="hideC"> hide complete <b class="nC"></b></label>'+
    '<label style="color:'+C.dim+'"><input type="checkbox" class="hideX" checked> hide cancelled <b class="nX"></b></label>'+
    '<label style="color:'+C.dim+'">WO <select class="wo" style="'+btn+'padding:4px 6px"></select></label>'+
    '<label style="color:'+C.dim+'"><input type="checkbox" class="lock" checked> lock layout</label>'+
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

  const chip=(label,fill)=>'<span style="background:'+fill+';color:'+ink(fill)+
    ';font-weight:600;padding:2px 8px;border-radius:4px">'+label+'</span>';
  const leg=document.createElement('div');
  leg.style.cssText='flex:0 0 auto;display:flex;align-items:center;gap:7px;padding:6px 14px;'+
    'background:'+C.panel+';border-bottom:1px solid '+C.line+';font-size:11px;flex-wrap:wrap';
  leg.innerHTML='<span style="color:'+C.dim+'">operation</span>'+
    chip('Pending',C.Pending)+chip('Ready',C.Ready)+chip('Running',C.Running)+
    chip('Paused',C.Paused)+chip('Complete',C.Complete)+chip('Cancelled',C.Cancelled)+
    '<span style="width:10px"></span>'+
    '<span style="background:'+C.badBox+';border:2px solid '+C.bad+';color:'+C.bad+
      ';font-weight:600;padding:1px 8px;border-radius:4px">out of order</span>'+
    '<span style="color:'+C.dim+'">started before something it depends on finished</span>'+
    '<span style="width:10px"></span>'+
    '<svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="'+C.bom+
      '" stroke-width="2" stroke-dasharray="5 4"/></svg>'+
    '<span style="color:'+C.dim+'">in the BOM, but no routing link</span>'+
    '<span style="width:10px"></span>'+
    '<svg width="24" height="15"><rect x="0" y="0" width="24" height="6" rx="1.5" fill="'+C.Ready+
      '"/><rect x="9" y="7" width="15" height="7" rx="2" fill="'+C.orange+'"/></svg>'+
    '<span style="color:'+C.dim+'">orange tab = in a work order (number inside)</span>'+
    '<span style="flex:1"></span>'+
    '<span style="color:'+C.dim+'">hover a part to trace it &middot; <b style="color:'+C.text+
      '">click a part to pin that highlight</b> &middot; click an operation to open Job Tracking</span>';
  root.insertBefore(leg, body);

  (async () => {
    let j;
    try { j=await (await fetch('/api/Jobs/'+jobId,{credentials:'same-origin'})).json(); }
    catch(e){ body.innerHTML='<div style="padding:60px;text-align:center;color:'+C.dim+'">Failed to load: '+esc(e.message)+'</div>'; return; }

    const ops=[], byId=new Map(), itemDepth=new Map();
    /* inputItemIds are CATALOG item ids, not itemToMake ids - resolving them against the wrong
       key makes every assembly look like it consumes nothing. Map by itemReference.id. */
    const refToItem=new Map(), itemInputs=new Map();
    for(const it of (j.itemsToMake||[])){
      const item=(it.itemReference&&(it.itemReference.number||it.itemReference.name))||'?';
      const rid=it.itemReference&&it.itemReference.id;
      if(rid&&!refToItem.has(rid)) refToItem.set(rid,item);
      if(!itemInputs.has(item)) itemInputs.set(item,(it.inputItemIds||[]).slice());
      if(!itemDepth.has(item)) itemDepth.set(item, it.depth||0);
      for(const o of (it.operations||[])){
        ops.push({ id:o.id, item, op:(o.operation&&o.operation.name)||'?', status:o.status,
          eq:(o.scheduledEquipment&&o.scheduledEquipment.name)||null,
          hrs:+(((o.estimatedDurationTimeInSeconds||o.estimatedRunTimeInSeconds||0)/3600).toFixed(1)),
          prev:(o.previousOperationIds||[]).slice(), order:o.order, itemToMakeId:it.id,
          wo:(o.workOrderOperationReference||{}).workOrderNumber||null });
      }
    }
    ops.forEach(n=>byId.set(n.id,n));
    ops.forEach(n=>{ n.prev=n.prev.filter(p=>byId.has(p)); });

    /* Out of order: an operation that has been started while something it depends on has not
       finished. Paused counts as started - the clock ran. Cancelled counts as satisfied: a
       skipped step is a decision, not a violation.
       Computed on the FULL op set, never on the hide-filtered one - hiding complete operations
       would otherwise remove the very predecessors that make the rest look legal. */
    const STARTED={Complete:1,Running:1,Paused:1}, SATISFIED={Complete:1,Cancelled:1};
    const oopItems=new Set();
    ops.forEach(n=>{
      if(!STARTED[n.status]) return;
      n.why=n.prev.map(p=>byId.get(p)).filter(p=>!SATISFIED[p.status])
        .map(p=>(p.item===n.item?'':p.item+' / ')+p.op+' ('+p.status+')');
      if(n.why.length){ n.oop=true; oopItems.add(n.item); }
    });

    let cols=[], bands=[], groups=[], gByItem=new Map(), links=[], bomLinks=[], svg=null, view={x:0,y:0,k:1};
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
      // exact status match, not a regex - 'Complete' and 'Cancelled' are the only two meant here
      const hC=bar.querySelector('.hideC').checked, hX=bar.querySelector('.hideX').checked;
      const live=ops.filter(n=>!(hC&&n.status==='Complete')&&!(hX&&n.status==='Cancelled'));
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

      /* Hiding an operation must never sever the graph - splice it out instead, wiring each of
         its predecessors to each of its successors.
         Learned the hard way on 2608-1028-42: the Assembly operation on SS001/SS002/SS003 is
         Cancelled, and those are the join points every subassembly feeds into. Dropping them
         orphaned 28 parts and made 38 real routing links look missing. A filter is a view, not
         a change to the topology. */
      const effPrev=n=>{
        const out=new Set(), seen=new Set(), st=n.prev.slice();
        while(st.length){
          const id=st.pop(); if(seen.has(id)) continue; seen.add(id);
          const prev=byId.get(id); if(!prev) continue;
          if(ok.has(prev.id)) out.add(prev.id); else st.push.apply(st,prev.prev);
        }
        return out;
      };
      links=[];
      for(const n of live) for(const p of effPrev(n)){
        const a=byId.get(p); if(a.item===n.item) continue;
        links.push({a,b:n});
      }
      groups.forEach(g=>{ g.in=[]; g.out=[]; });
      for(const l of links){ l.a.g.out.push(l.b.g); l.b.g.in.push(l.a.g); }

      /* A subassembly can be in its parent's BOM and still have no routing dependency into it.
         Fulcrum then has nothing telling the scheduler to build the child first, and the part
         dead-ends in this chart instead of funnelling to the top assembly. Draw those BOM edges
         dashed so the funnel is complete AND the missing dependency is visible. */
      bomLinks=[];
      const have=new Set(links.map(l=>l.a.g.item+'>'+l.b.g.item));
      for(const [item,inputs] of itemInputs){
        const pg=gByItem.get(item); if(!pg||!pg.ops.length) continue;
        for(const rid of inputs){
          const child=refToItem.get(rid);
          if(!child||child===item) continue;
          const cg=gByItem.get(child);
          if(!cg||!cg.ops.length||have.has(child+'>'+item)) continue;
          have.add(child+'>'+item);
          bomLinks.push({a:cg.ops[cg.ops.length-1], b:pg.ops[0], bom:true});
          cg.out.push(pg); pg.in.push(cg);
        }
      }

      // deepest BOM level on the LEFT, top assembly on the RIGHT - parts flow into assemblies
      const maxL=Math.max(...groups.map(g=>g.lvl));
      cols=[];
      groups.forEach(g=>{ const c=maxL-g.lvl; (cols[c]=cols[c]||[]).push(g); g.col=c; });
      cols.forEach((c,i)=>{ if(!c) cols[i]=[]; });
      tidy();
      bar.querySelector('.sub').textContent=j.name+' - '+groups.length+' part numbers, '+
        live.length+' operations, '+links.length+' cross-part links, '+cols.length+' BOM levels';
      bar.querySelector('.bom').textContent = bomLinks.length
        ? (bomLinks.length+' BOM links with no routing dependency') : '';
      const nOop=ops.filter(n=>n.oop).length;
      bar.querySelector('.oop').textContent = nOop
        ? (oopItems.size+' parts out of order ('+nOop+' ops)') : '';
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
      for(const l of links.concat(bomLinks)){
        const A=opPos(l.a), B=opPos(l.b);
        const x1=A.right, y1=A.y, x2=B.left, y2=B.y, mx=(x1+x2)/2;
        const ga=l.a.g, gb=l.b.g;
        const on = !inFocus || (inFocus.has(ga)&&inFocus.has(gb));
        const hot = inFocus && (ga===focus||gb===focus);
        e+='<path data-a="'+ga.idx+'" data-b="'+gb.idx+'" d="M'+f(x1)+' '+f(y1)+' C'+f(mx)+' '+f(y1)+
           ' '+f(mx)+' '+f(y2)+' '+f(x2)+' '+f(y2)+'" fill="none" stroke="'+
           (on?(hot?C.orange:(l.bom?C.bom:'#6f7d9c')):'#49536a')+'" stroke-width="'+(on?(hot?2:1.3):1)+
           '" stroke-opacity="'+(on?(hot?1:(l.bom?0.85:0.7)):0.05)+'"'+
           (l.bom?' stroke-dasharray="5 4"':'')+'/>';
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
        g.oop = oopItems.has(g.item);
        const open='<g class="g" data-item="'+esc(g.item)+'" data-i="'+g.idx+'" data-nb="'+nb.join(' ')+
          '" opacity="'+(lit?1:0.12)+'">';

        b+=open+
          '<rect x="'+f(x)+'" y="'+f(y)+'" width="'+GW+'" height="'+f(g.h)+'" rx="7" fill="'+(g.oop?C.badBox:C.box)+
            '" stroke="'+(g===focus?C.orange:(g.oop?C.bad:C.line))+
            '" stroke-width="'+(g===focus||g.oop?2:1.2)+'"/>'+
          '<text x="'+f(x+9)+'" y="'+f(y+13.5)+'" fill="'+C.text+'" font-size="10.5" font-weight="700">'+
            esc(g.item).slice(0,27)+'</text>';
        g.ops.forEach((o,i)=>{
          const oy=y+HEAD+i*OPH, col=C[o.status]||C.Pending;
          b+='<g class="n" data-id="'+o.id+'"'+(o.wo?' data-wo="'+o.wo+'"':'')+'>'+
            '<rect x="'+f(x+5)+'" y="'+f(oy+2)+'" width="'+(GW-10)+'" height="'+CARDH+'" rx="4" fill="'+
              col+'" stroke="'+(o.oop?C.bad:col)+'" stroke-width="'+(o.oop?2:1.3)+'"/>'+
            '<text x="'+f(x+10)+'" y="'+f(oy+15)+'" fill="'+ink(col)+'" font-size="10" font-weight="600">'+
              esc(o.op).slice(0,20)+(o.hrs?'  '+o.hrs+'h':'')+'</text>'+
            /* One colour, not nine. Being in a work order is a yes/no fact, so it reads as a
               tab appended under the card - ISC orange, filled solid - and WHICH work order is
               the number inside it. Nine hues made the viewer decode a key to answer a binary
               question. An op with no tab is not in a work order. */
            (o.wo?(()=>{ const lab='WO '+o.wo, tw=(GW-10)*0.6, bx=x+5+(GW-10)-tw;
              return '<rect x="'+f(bx)+'" y="'+f(oy+2+CARDH)+'" width="'+f(tw)+'" height="'+TAB+
                '" rx="2.5" fill="'+C.orange+'"/>'+
                '<text x="'+f(bx+tw/2)+'" y="'+f(oy+2+CARDH+TAB-3)+'" text-anchor="middle" '+
                'fill="#1a1206" font-size="8.5" font-weight="800">'+lab+'</text>'; })():'')+
            '<title>'+esc(o.item)+'\n'+esc(o.op)+'\n'+o.status+
              (o.wo?'\nwork order '+o.wo:'\nnot in a work order')+
              (o.eq?'\n'+esc(o.eq):'')+(o.hrs?'\n'+o.hrs+' h':'')+
              (o.oop?'\n\nOUT OF ORDER - started before:\n  '+o.why.map(esc).join('\n  '):'')+
              '\nclick to open in Job Tracking</title></g>';
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

    /* Which operations have been claimed by a work order. Status already owns the card fill and
       red already means out-of-order, so the WO shows as a number on the card's right edge -
       it has to say WHICH work order, not just that there is one. */
    let woCss=null;
    function woFilter(v){
      if(!woCss){ woCss=document.createElement('style'); root.appendChild(woCss); }
      if(!v){ woCss.textContent=''; return; }
      woCss.textContent = (v==='none')
        ? '#iscflow .vp g.n[data-wo]{opacity:.12}'
        : '#iscflow .vp g.n:not([data-wo="'+v+'"]){opacity:.12}';
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
      s.textContent = focus ? ('PINNED: '+focus.item+' - '+chain(focus).size+' parts in its chain') : '';
      draw();
    }

    function wire(){
      let pan=null, drag=null;
      body.onmouseover=ev=>{
        const gEl=ev.target.closest&&ev.target.closest('g.g');
        hover(gEl?gEl.dataset.i:null);
      };
      body.onmouseleave=()=>hover(null);
      /* Locked (the default) a part cannot be dragged out of its column - dragging anywhere
         just pans. Unlock to pull a box aside by hand.
         SLOP exists because the old code set moved=true on the first mousemove event of any
         size, so a 1px tremor during a click cancelled it and pinning a highlight was in
         practice impossible. A click is a click until the pointer travels 4px. */
      const SLOP=4, locked=()=>bar.querySelector('.lock').checked;
      body.onmousedown=ev=>{
        const gEl=ev.target.closest&&ev.target.closest('g.g');
        if(gEl){ const nEl=ev.target.closest('g.n');
          drag={ g:gByItem.get(gEl.dataset.item), node:nEl?byId.get(nEl.dataset.id):null,
                 moved:false, x0:ev.clientX, y0:ev.clientY, move:!locked() }; }
        if(!gEl||locked()){ pan={x:ev.clientX-view.x,y:ev.clientY-view.y}; body.style.cursor='grabbing'; }
      };
      window.addEventListener('mousemove',ev=>{
        if(drag&&!drag.moved&&
           Math.abs(ev.clientX-drag.x0)+Math.abs(ev.clientY-drag.y0)>SLOP) drag.moved=true;
        if(drag&&drag.move&&drag.moved){
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

    bar.querySelector('.hideC').onchange=()=>{ build(); fit(); };
    bar.querySelector('.hideX').onchange=()=>{ build(); fit(); };
    (()=>{
      const n={}; ops.forEach(o=>{ if(o.wo) n[o.wo]=(n[o.wo]||0)+1; });
      const nums=Object.keys(n).sort((a,b)=>a-b);
      const sel=bar.querySelector('.wo');
      sel.innerHTML='<option value="">all</option>'+
        '<option value="none">not in a WO ('+ops.filter(o=>!o.wo).length+')</option>'+
        nums.map(w=>'<option value="'+w+'">'+w+' ('+n[w]+' ops)</option>').join('');
      sel.onchange=()=>woFilter(sel.value);
      bar.querySelector('.woCount').textContent = nums.length
        ? (ops.filter(o=>o.wo).length+' ops in '+nums.length+' work orders') : '';
    })();
    bar.querySelector('.nC').textContent='('+ops.filter(n=>n.status==='Complete').length+')';
    bar.querySelector('.nX').textContent='('+ops.filter(n=>n.status==='Cancelled').length+')';
    bar.querySelector('.gap').onchange=()=>{ wrap(); pack(); fit(); };
    bar.querySelector('.all').onclick=()=>{ if(focus) setFocus(focus); };
    bar.querySelector('.tidy').onclick=()=>{ tidy(); draw(); };
    bar.querySelector('.fit').onclick=fit;

    build(); fit();
    window.__flow={ops,groups:()=>groups,cols:()=>cols,links:()=>links,fit,tidy};
  })();
};

/* The launch button lives in Fulcrum's own Operations header, not floating over the page.
   Anchor: the single childless <h3> reading "Operations" inside .juicy-job-operations-header.
   Both it and the header are display:block, so the button goes INSIDE the h3 as an inline-block
   and sits on the title's baseline without touching Fulcrum's layout.
   700ms poll rather than a MutationObserver: this script also writes DOM, and an observer that
   watches a subtree it edits feeds itself and locks the tab. */
(() => {
  const ID='isc-opchart-btn';
  /* Re-running this script must fully replace the previous instance, not stack on it. The button
     calls through a global rather than closing over ISCOpenFlow, so an existing button starts
     using the new code immediately; the old poll timer is cleared for the same reason. Without
     this a reload leaves the on-screen button wired to the OLD closure and the new build silently
     never runs. */
  if(window.__iscFlowMount) clearInterval(window.__iscFlowMount);
  window.__iscOpenFlow=ISCOpenFlow;
  const title=()=>{
    const h=document.querySelector('.juicy-job-operations-header h3');
    if(h&&h.children.length===0&&h.textContent.trim()==='Operations') return h;
    return [...document.querySelectorAll('h3')].find(e=>
      e.children.length===0&&e.textContent.trim()==='Operations')||null;
  };
  const make=()=>{
    const b=document.createElement('button');
    b.id=ID; b.type='button'; b.textContent='OP CHART';
    b.style.cssText='margin-left:14px;vertical-align:middle;background:#F58220;color:#1a1206;'+
      'border:0;border-radius:7px;padding:7px 14px;cursor:pointer;letter-spacing:.4px;'+
      'font:700 12px Inter,system-ui,sans-serif';
    b.onmouseenter=()=>{ b.style.filter='brightness(1.08)'; };
    b.onmouseleave=()=>{ b.style.filter=''; };
    b.onclick=ev=>{ ev.preventDefault(); ev.stopPropagation(); window.__iscOpenFlow(); };
    return b;
  };
  window.__iscFlowMount=setInterval(()=>{
    if(!/\/ui\/jobs\/[0-9a-f]{24}/.test(location.pathname)){
      const old=document.getElementById(ID); if(old) old.remove();
      return;
    }
    if(document.getElementById(ID)) return;
    const h=title(); if(h) h.appendChild(make());
  },700);
})();
