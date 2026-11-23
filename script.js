const $=id=>document.getElementById(id);
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- Data ---------- */
const LEX={
royalty:'king queen royal prince princess crown throne palace kingdom emperor lord lady',
pets:'dog cat puppy kitten pet pets dogs cats cub bark meow fur',
wild:'lion tiger elephant bear wolf fox deer monkey bird birds fish animal animals zoo wildlife horse',
nature:'tree trees forest river flower flowers mountain mountains ocean sea sun rain sky grass lake nature leaf garden',
fruit:'banana orange mango grape grapes fruit fruits juice juicy sweet lunch eat ate pear berry lemon',
tech:'computer phone laptop software code coding data internet ai robot app apps iphone mac tech technology device screen keyboard program python released',
emotion:'happy sad joy angry love hate fear kind kindness excited calm smile',
action:'play run walk jump swim chase chased chase roam roamed fly flew think read write agree'};
const CEN={royalty:[.15,.2],pets:[.8,.15],wild:[.9,.5],nature:[.55,.85],fruit:[.1,.75],tech:[.3,.45],emotion:[.55,.12],action:[.75,.68],other:[.55,.55]};
const COL={royalty:'#f59e0b',pets:'#ec4899',wild:'#ef4444',nature:'#22c55e',fruit:'#f97316',tech:'#3b82f6',emotion:'#a855f7',action:'#14b8a6',other:'#94a3b8',ambiguous:'#eab308'};
const G2={};Object.entries(LEX).forEach(([g,s])=>s.split(' ').forEach(w=>G2[w]=g));
const STOP=new Set('the a an and of to in on for with by it is was he she they we i my their his her its at as from that this near over through while into or but so'.split(' '));
const SAMPLES=[
['Animals & Nature','The king and the queen loved their royal puppy, a playful dog and a cat. Near the forest a lion, a tiger and an elephant roamed by the river and the mountain, while birds flew over the flowers and trees under the sun.'],
['Tech vs. Fruit (“Apple”)','I ate a juicy apple and a sweet banana for lunch. Then Apple released a new phone with fresh software, and my computer can run the new code. The apple, the orange and the mango are fruit; the laptop and the iPhone are tech.'],
['Prefixes & Suffixes','unbelievable, unhappy, playing, replaying, disagreeable, kindness, unkindly, rethinking, happiness, café 2024 naïve © ☃']];

