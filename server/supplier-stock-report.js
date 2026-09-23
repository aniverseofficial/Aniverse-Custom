import path from "path";
import fs from "fs";

const UA = process.env.SUPPLIER_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 AniverseStockReport/1.0";
const MAX_PAGES = Number(process.env.SUPPLIER_MAX_PAGES || 120);
const MAX_PRODUCTS = Number(process.env.SUPPLIER_MAX_PRODUCTS || 1200);
const DETAIL_CONCURRENCY = Number(process.env.SUPPLIER_DETAIL_CONCURRENCY || 6);
const CATALOG_CONCURRENCY = Number(process.env.SUPPLIER_CATALOG_CONCURRENCY || 4);
const REQUEST_TIMEOUT = Number(process.env.SUPPLIER_REQUEST_TIMEOUT_MS || 25000);
const IMAGE_TIMEOUT = Number(process.env.SUPPLIER_IMAGE_TIMEOUT_MS || 18000);

const DEFAULT_CONFIG = {
  schedule: { enabled: false, hour: 8, minute: 0, timezone: "Asia/Kolkata" },
  suppliers: {
    apka: { key:"apka", name:"Apka Store", seed:"https://apkastore.in/product-category/action-figure/", home:"https://apkastore.in/", enabled:true },
    gift: { key:"gift", name:"The Gift Wholesalers", seed:"https://thegiftwholesalers.com/collections/action-figures-wholesaler", home:"https://thegiftwholesalers.com/", enabled:true },
    wholesale: { key:"wholesale", name:"The Wholesale Street", seed:"https://thewholesalestreet.com/product-category/anime-action-figures/", home:"https://thewholesalestreet.com/", fallbackSeed:"https://thewholesalestreet.com/", enabled:true }
  }
};
const runtime = { running:false, startedAt:null, updatedAt:null, phase:"idle", error:null, progress:{sources:{}}, sources:{}, products:[], productIndex:new Map(), lastRunId:null, nextRunAt:null, scheduler:null, config:null };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const clean = s => String(s||"").replace(/\s+/g," ").trim();
const absolute = (base, href) => { try { return new URL(String(href||"").replace(/&amp;/g,"&"),base).href; } catch { return null; } };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./,"").toLowerCase(); } catch { return ""; } };
const sameHost = (a,b) => hostOf(a)===hostOf(b);
const slugTitle = u => { try { const part = new URL(u).pathname.split("/").filter(Boolean).pop() || "Supplier product"; return part.replace(/[-_]+/g," ").replace(/\.(html?|php)$/i,"").replace(/\b\w/g,c=>c.toUpperCase()); } catch { return "Supplier product"; } };
function attr(tag,name){ const m=String(tag).match(new RegExp(name + "\\s*=\\s*[\"\\']([^\"\\']+)[\"\\']","i")); return m?m[1]:""; }
function stripHtml(html){ return clean(String(html||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<noscript[\s\S]*?<\/noscript>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&")); }
function price(v){ if(v==null||v==="")return null; const n=Number(String(v).replace(/[^0-9.]/g,"")); return Number.isFinite(n)?n:null; }
function figureLike(name,url){ const t=`${name||""} ${url||""}`.toLowerCase(); const bad=["keychain","sticker","poster","desk mat"," mat ","bottle","wallet","jewelry","cosplay","katana","weapon","lamp","plush","soft toy","die cast"," car ","stationery","card ","phone case","cover","badge","socks","shoe","pouch","mug","watch","clock","pen stand","spinner","tumbler","acrylic","mouse pad"]; if(bad.some(x=>t.includes(x)))return false; return /figure|figurine|statue|collectible|pvc|q[- ]?posket|action|goku|naruto|luffy|zoro|itachi|gojo|tanjiro|sukuna|miku|nezuko|vegeta|gogeta|sabo|shinji|shinchan|onepiece|one piece|demon slayer|jujutsu|bleach|dragon ball/i.test(t); }
function stockFrom(html,ld){ const av=String(ld?.availability||"").toLowerCase(); if(/outofstock|soldout|discontinued|unavailable/.test(av))return "OUT"; if(/instock|limitedavailability|preorder/.test(av))return "IN"; const b=String(html).toLowerCase(); if(/sold\s*out|out\s*of\s*stock|currently\s*unavailable|notify\s*when\s*available/.test(b))return "OUT"; if(/add\s*to\s*cart|buy\s*now|in\s*stock|available\s*now|ready\s*stock/.test(b))return "IN"; return "VERIFY"; }
function extractImages(html,base){ const out=[]; const add=raw=>{if(!raw)return;let value=String(raw).trim().replace(/\\u0026/g,"&").replace(/&amp;/g,"&");if(value.startsWith("//"))value="https:"+value;const u=absolute(base,value);if(u&&/^https?:$/i.test(new URL(u).protocol)&&!out.includes(u))out.push(u);}; for(const m of String(html).matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image|twitter:image:src)["'][^>]+>/gi))add(attr(m[0],"content")); for(const m of String(html).matchAll(/<img\b[^>]*>/gi)){const t=m[0];for(const a of ["src","data-src","data-lazy-src","data-original","data-fsrc","data-image","data-image-src","data-zoom-image","data-original-src"])add(attr(t,a));const ss=attr(t,"srcset")||attr(t,"data-srcset")||attr(t,"data-lazy-srcset");if(ss)for(const part of ss.split(","))add(part.trim().split(/\s+/)[0]);} for(const m of String(html).matchAll(/"(?:image|image_url|featured_image|featuredImage)"\s*:\s*(?:\[\s*)?["']([^"']+)["']/gi))add(m[1]); return [...new Set(out)].slice(0,16); }
function parseJsonLd(html){ for(const m of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const raw=m[1].replace(/<!--[\s\S]*?-->/g,"").trim();const parsed=JSON.parse(raw);const all=[];const walk=x=>{if(!x)return;if(Array.isArray(x))return x.forEach(walk);if(typeof x==="object"){all.push(x);if(x["@graph"])walk(x["@graph"]);}};walk(parsed);const p=all.find(v=>{const t=v&&v["@type"];return t==="Product"||(Array.isArray(t)&&t.includes("Product"));});if(!p)continue;const offers=Array.isArray(p.offers)?(p.offers[0]||{}):(p.offers||{});const rawImage=Array.isArray(p.image)?p.image[0]:p.image;const image=typeof rawImage==="string"?rawImage:(rawImage&&typeof rawImage==="object"?(rawImage.url||rawImage.src||rawImage.contentUrl||rawImage.thumbnailUrl||""):"");return{name:clean(p.name),sku:clean(p.sku||p.mpn||p.productID),price:price(offers.price||offers.lowPrice||p.price),availability:clean(offers.availability),image:String(image||"")};}catch{}}return null; }
async function fetchPage(url,tries=1){let last=null;for(let attempt=0;attempt<=tries;attempt++){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);try{const r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"en-IN,en;q=0.9","Cache-Control":"no-cache"},redirect:"follow",signal:controller.signal});const body=await r.text();clearTimeout(timer);if(r.ok)return{ok:true,status:r.status,url:r.url,body};last=new Error(`HTTP ${r.status}`);}catch(e){last=e;clearTimeout(timer);}if(attempt<tries)await sleep(450*(attempt+1));}return{ok:false,status:0,url,body:"",error:last?.message||"Request failed"};}
function productPath(u){try{const p=new URL(u).pathname.toLowerCase();return /\/products?\//.test(p)||/\/shop\//.test(p)||/^\/[^/]+\.html?$/.test(p)||/\/product\//.test(p);}catch{return false;}}
function extractProductUrls(html,base){const out=new Map();for(const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const u=absolute(base,m[1]);if(!u||!sameHost(u,base))continue;const title=clean(attr(m[0],"aria-label")||attr(m[0],"title")||stripHtml(m[2]))||slugTitle(u);if(!productPath(u))continue;if(!figureLike(title,u)&&!(/\/products?\//i.test(new URL(u).pathname)))continue;out.set(u,{url:u,name:title,image:"",images:[],price:null,sku:"",status:"VERIFY"});}return[...out.values()];}
function extractPagination(html,base){const out=new Set();for(const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){const u=absolute(base,m[1]);if(!u||!sameHost(u,base))continue;try{const U=new URL(u),q=(U.pathname+U.search).toLowerCase();if(/\/page\/\d+|[?&](?:page|paged|product-page)=\d+/.test(q))out.add(u);}catch{}}return[...out];}
async function discoverSitemap(s){const roots=[`${s.home}sitemap.xml`,`${s.home}sitemap_index.xml`,`${s.home}wp-sitemap.xml`,`${s.home}wp-sitemap-posts-product-1.xml`,`${s.home}sitemap_products_1.xml`];const queue=[...roots],seen=new Set(),products=new Set();while(queue.length&&seen.size<100&&products.size<MAX_PRODUCTS*3){const u=queue.shift();if(seen.has(u))continue;seen.add(u);const r=await fetchPage(u,0);if(!r.ok||!/<(?:urlset|sitemapindex|sitemap)/i.test(r.body))continue;for(const m of r.body.matchAll(/<loc[^>]*>([\s\S]*?)<\/loc>/gi)){const loc=clean(m[1]).replace(/&amp;/g,"&");if(!sameHost(loc,s.home))continue;if(/\.xml(?:\?|$)/i.test(loc)){if(/product|sitemap/i.test(loc))queue.push(loc);}else if(productPath(loc))products.add(loc);}}return[...products];}
async function mapLimit(items,limit,fn){const results=new Array(items.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=items.length)return;try{results[i]=await fn(items[i],i);}catch(e){results[i]=null;}}}await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},worker));return results;}
function liveKey(p){return `${p.supplierKey||""}::${p.url||""}`;}
function upsertLiveProduct(p){const k=liveKey(p);const idx=runtime.productIndex.get(k);if(idx==null){runtime.productIndex.set(k,runtime.products.length);runtime.products.push(p);}else runtime.products[idx]={...runtime.products[idx],...p};}
async function persistSnapshot(getDb,collections,products,runToken){
  const db=getDb();
  const c=db.collection(process.env.SUPPLIER_CATALOG_PRODUCTS_COLLECTION||'supplierCatalogProducts');
  const now=new Date();
  const bySupplier=new Map();
  for(const p of products){
    const key=String(p.supplierKey||'');
    if(!bySupplier.has(key))bySupplier.set(key,new Set());
    bySupplier.get(key).add(String(p.url||''));
    const existing=await c.findOne({supplierKey:key,url:p.url},{projection:{lastSeenAt:1,activeOnSupplier:1,firstSeenAt:1}});
    const wasPreviouslySeen=!!existing;
    const wasActive=existing?.activeOnSupplier!==false;
    const firstSeenAt=existing?.firstSeenAt||now;
    const doc={...p,activeOnSupplier:true,lastSeenRunToken:runToken,lastSeenAt:now,firstSeenAt,isNewStock:!wasPreviouslySeen||!wasActive,updatedAt:now};
    await c.updateOne({supplierKey:key,url:p.url},{$set:doc,$setOnInsert:{createdAt:now}},{upsert:true});
  }
  // Anything previously seen for a supplier but absent from a completed scan is considered removed.
  for(const [supplierKey,seen] of bySupplier){
    const old=await c.find({supplierKey,activeOnSupplier:true,lastSeenRunToken:{$ne:runToken}}).limit(5000).toArray();
    if(old.length){
      const ops=old.filter(x=>!seen.has(String(x.url||''))).map(x=>({updateOne:{filter:{_id:x._id},update:{$set:{activeOnSupplier:false,status:'REMOVED',removedAt:now,updatedAt:now}}}}));
      if(ops.length)await c.bulkWrite(ops,{ordered:false});
    }
  }
}
async function buildStockReport(getDb,collections){
  const db=getDb();
  const c=db.collection(process.env.SUPPLIER_CATALOG_PRODUCTS_COLLECTION||'supplierCatalogProducts');
  const products=await db.collection(collections.products).find({}).limit(10000).toArray();
  const linked=new Map();
  for(const p of products){
    const ss=p.supplierSource||{}; const sk=String(ss.supplierKey||''); const sid=String(ss.supplierProductId||''); const su=String(ss.supplierUrl||'');
    if(!sk)continue;
    for(const k of [`${sk}::id::${sid}`,`${sk}::url::${su}`]) if(!k.endsWith('::')) linked.set(k,{id:String(p._id),name:String(p.name||''),slug:String(p.slug||''),stock:Number(p.stock||0),active:p.active!==false,url:p.slug?`https://www.aniverseofficial.in/products/${p.slug}`:'https://www.aniverseofficial.in/'});
  }
  const rows=await c.find({}).sort({updatedAt:-1}).limit(10000).toArray();
  const out=[],removed=[],newStock=[];
  for(const r of rows){
    const sk=String(r.supplierKey||''),sid=String(r.supplierProductId||''),url=String(r.url||'');
    const match=linked.get(`${sk}::id::${sid}`)||linked.get(`${sk}::url::${url}`)||null;
    const item={supplier:r.supplier||sk,supplierKey:sk,supplierProductId:sid,name:String(r.name||''),url,image:String(r.image||''),status:String(r.status||'VERIFY'),lastChecked:r.lastChecked||r.updatedAt||null,removedAt:r.removedAt||null,aniverse:match};
    if(r.status==='OUT' && r.activeOnSupplier!==false)out.push(item);
    if(r.status==='REMOVED' || r.activeOnSupplier===false)removed.push(item);
    if(r.isNewStock===true && r.activeOnSupplier!==false)newStock.push({...item,firstSeenAt:r.firstSeenAt||r.createdAt||r.updatedAt||null});
  }
  const byNewest=(a,b)=>new Date(b.firstSeenAt||b.lastChecked||0)-new Date(a.firstSeenAt||a.lastChecked||0);
  return {generatedAt:new Date().toISOString(),outOfStock:out.sort((a,b)=>new Date(b.lastChecked||0)-new Date(a.lastChecked||0)),recentlyRemoved:removed.slice(0,500).sort(byNewest),newStock:newStock.slice(0,500).sort(byNewest),counts:{outOfStock:out.length,recentlyRemoved:removed.length,newStock:newStock.length}};
}
async function runSync(getDb,collections){
  if(runtime.running)return false;
  runtime.running=true;runtime.startedAt=new Date().toISOString();runtime.updatedAt=null;runtime.error=null;
  runtime.phase='LOADING CATALOGUE';runtime.products=[];runtime.sources={};runtime.productIndex=new Map();runtime.progress={sources:{}};
  const runToken=runtime.startedAt;
  try{
    runtime.phase='SCANNING SUPPLIERS';
    const enabled=Object.values(runtime.config.suppliers).filter(x=>x.enabled);
    const lists=await Promise.all(enabled.map(s=>crawlSupplier(s).catch(e=>{runtime.sources[s.key]={supplier:s.name,key:s.key,role:'supplier',status:'ERROR',count:0,pages:0,products:[],error:e.message};return[];})));
    const all=lists.flat();
    // Keep only the supplier stock catalogue; no product matching, AI comparison or review workflow.
    runtime.products=all.map(p=>({...p,activeOnSupplier:true,lastSeenRunToken:runToken,lastSeenAt:new Date().toISOString()}));
    await persistSnapshot(getDb,collections,runtime.products,runToken);
    runtime.updatedAt=new Date().toISOString();runtime.phase='COMPLETE';
    const runs=getDb().collection(process.env.SUPPLIER_SYNC_RUNS_COLLECTION||'supplierSyncRuns');
    const result={startedAt:new Date(runtime.startedAt),completedAt:new Date(runtime.updatedAt),status:'complete',productCount:runtime.products.length,sources:Object.values(runtime.sources),createdAt:new Date(),runToken};
    const ins=await runs.insertOne(result);runtime.lastRunId=String(ins.insertedId);runtime.nextRunAt=null;return true;
  }catch(e){
    runtime.error=e.message;runtime.phase='ERROR';
    try{await getDb().collection(process.env.SUPPLIER_SYNC_RUNS_COLLECTION||'supplierSyncRuns').insertOne({startedAt:new Date(runtime.startedAt),completedAt:new Date(),status:'error',error:e.message,createdAt:new Date()});}catch{}
    return false;
  }finally{runtime.running=false;}
}
function nextScheduledIST(){const now=new Date();const hour=Math.min(23,Math.max(0,Number(runtime.config?.schedule?.hour??8)));const minute=Math.min(59,Math.max(0,Number(runtime.config?.schedule?.minute??0)));const target=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),hour-5,minute-30,0,0));if(target<=now)target.setUTCDate(target.getUTCDate()+1);return target;}
function scheduleDaily(getDb,collections){if(runtime.scheduler)clearTimeout(runtime.scheduler);if(!runtime.config?.schedule?.enabled){runtime.nextRunAt=null;return;}const target=nextScheduledIST();runtime.nextRunAt=target.toISOString();const delay=Math.max(1000,target.getTime()-Date.now());runtime.scheduler=setTimeout(async()=>{await runSync(getDb,collections);scheduleDaily(getDb,collections);},delay);}
async function loadConfig(getDb){const c=getDb().collection(process.env.SUPPLIER_CONFIG_COLLECTION||'supplierStockReportConfig');let x=await c.findOne({_id:'global'});if(!x){x={_id:'global',...DEFAULT_CONFIG,createdAt:new Date(),updatedAt:new Date()};await c.insertOne(x);}runtime.config={...DEFAULT_CONFIG,...x,schedule:{...DEFAULT_CONFIG.schedule,...x.schedule},aniverse:{...DEFAULT_CONFIG.aniverse,...x.aniverse},suppliers:{...DEFAULT_CONFIG.suppliers,...x.suppliers}};return runtime.config;}
function publicState(){return{integrationVersion:'supplier-stock-report-v1',running:runtime.running,startedAt:runtime.startedAt,updatedAt:runtime.updatedAt,phase:runtime.phase,error:runtime.error,progress:runtime.progress,config:runtime.config,sources:Object.values(runtime.sources).map(x=>({supplier:x.supplier,key:x.key,role:x.role,pages:x.pages,count:x.count,status:x.status,checkedAt:x.checkedAt,error:x.error||null,requestsFailed:x.requestsFailed||0,progress:runtime.progress.sources?.[x.key]||null})),aniverseCount:runtime.aniverseCount,products:runtime.products.map(({_imageHash,...p})=>p),lastRunId:runtime.lastRunId,nextRunAt:runtime.nextRunAt};}
async function restoreLatest(getDb){try{const db=getDb();const runs=await db.collection(process.env.SUPPLIER_SYNC_RUNS_COLLECTION||'supplierSyncRuns').find({status:'complete'}).sort({completedAt:-1}).limit(1).toArray();const run=runs[0];if(!run)return;runtime.lastRunId=String(run._id);runtime.updatedAt=run.completedAt;runtime.aniverseCount=Number(run.aniverseCount||0);const rows=await db.collection(process.env.SUPPLIER_CATALOG_PRODUCTS_COLLECTION||'supplierCatalogProducts').find({}).sort({updatedAt:-1}).limit(5000).toArray();runtime.products=rows.map(x=>{const {_id,...p}=x;return p;});runtime.productIndex=new Map(runtime.products.map((p,i)=>[liveKey(p),i]));for(const p of runtime.products){if(!p.supplierKey)continue;if(!runtime.sources[p.supplierKey])runtime.sources[p.supplierKey]={supplier:p.supplier,key:p.supplierKey,role:'supplier',count:0,pages:0,status:'ONLINE',checkedAt:p.updatedAt||run.completedAt};runtime.sources[p.supplierKey].count++;}runtime.phase='READY';}catch(e){console.warn('Supplier restore skipped:',e.message);}}
function isPrivateHost(h){h=h.toLowerCase();return h==='localhost'||h==='127.0.0.1'||h==='::1'||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)||/^169\.254\./.test(h);}
function sendImageError(res){return res.status(404).type('text/plain').send('Image unavailable');}
async function withMongoRetry(getDb, reconnect, operation, label = "MongoDB operation") {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const db = getDb();
      if (!db) throw new Error("Database is not connected");
      await db.command({ ping: 1 });
      return await operation(db);
    } catch (error) {
      lastError = error;
      const name = String(error?.name || "");
      const msg = String(error?.message || "");
      const transient = /MongoServerSelectionError|MongoNetworkError|MongoTopologyClosedError|MongoNotConnectedError/.test(name) || /ReplicaSetNoPrimary|connection .* closed|pool.*closed|topology.*closed/i.test(msg);
      if (!transient || attempt === 2) throw error;
      console.warn(`${label}: MongoDB connection issue, reconnecting (attempt ${attempt + 2}/3)...`);
      if (typeof reconnect === "function") await reconnect();
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
export function registerSupplierStockReport({app,getDb,reconnect,collections,auth,adminOnly}){
  app.get("/api/admin/supplier-stock-report/status",auth,adminOnly,(_req,res)=>res.json(publicState()));
  app.get("/api/admin/supplier-stock-report/config",auth,adminOnly,async(_req,res)=>{try{await loadConfig(getDb);res.json(runtime.config);}catch(e){res.status(500).json({error:e.message});}});
  app.post("/api/admin/supplier-stock-report/config",auth,adminOnly,async(req,res)=>{try{await loadConfig(getDb);const body=req.body||{};runtime.config={...runtime.config,suppliers:{...runtime.config.suppliers,...(body.suppliers||{})},schedule:{...runtime.config.schedule,...(body.schedule||{}),enabled:false}};runtime.config.updatedAt=new Date();await getDb().collection(process.env.SUPPLIER_CONFIG_COLLECTION||"supplierStockReportConfig").updateOne({_id:"global"},{$set:runtime.config},{upsert:true});scheduleDaily(getDb,collections);res.json({ok:true,config:runtime.config,nextRunAt:runtime.nextRunAt});}catch(e){res.status(400).json({error:e.message});}});
  app.post("/api/admin/supplier-stock-report/sync",auth,adminOnly,async(_req,res)=>{if(runtime.running)return res.status(409).json({error:"A supplier stock check is already running"});runSync(getDb,collections).catch(e=>console.error("Supplier stock check:",e));res.status(202).json({ok:true,started:true});});
  app.get("/api/admin/supplier-stock-report/report",auth,adminOnly,async(_req,res)=>{try{res.json(await buildStockReport(getDb,collections));}catch(e){res.status(500).json({error:e?.message||"Could not build supplier stock report"});}});
  app.get("/api/admin/supplier-stock-report/runs",auth,adminOnly,async(_req,res)=>{try{const rows=await getDb().collection(process.env.SUPPLIER_SYNC_RUNS_COLLECTION||"supplierSyncRuns").find({}).sort({createdAt:-1}).limit(30).toArray();res.json(rows.map(x=>({...x,_id:String(x._id)})));}catch(e){res.status(500).json({error:e.message});}});
  app.get("/api/admin/supplier-stock-report/image-public",async(req,res)=>{try{const target=String(req.query.url||"");const ref=String(req.query.ref||"");const U=new URL(target);if(!/^https?:$/.test(U.protocol)||isPrivateHost(U.hostname))return sendImageError(res);const headers={"User-Agent":UA,"Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8","Accept-Language":"en-IN,en;q=0.9","Cache-Control":"no-cache"};if(ref){try{const R=new URL(ref);if(/^https?:$/.test(R.protocol)&&!isPrivateHost(R.hostname))headers.Referer=R.origin+"/";}catch{}}let r=await fetch(U,{headers,redirect:"follow",signal:AbortSignal.timeout(IMAGE_TIMEOUT)});let type=(r.headers.get("content-type")||"").toLowerCase();if(!r.ok||(!type.startsWith("image/")&&type!=="application/octet-stream")){try{const fallbackHeaders={...headers,Accept:"image/*,*/*;q=0.8"};r=await fetch(U,{headers:fallbackHeaders,redirect:"follow",signal:AbortSignal.timeout(IMAGE_TIMEOUT)});type=(r.headers.get("content-type")||"").toLowerCase();}catch{}}if(!r.ok)return sendImageError(res);const buf=Buffer.from(await r.arrayBuffer());if(!buf.length)return sendImageError(res);const finalType=type.startsWith("image/")?type:(/\x89PNG/.test(buf.subarray(0,8).toString("latin1"))?"image/png":buf[0]===0xFF&&buf[1]===0xD8?"image/jpeg":"application/octet-stream");res.set({"Content-Type":finalType,"Cache-Control":"public,max-age=3600","Content-Length":String(buf.length),"X-Aniverse-Image-Proxy":"1"});res.send(buf);}catch{return sendImageError(res);}});
  return { init:async()=>{await loadConfig(getDb);await restoreLatest(getDb);scheduleDaily(getDb,collections);}, state:publicState };
}
