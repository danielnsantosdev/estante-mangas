// Abertura do app: um mangá folheado rápido com "ESTANTE DE MANGÁS" sendo escrito por cima,
// com som de página de livro e uma caixinha de música. Só ao abrir o app do zero; tocar na tela pula.
// Tudo (páginas e sons) é criado aqui no código, nada copiado de obras de verdade.
const APAR_KEY = "estante-aparencia-v1";
function rnd(seed){ let x=seed*9301+49297; return ()=>{ x=(x*9301+49297)%233280; return x/233280; }; }

// personagem em pose de ação (traço grosso, estilo mangá)
function fig(px,py,sc,flip,cor,pose){
  const P=[ // [braço da frente, braço de trás, perna da frente, perna de trás, espada?]
    ["0,-31 10,-35 19,-41","0,-31 -8,-26 -12,-20","2,-18 10,-9 15,0","2,-18 -6,-10 -12,-2",0],
    ["0,-31 9,-28 17,-33","0,-31 -9,-34 -15,-40","2,-18 12,-12 20,-12","2,-18 -4,-8 -2,0",1],
    ["0,-31 -2,-22 6,-18","0,-31 -9,-35 -12,-44","2,-18 9,-8 6,0","2,-18 -7,-9 -14,-6",0]][pose%3];
  const sw=P[4]?`<line x1="17" y1="-33" x2="38" y2="-52" stroke-width="2.6"/>`:"";
  return `<g transform="translate(${px},${py}) scale(${sc*flip},${sc})" stroke="${cor}" fill="none" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="${P[0]}"/><polyline points="${P[1]}"/><line x1="0" y1="-33" x2="2" y2="-18" stroke-width="5.5"/><polyline points="${P[2]}"/><polyline points="${P[3]}"/>${sw}
    <circle cx="0" cy="-40" r="5.2" fill="${cor}" stroke="none"/><path d="M-6 -41 L-10 -48 L-4 -46 L-3 -53 L1 -47 L5 -54 L6 -46 L11 -49 L7 -41Z" fill="${cor}" stroke="none"/></g>`;
}
function paginaManga(seed, cor){ return cor ? paginaCor(seed) : paginaPB(seed); }
const FALAS=["Ainda não acabou!","Quem é você?!","Então é isso...","Não vou desistir!","Fiquem atrás de mim!","Hmm...","Essa força...","Agora é sério!","Corre!!","Eu prometo."];
function balao(x,y,w,h,txt,r){
  const lin=txt.match(/.{1,9}(\s|$)/g)||[txt], fs=Math.min(h/(lin.length+1.4),3.6);
  return `<g><ellipse cx="${x}" cy="${y}" rx="${w/2}" ry="${h/2}" fill="#fff" stroke="#141414" stroke-width=".55"/><path d="M${x+w*.1} ${y+h*.42} l${r()<.5?-3:3} 4 l1 -4.2z" fill="#fff" stroke="#141414" stroke-width=".55"/>${lin.map((l,i)=>`<text x="${x}" y="${y-(lin.length-1)*fs*.55+i*fs*1.1+fs*.35}" text-anchor="middle" font-family="Inter,Arial" font-weight="700" font-size="${fs}" fill="#141414">${l.trim()}</text>`).join("")}</g>`;
}
function sfx(x,y,txt,sz,rot,claro){ return `<text x="${x}" y="${y}" font-family="Bangers,Impact" font-size="${sz}" fill="${claro?"#fffdf8":"#141414"}" stroke="${claro?"#141414":"#fffdf8"}" stroke-width="${sz*.09}" paint-order="stroke" letter-spacing=".5" transform="rotate(${rot} ${x} ${y}) skewX(-10)">${txt}</text>`; }
function olho(cx,cy,s,cor="#141414"){ return `<g transform="translate(${cx},${cy}) scale(${s})"><path d="M-20 0 Q0 -13 20 0 Q0 9 -20 0Z" fill="#fff" stroke="${cor}" stroke-width="1.6"/><circle r="6.5" fill="${cor}"/><circle r="3" fill="#fff" opacity=".15"/><circle cx="2.4" cy="-2.6" r="1.8" fill="#fff"/><path d="M-22 -10 Q-2 -20 20 -12" stroke="${cor}" stroke-width="2.4" fill="none"/>${Array.from({length:5},(_, i)=>`<line x1="${-16+i*8}" y1="-4" x2="${-18+i*8}" y2="-9" stroke="${cor}" stroke-width=".8"/>`).join("")}</g>`; }
function paginaPB(seed){
  const r=rnd(seed); let defs=`<pattern id="t${seed}" width="2.2" height="2.2" patternUnits="userSpaceOnUse"><circle cx="1.1" cy="1.1" r=".5" fill="#141414"/></pattern><linearGradient id="g${seed}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>`;
  const L=[[[0,0,100,50],[0,52,36,92],[38,52,100,92],[0,94,58,144],[60,94,100,144]],[[0,0,62,40],[64,0,100,40],[0,42,100,98],[0,100,48,144],[50,100,100,144]],[[0,0,100,34],[0,36,48,80],[50,36,100,80],[0,82,30,144],[32,82,100,144]]][Math.floor(r()*3)];
  const tipos=["cena","impacto","olho","dialogo","cena","impacto"].sort(()=>r()-.5);
  let out="";
  L.forEach((q,i)=>{
    const [x1,y1,x2,y2]=q, w=x2-x1, h=y2-y1, cx=x1+w/2, cy=y1+h/2, t=tipos[i%tipos.length], sc=Math.min(w,h)/60;
    let c=`<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="#fff"/>`;
    if(t==="cena"){ // interior/rua com várias pessoas e hachura
      c+=`<rect x="${x1}" y="${y1}" width="${w}" height="${h*.55}" fill="url(#t${seed})" opacity=".35"/>`;
      for(let j=0;j<6;j++) c+=`<rect x="${x1+j*w/6+1}" y="${y1+h*(.12+r()*.2)}" width="${w/6-2}" height="${h*.5}" fill="#fff" stroke="#141414" stroke-width=".4"/>`;
      c+=`<line x1="${x1}" y1="${y1+h*.62}" x2="${x2}" y2="${y1+h*.62}" stroke="#141414" stroke-width=".6"/>`;
      for(let j=0;j<4;j++) c+=fig(x1+w*(.15+j*.23),y2-2,sc*(.55+r()*.35),r()<.5?1:-1,"#141414",Math.floor(r()*3));
      c+=balao(x1+w*(.25+r()*.4),y1+h*.2,Math.min(w*.4,30),Math.min(h*.3,16),FALAS[Math.floor(r()*FALAS.length)],r);
      if(r()<.5) c+=sfx(x1+w*.62,y1+h*.3,["KLAK","TUM","CREC"][Math.floor(r()*3)],Math.min(w,h)*.2,-8);
    }
    if(t==="impacto"){
      for(let j=0;j<30;j++){ const a=j/30*6.283; c+=`<line x1="${cx}" y1="${cy}" x2="${cx+120*Math.cos(a)}" y2="${cy+120*Math.sin(a)}" stroke="#141414" stroke-width="${.3+r()*.7}"/>`; }
      c+=`<circle cx="${cx}" cy="${cy}" r="${Math.min(w,h)*.2}" fill="#fff"/>`+fig(cx,y2-2,sc*1.15,r()<.5?1:-1,"#141414",Math.floor(r()*3));
      c+=sfx(x1+w*.5,y1+h*.3,["SLAM!!","BAM!","CRASH!","POW!"][Math.floor(r()*4)],Math.min(w,h)*.3,-12+r()*8);
    }
    if(t==="olho"){
      c+=`<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="url(#t${seed})" opacity=".25"/>`;
      for(let j=0;j<14;j++) c+=`<line x1="${x1}" y1="${y1+j*h/14}" x2="${x2}" y2="${y1+j*h/14}" stroke="#141414" stroke-width=".25"/>`;
      c+=olho(cx,cy,Math.min(w/50,h/26));
      if(r()<.6) c+=sfx(x1+w*.08,y1+h*.3,"!",Math.min(w,h)*.35,0);
    }
    if(t==="dialogo"){
      c+=fig(x1+w*.28,y2-2,sc*1.05,1,"#141414",2)+fig(x1+w*.74,y2-2,sc*1.05,-1,"#141414",0);
      c+=balao(x1+w*.25,y1+h*.22,Math.min(w*.42,30),Math.min(h*.34,18),FALAS[Math.floor(r()*FALAS.length)],r);
      c+=balao(x1+w*.72,y1+h*.3,Math.min(w*.38,26),Math.min(h*.28,15),FALAS[Math.floor(r()*FALAS.length)],r);
    }
    out+=`<clipPath id="c${seed}_${i}"><rect x="${x1}" y="${y1}" width="${w}" height="${h}"/></clipPath><g clip-path="url(#c${seed}_${i})">${c}</g><rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="none" stroke="#141414" stroke-width="1.3"/>`;
  });
  return `<svg class="cena" viewBox="-5 -5 110 154" preserveAspectRatio="xMidYMid meet"><defs>${defs}</defs><rect x="-5" y="-5" width="110" height="154" fill="#fffdf8"/>${out}<text x="98" y="148" font-size="3" font-family="Inter" fill="#999">${seed*7}</text></svg>`;
}
function paginaCor(seed){
  const r=rnd(seed+50), id="w"+seed;
  const pal=[["#0b1230","#3a2a7a","#9fd3ff"],["#140b1f","#5a1f6b","#ffb36b"],["#06141f","#1f4f7a","#bfe8ff"]][Math.floor(r()*3)];
  let defs=`<filter id="b${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="f${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient>
    <radialGradient id="l${id}"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".3" stop-color="${pal[2]}" stop-opacity=".6"/><stop offset="1" stop-color="${pal[2]}" stop-opacity="0"/></radialGradient>
    <linearGradient id="o${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset="1" stop-color="#ff8a2a"/></linearGradient>`;
  // quadros inclinados, como webtoon
  const Q=[[[4,4],[64,4],[60,62],[4,58]],[[66,4],[96,4],[96,40],[62,42]],[[62,44],[96,42],[96,62],[60,64]],[[4,62],[58,66],[56,140],[4,140]],[[60,66],[96,64],[96,140],[58,140]]];
  let out="";
  Q.forEach((p,i)=>{
    const pts=p.map(x=>x.join(",")).join(" "), xs=p.map(x=>x[0]), ys=p.map(x=>x[1]), x1=Math.min(...xs), x2=Math.max(...xs), y1=Math.min(...ys), y2=Math.max(...ys), cx=(x1+x2)/2, cy=(y1+y2)/2, w=x2-x1, h=y2-y1;
    let c=`<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="url(#f${id})"/>`;
    const k=(i+seed)%5;
    if(k===0){ c+=`<circle cx="${cx}" cy="${cy}" r="${Math.max(w,h)*.55}" fill="url(#l${id})"/>`; for(let j=0;j<18;j++){ const a=r()*6.283, d=8+r()*30; c+=`<line x1="${cx+Math.cos(a)*d*.4}" y1="${cy+Math.sin(a)*d*.4}" x2="${cx+Math.cos(a)*d}" y2="${cy+Math.sin(a)*d}" stroke="#ffd08a" stroke-width=".7" filter="url(#b${id})"/>`; } c+=fig(cx,y2-2,Math.min(w,h)/48,1,"#0a0a14",1); }
    if(k===1){ c+=`<path d="M${x1} ${y2} L${x2} ${y1}" stroke="#fff" stroke-width="2.4" filter="url(#b${id})"/><path d="M${x1} ${y2-6} L${x2} ${y1+2}" stroke="${pal[2]}" stroke-width="1" filter="url(#b${id})"/>`+sfx(x1+w*.12,y1+h*.38,"CLANG",Math.min(w,h)*.3,-14,true).replace('fill="#fffdf8"',`fill="url(#o${id})"`).replace(/stroke="#141414"/,'stroke="#3a1a00"'); }
    if(k===2){ c+=`<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="#05060c" opacity=".6"/><ellipse cx="${cx}" cy="${cy}" rx="${w*.32}" ry="${h*.12}" fill="none" stroke="${pal[2]}" stroke-width="1.2" filter="url(#b${id})"/><circle cx="${cx}" cy="${cy}" r="${h*.09}" fill="#fff" filter="url(#b${id})"/>`; }
    if(k===3){ c+=`<circle cx="${cx}" cy="${y1+h*.35}" r="${w*.5}" fill="url(#l${id})"/>`+fig(cx,y2-3,Math.min(w,h)/42,-1,"#0a0a14",0); for(let j=0;j<3;j++) c+=sfx(x1+w*(.05+r()*.5),y1+h*(.2+j*.25),"BANG",Math.min(w,h)*.22,-10+r()*20,true).replace('fill="#fffdf8"','fill="#dff3ff"').replace(/stroke="#141414"/,`stroke="${pal[1]}"`); }
    if(k===4){ c+=`<circle cx="${cx}" cy="${cy}" r="${Math.max(w,h)*.5}" fill="url(#l${id})" opacity=".7"/>`+fig(cx,y2-2,Math.min(w,h)/40,r()<.5?1:-1,"#0a0a14",2)+`<rect x="${x1+w*.1}" y="${y1+h*.1}" width="${w*.45}" height="${Math.min(h*.18,10)}" fill="#fff" stroke="#141414" stroke-width=".5"/><text x="${x1+w*.325}" y="${y1+h*.1+Math.min(h*.18,10)*.62}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${Math.min(h*.07,3.6)}" fill="#141414">O quê...?</text>`; }
    out+=`<clipPath id="c${id}_${i}"><polygon points="${pts}"/></clipPath><g clip-path="url(#c${id}_${i})">${c}</g><polygon points="${pts}" fill="none" stroke="#141414" stroke-width="1.2"/>`;
  });
  return `<svg class="cena" viewBox="0 0 100 144" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs><rect width="100" height="144" fill="#fff"/>${out}</svg>`;
}
function ruido(a,t0,dur,f0,f1,vol,tipo="bandpass",q=1){ const n=a.createBufferSource(), b=a.createBuffer(1,a.sampleRate*dur,a.sampleRate), d=b.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1; n.buffer=b; const f=a.createBiquadFilter(); f.type=tipo; f.Q.value=q; f.frequency.setValueAtTime(f0,t0); f.frequency.exponentialRampToValueAtTime(f1,t0+dur); const g=a.createGain(); g.gain.setValueAtTime(0.0001,t0); g.gain.exponentialRampToValueAtTime(vol,t0+dur*.25); g.gain.exponentialRampToValueAtTime(0.0001,t0+dur); n.connect(f).connect(g).connect(a.destination); n.start(t0); n.stop(t0+dur); }
function pancada(a,t0,vol=1){ const o=a.createOscillator(), g=a.createGain(); o.type="sine"; o.frequency.setValueAtTime(150,t0); o.frequency.exponentialRampToValueAtTime(42,t0+.35); g.gain.setValueAtTime(vol,t0); g.gain.exponentialRampToValueAtTime(0.0001,t0+.45); o.connect(g).connect(a.destination); o.start(t0); o.stop(t0+.5); ruido(a,t0,.18,3000,300,.5*vol,"lowpass",.7); }
function tom(a,t0,f,dur,vol){ const o=a.createOscillator(), g=a.createGain(); o.type="triangle"; o.frequency.value=f; g.gain.setValueAtTime(0.0001,t0); g.gain.exponentialRampToValueAtTime(vol,t0+.02); g.gain.exponentialRampToValueAtTime(0.0001,t0+dur); o.connect(g).connect(a.destination); o.start(t0); o.stop(t0+dur); }
function reverb(a,seg=1.6){ const c=a.createConvolver(), n=a.sampleRate*seg, b=a.createBuffer(2,n,a.sampleRate); for(let ch=0;ch<2;ch++){ const d=b.getChannelData(ch); for(let i=0;i<n;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/n,2.6); } c.buffer=b; const g=a.createGain(); g.gain.value=.35; c.connect(g).connect(a.destination); return c; }
// página de livro de verdade: "fffp" de papel (ruído filtrado e macio) + o toque leve no fim
function pagina(a,t0,vol=.14,rv){
  const dur=.11+Math.random()*.05, n=a.createBufferSource(), b=a.createBuffer(1,a.sampleRate*dur,a.sampleRate), d=b.getChannelData(0);
  let ult=0; for(let i=0;i<d.length;i++){ const w=Math.random()*2-1; ult=ult*.55+w*.45; d[i]=ult*(Math.random()<.02?2.2:1); }   // ruído "amassado", com estalinhos de papel
  n.buffer=b;
  const hp=a.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=500;
  const bp=a.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=.6; bp.frequency.setValueAtTime(1400+Math.random()*500,t0); bp.frequency.linearRampToValueAtTime(3200,t0+dur*.6);
  const lp=a.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=5200;
  const g=a.createGain(); g.gain.setValueAtTime(0.0001,t0); g.gain.linearRampToValueAtTime(vol,t0+.012); g.gain.linearRampToValueAtTime(vol*.55,t0+dur*.5); g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  n.connect(hp).connect(bp).connect(lp).connect(g).connect(a.destination); if(rv) g.connect(rv);
  n.start(t0); n.stop(t0+dur);
  ruido(a,t0+dur*.85,.03,500,250,vol*.5,"lowpass",.5);   // a folha assentando
}
function nota(a,t0,f,dur,vol,tipo="sine",rv,ataque=.01){ const o=a.createOscillator(), g=a.createGain(); o.type=tipo; o.frequency.value=f; g.gain.setValueAtTime(0.0001,t0); g.gain.exponentialRampToValueAtTime(vol,t0+ataque); g.gain.exponentialRampToValueAtTime(0.0001,t0+dur); o.connect(g).connect(a.destination); if(rv) g.connect(rv); o.start(t0); o.stop(t0+dur+.05); }
function sino(a,t0,f,vol,rv){ nota(a,t0,f,1.4,vol,"sine",rv,.005); nota(a,t0,f*2.01,.8,vol*.35,"sine",rv,.005); nota(a,t0,f*3.02,.5,vol*.12,"sine",rv,.005); }
function pad(a,t0,dur,freqs,vol,rv){ freqs.forEach((f,i)=>{ const o=a.createOscillator(), o2=a.createOscillator(), g=a.createGain(), lp=a.createBiquadFilter(); o.type="triangle"; o2.type="sine"; o.frequency.value=f; o2.frequency.value=f*1.003; lp.type="lowpass"; lp.frequency.value=1400; g.gain.setValueAtTime(0.0001,t0); g.gain.linearRampToValueAtTime(vol,t0+dur*.45); g.gain.linearRampToValueAtTime(0.0001,t0+dur); o.connect(lp); o2.connect(lp); lp.connect(g).connect(a.destination); if(rv) g.connect(rv); o.start(t0); o2.start(t0); o.stop(t0+dur+.05); o2.stop(t0+dur+.05); }); }
const DO=261.63, MI=329.63, SOL=392, SI=493.88, LA=440, RE=293.66;
function somAbertura(fim, n, passo, ini) {
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  const a = new AC(); if (a.state === "suspended") a.resume().catch(() => {});
  const t = a.currentTime + .03, rv = reverb(a);
  pagina(a, t + .75, .13, rv);   // capa abrindo
  for (let i = 0; i < n; i++) pagina(a, t + ini + i * passo, .085 + Math.random() * .035, rv);
  [DO * 2, MI * 2, SOL * 2, DO * 4, MI * 2, SOL * 2, SI * 2, RE * 4].forEach((f, i) => nota(a, t + .55 + i * .2, f, .4, .032, "sine", rv, .004));
  [DO * 4, MI * 4, SOL * 4, DO * 8].forEach((f, i) => nota(a, t + fim + i * .05, f, 1.1, .05, "sine", rv, .003));
  sino(a, t + fim, DO * 2, .07, rv);
  return a;
}
const CSS = `
#abertura{position:fixed;inset:0;z-index:9999;background:#f4efe5;background-image:radial-gradient(rgba(20,20,20,.09) 1px,transparent 1.3px);background-size:14px 14px;display:grid;place-items:center;overflow:hidden;transition:opacity .45s ease;cursor:pointer;-webkit-tap-highlight-color:transparent}
#abertura.sai{opacity:0}
#abertura .ab-logo{position:relative;display:flex;flex-direction:column;align-items:center;gap:1.4vh;z-index:9;pointer-events:none;clip-path:inset(0 100% 0 0)}
#abertura.go .ab-logo{animation:ab-escreve 1.35s steps(16) .95s forwards}
@media (min-aspect-ratio:1/1){ #abertura .ab-logo{flex-direction:row;gap:2vw} }
#abertura .ab-selo{font-family:Bangers,Impact,sans-serif;font-size:min(17vw,12vh);line-height:1;color:#fff;background:#e0312b;border:4px solid #141414;padding:.12em .28em 0;transform:rotate(-4deg);box-shadow:7px 7px 0 #141414;letter-spacing:2px}
#abertura .ab-dm{font-family:Bangers,Impact,sans-serif;font-size:min(12vw,9vh);line-height:1;color:#141414;letter-spacing:2px;white-space:nowrap;background:#f4efe5;padding:.05em .25em;border:3px solid #141414;box-shadow:4px 4px 0 #141414}
#abertura .ab-livro{position:absolute;height:min(70vh,118vw);aspect-ratio:3/4.3;z-index:7;perspective:1600px;opacity:0;transform:scale(.94) translateY(2%)}
#abertura.go .ab-livro{animation:ab-livroentra .45s cubic-bezier(.2,.8,.2,1) .25s forwards,ab-livrosai .45s cubic-bezier(.7,0,.3,1) 2.3s forwards}
#abertura .ab-folha,#abertura .ab-capa{position:absolute;inset:0;border:2px solid #141414;transform-origin:left center;overflow:hidden}
#abertura .ab-folha{background:#fffdf8}
#abertura.go .ab-folha{animation:ab-folheia .26s cubic-bezier(.6,0,.4,1) both}
#abertura .ab-capa{background:#141414;display:grid;place-items:end start;padding:8%}
#abertura .ab-capa::before{content:"";position:absolute;inset:0;background:repeating-conic-gradient(from 0deg at 60% 40%,rgba(255,255,255,.12) 0deg 2deg,transparent 2deg 9deg)}
#abertura .ab-capa b{position:relative;font-family:Bangers,Impact,sans-serif;font-weight:400;color:#fff;font-size:min(9vw,6vh);letter-spacing:1px}
#abertura .ab-capa i{position:absolute;top:8%;left:8%;right:8%;height:12%;background:#e0312b;border:2px solid #fff}
#abertura.go .ab-capa{animation:ab-folheia .38s cubic-bezier(.6,0,.4,1) .75s both}
#abertura .ab-folha svg{position:absolute;inset:0;width:100%;height:100%}
@keyframes ab-livroentra{100%{opacity:1;transform:none}}
@keyframes ab-folheia{0%{transform:rotateY(0)}100%{transform:rotateY(-178deg);filter:brightness(.8)}}
@keyframes ab-escreve{100%{clip-path:inset(0 0 0 0)}}
@keyframes ab-livrosai{0%{opacity:1;transform:none}100%{transform:translateY(120%) rotate(12deg);opacity:0}}
`;
function lerApar() { try { return JSON.parse(localStorage.getItem(APAR_KEY) || "{}") || {}; } catch (e) { return {}; } }
(function abertura() {
  const ap = lerApar();
  if (ap.abertura === "off") return;
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  // linha do tempo (segundos depois que começa): capa abre 0,75 · páginas de 0,95 a 2,2 · nome aparece até 2,3 · livro sai 2,3 · fica até 3,1
  const N = 12, passo = .105, ini = .95, nome = 2.3, total = 3.1;
  const el = document.createElement("div"); el.id = "abertura"; el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="ab-logo"><span class="ab-selo">ESTANTE</span><span class="ab-dm">DE MANGÁS</span></div>
    <div class="ab-livro"><div class="ab-capa" style="z-index:${N + 1}"><i></i><b>VOL. 1</b></div>${Array.from({ length: N }, (_, i) => `<div class="ab-folha" style="z-index:${N - i};animation-delay:${ini + i * passo}s">${paginaManga(i + 3, i % 3 === 2)}</div>`).join("")}</div>`;
  document.body.appendChild(el);
  let audio = null, acabou = false, comecou = false, tFim = null;
  const sair = () => {
    if (acabou) return; acabou = true; clearTimeout(tFim);
    el.classList.add("sai");
    setTimeout(() => { el.remove(); st.remove(); }, 480);
    if (audio) setTimeout(() => { try { audio.close(); } catch (e) {} }, 1500);
  };
  // começa só quando a tela já está desenhada (e as fontes prontas), com uma pausa curta
  const comecar = () => {
    if (comecou || acabou) return; comecou = true;
    setTimeout(() => {
      if (acabou) return;
      el.classList.add("go");
      try { if (ap.aberturaSom !== "off") audio = somAbertura(nome, N, passo, ini); } catch (e) {}
      tFim = setTimeout(sair, total * 1000);
    }, 350);
  };
  const fontes = document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 800))]) : Promise.resolve();
  fontes.then(() => requestAnimationFrame(() => requestAnimationFrame(comecar)));
  setTimeout(comecar, 1500);   // garantia, se algo demorar
  el.addEventListener("pointerdown", () => { if (audio) try { audio.close(); } catch (e) {} audio = null; sair(); });
})();