/* ---------- Simulated subword tokenizer ---------- */
const PRE=['under','over','dis','mis','pre','un','re','in'];
const SUF=['ness','ment','able','ible','tion','less','ful','ing','est','ly','ed','er','es','s'];
const KNOWN=new Set('king string thing ring sing bring spring during evening morning inside indeed insect instead income entire interest present predict result'.split(' '));
function tok(word){
  const w=word.toLowerCase().replace(/['’]/g,'');
  if(!/^[a-z]+$/.test(w)) return ['[UNK]'];
  if(KNOWN.has(w)||w.length<=4) return [w];
  let pre='',suf='',r=w;
  for(const p of PRE) if(r.startsWith(p)&&r.length-p.length>=4){pre=p;r=r.slice(p.length);break}
  for(const s of SUF) if(r.endsWith(s)&&r.length-s.length>=4){suf=s;r=r.slice(0,-s.length);break}
  return [pre,r,suf].filter(Boolean).map((t,i)=>i?'##'+t:t);
}

/* ---------- Helpers for embeddings ---------- */
const hash=s=>{let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0};
const rng=seed=>()=>{seed=(seed+0x6D2B79F5)>>>0;let t=seed;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296};
const L=c=>{const n=c.charCodeAt(0)-96;return n>=1&&n<=26?n:0};
const norm=a=>{const lo=Math.min(...a),hi=Math.max(...a),r=hi-lo;return a.map(v=>r<1e-9?.5:.04+.92*(v-lo)/r)};
const vec=(w,mode,nx,ny)=>{const r=rng(hash(mode+w));return [nx*2-1,ny*2-1,...Array.from({length:6},()=>r()*2-1)].map(v=>+v.toFixed(2))};
function groupOf(w,pieces){
  const root=pieces.map(p=>p.t.replace('##','')).sort((a,b)=>b.length-a.length)[0]||w;
  for(const c of [w,root,root+'e',w.replace(/(es|s|ed|ing)$/,'')]) if(G2[c]) return G2[c];
  return 'other';
}

function analyze(text,hideStop){
  const raw=text.match(/\S+/g)||[];
  const ids=new Map(),rows=new Map(),seq=[];let next=100;
  for(const r of raw){
    const w=r.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'')||r;
    const pieces=tok(w).map(p=>{if(!ids.has(p))ids.set(p,p==='[UNK]'?1:next++);return{t:p,id:ids.get(p)}});
    seq.push({w,pieces});
    const key=w.toLowerCase(),o=rows.get(key);
    if(o)o.freq++;else rows.set(key,{w:key,pieces,freq:1});
  }
  const list=[...rows.values()];
  const cnt={fruit:0,tech:0};
  seq.forEach(s=>{const g=groupOf(s.w.toLowerCase(),s.pieces);if(g in cnt)cnt[g]++});
  const emb=list.filter(r=>r.pieces[0].t!=='[UNK]'&&!(hideStop&&STOP.has(r.w)));
  // Spelling-based: first letters -> x, ending + length -> y
  const lx=emb.map(r=>{const w=r.w;let x=0;for(let i=0;i<4;i++)x+=L(w[i]||'')/Math.pow(27,i);
    const y=.55*((L(w[w.length-2]||'')*27+L(w[w.length-1]))/729)+.45*Math.min(w.length,12)/12;return[x,y]});
  const nx=norm(lx.map(p=>p[0])),ny=norm(lx.map(p=>p[1]));
  const lexPts=emb.map((r,i)=>({w:r.w,nx:nx[i],ny:ny[i],g:r.w[0]+'…',color:`hsl(${(r.w.charCodeAt(0)-97)*14},70%,52%)`,vec:vec(r.w,'lex',nx[i],ny[i])}));
  // Meaning-based: topic centers + small jitter; "apple" follows the text's context
  const semPts=emb.map(r=>{
    let g=groupOf(r.w,r.pieces),x,y;const rd=rng(hash(r.w));
    if(/^apples?$/.test(r.w)){
      const t=cnt.tech,f=cnt.fruit,fr=t+f?t/(t+f):.5;
      x=CEN.fruit[0]+(CEN.tech[0]-CEN.fruit[0])*fr;y=CEN.fruit[1]+(CEN.tech[1]-CEN.fruit[1])*fr;
      g=fr>.6?'tech':fr<.4?'fruit':'ambiguous';
    }else{const c=CEN[g],j=g==='other'?.18:.07;x=c[0]+(rd()-.5)*2*j;y=c[1]+(rd()-.5)*2*j}
    const px=Math.min(1,Math.max(0,(x+.1)/1.2)),py=Math.min(1,Math.max(0,(y+.1)/1.2));
    return{w:r.w,nx:px,ny:py,g,color:COL[g],vec:vec(r.w,'sem',px,py)};
  });
  return{seq,list,vocab:ids.size,tokens:seq.reduce((a,s)=>a+s.pieces.length,0),words:seq.length,lexPts,semPts};
}

/* ---------- State & rendering ---------- */
let d,mode='both',sel=null,hov=null;

function plotHTML(key,pts,title,sub){
  const X=p=>30+p.nx*500,Y=p=>345-p.ny*310;
  const grid=[0,1,2,3,4].map(i=>`<line x1="${30+i*125}" x2="${30+i*125}" y1="35" y2="345"/>`).join('')+
             [0,1,2,3].map(i=>`<line x1="30" x2="530" y1="${35+i*103}" y2="${35+i*103}"/>`).join('');
  const dots=pts.map(p=>`<g class="dot" data-w="${esc(p.w)}"><circle cx="${X(p)}" cy="${Y(p)}" r="6" fill="${p.color}"/><text x="${X(p)+9}" y="${Y(p)+4}">${esc(p.w)}</text></g>`).join('');
  return `<div class="card plot" data-k="${key}"><h2>${title}</h2><p class="muted small">${sub}</p>
    <svg viewBox="0 0 560 380" style="--lbl:${pts.length>45?'none':'block'}"><g class="grid">${grid}</g>${dots}</svg></div>`;
}

function render(){
  const text=$('text').value;
  d=analyze(text,$('hide').checked);
  $('sWords').textContent=d.words;$('sTokens').textContent=d.tokens;$('sVocab').textContent=d.vocab;
  $('pills').innerHTML=d.seq.slice(0,1500).map(s=>`<span class="w">${s.pieces.map((p,j)=>{
    const unk=p.t==='[UNK]',kind=unk?'[UNK]':s.pieces.length>1?`subword ${j+1}/${s.pieces.length}`:'full word';
    return `<span class="t ${unk?'unk':'p'+(j%4)}" data-tip="ID ${p.id} · ${kind}">${esc(p.t.replace('##',''))}</span>`}).join('')}</span>`).join('')
    ||'<span class="muted">Your tokens will appear here.</span>';
  renderRows();
  $('plots').innerHTML=
    plotHTML('lex',d.lexPts,'Spelling-based (lexical)','Words sharing first letters sit side by side; endings and length move them up or down.')+
    plotHTML('sem',d.semPts,'Meaning-based (semantic)','Related words cluster by topic, whatever their spelling. “Apple” moves with the context of your text.');
  applyMode();highlight();
}
function renderRows(){
  const q=$('search').value.toLowerCase();
  $('rows').innerHTML=d.list.filter(r=>r.w.includes(q)).map(r=>`<tr data-w="${esc(r.w)}"><td><b>${esc(r.w)}</b></td>
    <td class="m">${esc(r.pieces.map(p=>p.t).join(' '))}</td><td class="m">${r.pieces.map(p=>p.id).join(', ')}</td><td>${r.freq}</td></tr>`).join('');
}
function applyMode(){
  $('plots').classList.toggle('one',mode!=='both');
  document.querySelectorAll('.plot').forEach(p=>p.hidden=mode!=='both'&&p.dataset.k!==mode);
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on',b.dataset.m===mode));
}
function highlight(){
  const act=hov||sel;
  document.querySelectorAll('.dot,#rows tr').forEach(el=>el.classList.toggle('on',el.dataset.w===act));
  const cur=d.list.find(r=>r.w===act),lp=d.lexPts.find(p=>p.w===act),sp=d.semPts.find(p=>p.w===act);
  $('detail').innerHTML=act&&cur?
    `<div><b style="font-size:1.1rem">${esc(cur.w)}</b> <span class="muted">used ${cur.freq}× · tokens: ${esc(cur.pieces.map(p=>p.t).join(' '))}</span></div>`+
    (lp?`<div><b>Spelling vector:</b> <code>[${lp.vec.slice(0,6).join(', ')}…]</code></div>`:'')+
    (sp?`<div><b>Meaning vector:</b> <code>[${sp.vec.slice(0,6).join(', ')}…]</code><span class="badge" style="background:${sp.color}">${sp.g}</span></div>`:'')+
    `<div class="muted small">Mock 8-dimension vectors for teaching; the first two values follow the plotted position.</div>`
    :'<span class="muted">Hover or click a dot to see its word, mock vector and table row.</span>';
}
function select(w){
  sel=w;highlight();
  const row=document.querySelector(`#rows tr[data-w="${CSS.escape(w)}"]`);
  if(row)$('tbl').scrollTop=Math.max(0,row.offsetTop-70);
}

/* ---------- Events ---------- */
function autosize(){const t=$('text');t.style.height='auto';t.style.height=Math.max(140,t.scrollHeight)+'px'}
$('text').addEventListener('input',()=>{autosize();render()});
$('hide').addEventListener('change',render);
$('search').addEventListener('input',()=>{renderRows();highlight()});
$('tabs').addEventListener('click',e=>{if(e.target.dataset.m){mode=e.target.dataset.m;applyMode()}});
$('plots').addEventListener('mouseover',e=>{const g=e.target.closest('.dot');hov=g?g.dataset.w:null;highlight()});
$('plots').addEventListener('mouseleave',()=>{hov=null;highlight()});
$('plots').addEventListener('click',e=>{const g=e.target.closest('.dot');if(g)select(g.dataset.w)});
$('rows').addEventListener('click',e=>{const r=e.target.closest('tr');if(r)select(r.dataset.w)});
$('samples').innerHTML=SAMPLES.map((s,i)=>`<button data-i="${i}">${s[0]}</button>`).join('');
$('samples').addEventListener('click',e=>{const i=e.target.dataset.i;if(i!==undefined){$('text').value=SAMPLES[i][1];sel=null;autosize();render()}});
const root=document.documentElement;
root.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
const setLabel=()=>$('theme').textContent=root.dataset.theme==='dark'?'Light mode':'Dark mode';
$('theme').addEventListener('click',()=>{root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';setLabel()});
setLabel();
$('text').value=SAMPLES[0][1];autosize();render();
