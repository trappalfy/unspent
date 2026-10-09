// The five shaders, verbatim from brand/hero/hero-prototype.html (ASCII_HERO.md §8). Do not edit.

const HASH = `
float h1(float x){x=fract(x*.1031);x*=x+33.33;x*=x+x;return fract(x);}
float h2(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
`;

export const CELL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA;
layout(location=2) in vec4 aB;
uniform vec2 uRes; uniform float uCell; uniform vec2 uGrid; uniform float uTime;
uniform float uIntroT, uIntroDur, uIntroOn;
uniform vec2 uMouse; uniform float uMouseAmt, uRepelR, uRepelK;
uniform vec4 uGlitch[4];
uniform float uScroll, uDrift, uDriftSpeed, uShimmer, uN, uJit;
out vec2 vUV; out float vVal; out float vAlpha; flat out float vGlyph; flat out float vAccent;
${HASH}
void main(){
  float v=aA.z, seed=aA.w, d=aB.x; vec2 sz=aB.yz; float fl=aB.w;
  float accent=mod(fl,2.), ghost=mod(floor(fl/2.),2.), solid=mod(floor(fl/4.),2.);
  vec2 p=aA.xy; float alpha=1., scr=0.;
  float xN=clamp(p.x/uGrid.x,0.,1.);
  if(ghost>.5){
    float ph=fract(uTime*uDriftSpeed*(.35+.9*h1(seed*91.7))+seed*7.31);
    p.x-=pow(ph,1.25)*uDrift*(.35+d);
    p.y+=(h1(seed*13.1)-.5)*ph*uDrift*.14+sin(ph*6.2831+seed*40.)*.4;
    alpha*=smoothstep(0.,.06,ph)*(1.-ph)*.95;
    scr=ph*.6;
  }
  for(int i=0;i<4;i++){vec4 g=uGlitch[i];if(g.w>.5&&aA.y>=g.x&&aA.y<g.y)p.x+=g.z;}
  vec2 px=p*uCell;
  if(uIntroOn>.5){
    float delay=(1.-xN)*.55+h1(seed*3.7)*.45;
    float k=clamp((uIntroT/uIntroDur-delay*.5)/.5,0.,1.);
    float e=1.-pow(1.-k,3.);
    vec2 off=vec2(-(25.+95.*h1(seed*5.1))*(.6+d),(h1(seed*8.3)-.5)*30.)*uCell;
    px+=off*(1.-e);
    alpha*=smoothstep(0.,.25,k);
    scr=max(scr,1.-smoothstep(.55,1.,k));
  }
  if(uMouseAmt>.001){
    vec2 dv=px+.5*uCell-uMouse; float dist=length(dv);
    float f=uMouseAmt*(1.-smoothstep(0.,uRepelR,dist));
    px+=dv/(dist+1e-3)*f*f*uRepelK+vec2(-f*uRepelK*.35,0.);
    scr=max(scr,f*.9);
  }
  if(uScroll>0.){
    float w=clamp(uScroll*2.2-xN*1.1+(h1(seed*17.3)-.5)*.35,0.,1.);
    float w2=w*w;
    px.x-=w2*uRes.x*(.2+.6*h1(seed*23.9));
    px.y+=(h1(seed*29.3)-.5)*w*uRes.y*.25;
    alpha*=1.-w2; scr=max(scr,w);
  }
  float gi=floor(v*(uN-1.)+.5);
  gi=clamp(gi+floor((h1(seed*61.3)-.5)*uJit*uN*.25+.5),0.,uN-1.);
  float tk=floor(uTime*7.+seed*50.);
  if(h2(vec2(seed*101.,tk))<uShimmer) gi=clamp(gi+(h2(vec2(seed*7.,tk))<.5?-1.:1.),0.,uN-1.);
  float tk2=floor(uTime*18.);
  if(h2(vec2(seed*33.,tk2))<scr) gi=floor(h2(vec2(seed*5.,tk2))*(uN-.01));
  if(solid>.5) gi=uN;
  if(accent>.5) alpha*=.6+.4*step(.12,h2(vec2(seed*3.,floor(uTime*2.5))));
  vec2 pos=px+(aCorner*sz+vec2(0.,(1.-sz.y)*.5))*uCell;
  vec2 c=pos/uRes*2.-1.; c.y=-c.y;
  gl_Position=vec4(c,0.,1.);
  vUV=aCorner; vVal=v; vAlpha=alpha; vGlyph=gi; vAccent=accent;
}`;

export const CELL_FS = `#version 300 es
precision highp float;
in vec2 vUV; in float vVal; in float vAlpha; flat in float vGlyph; flat in float vAccent;
uniform sampler2D uAtlas; uniform vec4 uAtl; uniform vec3 uLime; uniform float uGrayLo, uToneGamma;
out vec4 o;
void main(){
  vec2 uv=vec2((vGlyph*uAtl.y+1.+vUV.x*uAtl.x)/uAtl.z,(1.+vUV.y*uAtl.x)/uAtl.w);
  float a=texture(uAtlas,uv).a*vAlpha;
  vec3 c=vAccent>.5?uLime:vec3(mix(uGrayLo,1.,pow(vVal,uToneGamma)));
  o=vec4(c*a,a);
}`;

export const FS_VS = `#version 300 es
out vec2 vUV;
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);vUV=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;

export const DOWN_FS = `#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel; out vec4 o;
void main(){vec2 t=uTexel;o=(texture(uTex,vUV+vec2(-t.x,-t.y))+texture(uTex,vUV+vec2(t.x,-t.y))+texture(uTex,vUV+vec2(-t.x,t.y))+texture(uTex,vUV+vec2(t.x,t.y)))*.25;}`;

export const BLUR_FS = `#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main(){float w[5]=float[5](.227027,.1945946,.1216216,.054054,.016216);vec4 c=texture(uTex,vUV)*w[0];
for(int i=1;i<5;i++){c+=texture(uTex,vUV+uDir*float(i))*w[i];c+=texture(uTex,vUV-uDir*float(i))*w[i];}o=c;}`;

export const COMP_FS = `#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uScene; uniform sampler2D uBloom; uniform vec2 uTexel;
uniform float uBloomK,uHBlur,uScan,uScanPitch,uExp; out vec4 o;
void main(){vec2 h=vec2(uHBlur*uTexel.x,0.);
vec3 c=texture(uScene,vUV).rgb*.5+texture(uScene,vUV+h).rgb*.25+texture(uScene,vUV-h).rgb*.25;
c+=texture(uBloom,vUV).rgb*uBloomK;
float s=.5+.5*cos(gl_FragCoord.y*6.2831853/uScanPitch);
c*=uExp*(1.-uScan*s); o=vec4(c,1.);}`;
