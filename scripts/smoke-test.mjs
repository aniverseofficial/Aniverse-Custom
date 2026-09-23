import { spawn } from "node:child_process";
import process from "node:process";

const base = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const checks = [
  ["health", "/api/health"],
  ["products", "/api/products?limit=5"],
  ["categories", "/api/categories"],
  ["storefront", "/"],
  ["admin", "/admin/"]
];

let child = null;
async function reachable() { try { const r = await fetch(base + "/api/health"); return r.status < 600; } catch { return false; } }
async function waitForServer(ms=15000) {
  const end=Date.now()+ms;
  while(Date.now()<end){ if(await reachable()) return true; await new Promise(r=>setTimeout(r,300)); }
  return false;
}

if (!(await reachable()) && process.env.SMOKE_NO_START !== "1") {
  const url = new URL(base); const port = url.port || "4000";
  console.log(`Smoke test: ${base} is not running; starting local server on port ${port}…`);
  child = spawn(process.execPath, ["server/index.js"], { cwd: process.cwd(), env:{...process.env,PORT:port}, stdio:["ignore","pipe","pipe"] });
  child.stdout.on("data", d=>process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", d=>process.stderr.write(`[server] ${d}`));
  if(!(await waitForServer())) { console.error("Could not start the local server. Check MONGODB_URI/JWT_SECRET and server logs."); child.kill(); process.exit(1); }
}

let failed=0;
for(const [name,path] of checks){
  try{
    const r=await fetch(base+path,{redirect:"manual"});
    const ok=r.status>=200&&r.status<400;
    console.log(`${ok?"PASS":"FAIL"} ${name.padEnd(12)} ${r.status} ${path}`);
    if(!ok) failed++;
  }catch(e){console.log(`FAIL ${name.padEnd(12)} ${e.message}`);failed++;}
}

if(child) child.kill();
if(failed){console.error(`\n${failed} smoke check(s) failed.`);process.exit(1);}
console.log("\nAll smoke checks passed.");
