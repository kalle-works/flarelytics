/** GET /tracker.js — auto-configured tracking script served from the worker. */

// Auto-configured tracking script served from the worker
const TRACKER_SCRIPT = `!function(){var sc=document.currentScript,e="__ENDPOINT__",sd=sc&&"scrollDepth"in sc.dataset,n=function(n,t){var r=Object.assign({event:n,path:location.pathname},t||{});var i=document.referrer;if(n==="pageview"){if(i)try{r.referrer=new URL(i).hostname}catch(e){r.referrer=i}else r.referrer="direct";var o=new URLSearchParams(location.search);["utm_source","utm_medium","utm_campaign"].forEach(function(e){var n=o.get(e);if(n)r[e]=n})}var a=JSON.stringify(r),s=new Blob([a],{type:"application/json"});navigator.sendBeacon?navigator.sendBeacon(e+"/track",s):fetch(e+"/track",{method:"POST",body:a,headers:{"Content-Type":"application/json"},keepalive:!0})};n("pageview");document.addEventListener("click",function(e){var t=e.target.closest("a[href]");if(!t)return;try{var r=new URL(t.href);if(r.hostname===location.hostname)return;n("outbound",{props:{url:r.hostname+r.pathname}})}catch(e){}});var _s=Date.now();document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden"){var t=Math.round((Date.now()-_s)/1000);if(t>1&&t<3600)n("timing",{props:{seconds:String(t)}})}else{_s=Date.now()}});if(sd&&"IntersectionObserver"in window){var _f=new Set,_obs=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;var d=parseInt(e.target.dataset.sd||"0",10);if(d&&!_f.has(d)){_f.add(d);n("scroll_depth",{props:{depth:String(d)}});if(_f.size===4)_obs.disconnect()}})});function _sd(){var h=document.documentElement.scrollHeight;[25,50,75,100].forEach(function(p){var el=document.createElement("div");el.dataset.sd=String(p);el.style.cssText="position:absolute;top:"+(p<100?Math.round(h*p/100):h-2)+"px;left:0;width:1px;height:1px;pointer-events:none;z-index:-1";document.body.appendChild(el);_obs.observe(el)})};document.readyState==="complete"?_sd():window.addEventListener("load",_sd,{once:true})}window.flarelytics={track:n}}();`;

export function handleTrackerJs(request: Request): Response {
  const url = new URL(request.url);
  const endpoint = `${url.protocol}//${url.host}`;
  const script = TRACKER_SCRIPT.replace(/__ENDPOINT__/g, endpoint);
  return new Response(script, {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' },
  });
}
