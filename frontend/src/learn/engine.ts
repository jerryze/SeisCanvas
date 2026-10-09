export type Section = {inline:number;x:number[];values:number[][];reference:(number|null)[]};
export type Point = {x:number;y:number;score?:number};
export function similarity(a:number[],b:number[],i:number,j:number){let dot=0,aa=0,bb=0;for(let k=-5;k<=5;k++){const u=a[i+k]??0,v=b[j+k]??0;dot+=u*v;aa+=u*u;bb+=v*v;}return dot/Math.sqrt(aa*bb+1e-10)}
export function track(s:Section,seed:Point,threshold:number,radius:number){const out:Point[]=[seed];for(const dir of [-1,1]){let prev=seed;for(let x=seed.x+dir;x>=0&&x<s.x.length;x+=dir){let best:Point={x,y:prev.y,score:-2};for(let y=Math.max(6,prev.y-radius);y<=Math.min(249,prev.y+radius);y++){const corr=similarity(s.values[prev.x],s.values[x],prev.y,y);const score=.75*corr+.2*(1-Math.min(1,Math.abs(s.values[x][y]-s.values[prev.x][prev.y])))+.05*(1-Math.abs(y-prev.y)/(radius+1));if(score>best.score!)best={x,y,score};}if(best.score!<threshold)break;out.push(best);prev=best;}}return out.sort((a,b)=>Math.abs(a.x-seed.x)-Math.abs(b.x-seed.x))}
// Small, deterministic, one-hidden-layer neural regressor. Labels are existing interpretations.
export function trainNetwork(s:Section,epochs:number){const n=12;let w=Array.from({length:n},(_,j)=>[Math.sin(j*7+1)*.5,Math.cos(j*3)*.5,Math.sin(j+2)*.5]),v=Array.from({length:n},(_,j)=>Math.cos(j*5)*.1),bias=.25;
 const features=(x:number)=>[x/(s.x.length-1)*2-1,s.values[x].slice(40,100).reduce((a,b)=>a+b,0)/60];
 const rows=s.reference.map((t,x)=>({x,t})).filter(r=>r.t!==null&&r.x%4===0);
 const predict=(x:number)=>{const f=features(x),h=w.map(a=>Math.tanh(a[0]*f[0]+a[1]*f[1]+a[2]));return {f,h,y:bias+h.reduce((a,b,j)=>a+b*v[j],0)}};
 for(let e=0;e<epochs;e++)for(const r of rows){const {f,h,y}=predict(r.x),err=y-(r.t!-200)/1020;const old=[...v];bias-=.012*err;for(let j=0;j<n;j++){v[j]-=.012*err*h[j];const d=.012*err*old[j]*(1-h[j]*h[j]);w[j][0]-=d*f[0];w[j][1]-=d*f[1];w[j][2]-=d;}}
 const points=s.x.map((_,x)=>({x,y:Math.max(0,Math.min(255,predict(x).y*255))}));const validation=s.reference.flatMap((t,x)=>t!==null&&x%4!==0?[Math.abs(points[x].y*4+200-t)]:[]);return {points,mae:validation.reduce((a,b)=>a+b,0)/Math.max(1,validation.length),count:rows.length};}
