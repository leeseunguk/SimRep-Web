import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const core = process.env.SIMREP_CORE ?? path.join(root,"simrep");
const binary = process.env.SIMREP_BIN ?? path.join(core,"target/release/simrep");
const modules = process.env.SIMREP_APP_MODULES ?? path.join(root,"web/node_modules");
const { createServer } = await import(pathToFileURL(path.join(modules,"vite/dist/node/index.js")));
const { chromium } = await import(pathToFileURL(path.join(modules,"playwright/index.mjs")));
const output = process.env.SIMREP_EVIDENCE ?? path.join(root,"evidence/einzel-browser");
await mkdir(output,{recursive:true});
const invocations = [];
async function native(args,threads) {
  const result = await promisify(execFile)(binary,args,{env:{...process.env,RAYON_NUM_THREADS:String(threads)},timeout:120000,maxBuffer:8_000_000});
  invocations.push({threads,args,stdout:result.stdout,stderr:result.stderr});
  return JSON.parse(result.stdout);
}
const references = {};
for (const threads of [1,4]) {
  const cases = {};
  for (const exact of [false,true]) {
    const mode = exact ? "exact" : "staircase";
    const stem = path.join(output,`native-${threads}-${mode}`);
    const refineArgs = exact ? ["--json","refine-geometry",path.join(core,"examples/data/einzel.gem"),"--electrode","1=1:0","--electrode","2=2:60","--electrode","3=3:0","--out",stem,"--device","cpu"] : ["--json","refine",`${stem}.pa#`,"--device","cpu"];
    if (!exact) await native(["--json","gem2pa",path.join(core,"examples/data/einzel.gem"),`${stem}.pa#`],threads);
    const refinement = [];
    for (let i=0;i<6;i++) refinement.push(await native(refineArgs,threads));
    const files = {};
    for (const suffix of ["pa0","pa1","pa2","pa3"]) files[suffix] = Array.from(await readFile(`${stem}.${suffix}`));
    const csvPath = `${stem}.csv`;
    const flyArgs = ["--json","fly","--pa",`${stem}.pa0`,"--particles",path.join(core,"examples/data/ions.ion"),"--plane","1,0,0,58","--device","cpu","--duration-us","10","--tolerance","1e-12","--nonrelativistic","--output",csvPath];
    if (!exact) flyArgs.push("--no-cuts","--voltage","2=60");
    const flights = [];
    for (let i=0;i<6;i++) flights.push(await native(flyArgs,threads));
    cases[mode] = {files,csv:Array.from(await readFile(csvPath)),refinement:refinement.slice(1),flights:flights.slice(1)};
  }
  references[threads] = cases;
}
const input = [
  {path:"einzel.gem",bytes:Array.from(await readFile(path.join(core,"examples/data/einzel.gem")))},
  {path:"ions.ion",bytes:Array.from(await readFile(path.join(core,"examples/data/ions.ion")))},
];
const physics = JSON.parse(await readFile(path.join(root,"evidence/flight-physics/identity.json"),"utf8"));
for (const name of ["vacuum.pa","magnetic.pa","one.ion","one.fly2","coils.json"]) input.push({path:name,bytes:Array.from(await readFile(path.join(root,"evidence/flight-physics",name)))});
for (const test of physics) test.expected = Array.from(await readFile(path.join(root,"evidence/flight-physics",`${test.kind}.csv`)));
const browser = await chromium.launch({headless:true});
const report = {invocations,variants:[]};
try {
  for (const variant of [{name:"fallback",isolated:false,requested:4,actual:1},{name:"one",isolated:true,requested:1,actual:1},{name:"four",isolated:true,requested:4,actual:4}]) {
    const headers = variant.isolated ? {"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp"} : {};
    const server = await createServer({root:path.join(root,"web"),configFile:false,worker:{format:"es"},server:{host:"127.0.0.1",port:0,headers},plugins:[{name:"einzel-cpu-qa",configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=="/")return next();for(const [name,value]of Object.entries(headers))res.setHeader(name,value);res.setHeader("Content-Type","text/html");res.end("<!doctype html><meta name='viewport' content='width=device-width'><style>body{margin:16px;font:14px monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Browser-local CPU f64 einzel verification</h1><pre id='result'>Running</pre>");});}}]});
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[], requests=[];
    page.on("pageerror",e=>errors.push(e.message));
    page.on("request",r=>requests.push({method:r.method(),url:r.url()}));
    try {
      await page.goto(origin);
      const result = await page.evaluate(async({variant,input,expected,physics})=>{
        const {createWebBackend} = await import("/src/web/client.ts");
        const assertions=[];
        const check=(yes,name)=>{if(!yes)throw new Error(name);assertions.push(name);};
        check(self.crossOriginIsolated===variant.isolated,"actual cross-origin isolation");
        const backend = await createWebBackend({threads:variant.requested});
        const same=(actual,reference)=>actual.length===reference.length&&actual.every((v,i)=>v===reference[i]);
        const device=await backend.invoke("compute_device");
        check(device.threads===variant.actual,`${variant.name}: expected ${variant.actual} Rayon workers, got ${JSON.stringify(device)}`);
        check(backend.capabilities.threads===variant.actual&&backend.capabilities.multicore===(variant.actual>1),"capabilities match execution");
        if(!variant.isolated)check(typeof device.reason==="string"&&device.reason.length>0,"nonisolated downgrade is explained");
        await backend.putFiles(input.map(f=>({...f,bytes:Uint8Array.from(f.bytes)})));
        await backend.invoke("gem2pa",{path:"einzel.gem",output:"staircase/einzel.pa#"});
        await backend.invoke("refine_geometry",{path:"einzel.gem",output:"exact/einzel",assignments:[{part:"1",number:1,voltage:0},{part:"2",number:2,voltage:60},{part:"3",number:3,voltage:0}]});
        async function refine(mode) {
          await backend.invoke("open_pa",{id:mode,path:`${mode}/einzel.pa#`});
          let finish,fail;
          const terminal=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
          const deadline=setTimeout(()=>fail(new Error("refine terminal event deadline")),20000);
          const events=[];
          let job;
          try {
            job=await backend.invoke("refine_start",{request:{id:mode,device:"cpu",voltages:mode==="exact"?[[2,60]]:[],tolerance:1e-10,maxCycles:100},channel:{onmessage(message){
              if(message instanceof ArrayBuffer){events.push({binary:new TextDecoder().decode(new Uint8Array(message,0,4))});return;}
              events.push(message);if(message.type==="error")fail(new Error(message.message));if(message.type==="done")finish(message);
            }}});
            await terminal;
          } finally {clearTimeout(deadline);}
          check(events.filter(e=>e.type==="done").length===1,`${mode}: one done event`);
          check(events.filter(e=>e.type==="stageDone").length===3,`${mode}: three basis stages`);
          check(events.some(e=>e.binary==="SPV1"),`${mode}: live preview`);
          const summary=await backend.invoke("web_refine_summary",{job});
          check(summary.threads===variant.actual,`${mode}: solver uses the reported pool`);
          return summary;
        }
        const modes=[];
        for(const mode of ["staircase","exact"]){
          const refinement=[];
          for(let i=0;i<6;i++)refinement.push(await refine(mode));
          const files={};
          for(const [suffix,reference] of Object.entries(expected[mode].files)){
            const bytes=new Uint8Array(await backend.invoke("read_file",{path:`${mode}/einzel.${suffix}`}));
            check(same(bytes,reference),`${mode}.${suffix}: native byte identity`);files[suffix]=Array.from(bytes);
          }
          const request={id:mode,voltages:mode==="exact"?[]:[[2,60]],source:{kind:"file",path:"ions.ion"},durationUs:10,relativistic:false,precision:"precise",draw:8,surfaces:mode==="exact",plane:[1,0,0,58],tolerance:1e-12,maxStepUs:Number.MAX_VALUE};
          const flights=[];let csv;
          for(let i=0;i<6;i++){
            const packet=await backend.invoke("fly",{request});
            const length=new DataView(packet).getUint32(4,true);
            const header=JSON.parse(new TextDecoder().decode(new Uint8Array(packet,8,length)));
            csv=new Uint8Array(await backend.invoke("web_flight_csv",{id:mode,token:header.token}));
            check(same(csv,expected[mode].csv),`${mode}: native flight CSV byte identity`);
            const summary=await backend.invoke("web_flight_summary",{id:mode,token:header.token});
            check(summary.threads===variant.actual,`${mode}: flyer uses the reported pool`);flights.push(summary);
          }
          const names=await backend.invoke("export_array",{request:{id:mode,path:`${mode}/field.vti`,voltages:request.voltages,what:{kind:"grid",field:true,angularSegments:64,sweepDegrees:360}}});
          check(names[0]==="field.vti",`${mode}: in-memory VTI export`);
          check(await backend.invoke("export_trajectories",{request,path:`${mode}/tracks.vtp`})===8,`${mode}: in-memory VTP export`);
          modes.push({mode,refinement:refinement.slice(1),flights:flights.slice(1),files,csv:Array.from(csv)});
        }
        await backend.invoke("open_pa",{id:"vacuum",path:"vacuum.pa"});
        for(const test of physics){
          const packet=await backend.invoke("fly",{request:test.request});
          const size=new DataView(packet).getUint32(4,true);
          const h=JSON.parse(new TextDecoder().decode(new Uint8Array(packet,8,size)));
          const csv=new Uint8Array(await backend.invoke("web_flight_csv",{id:"vacuum",token:h.token}));
          check(same(csv,test.expected),`${test.kind}: native f64 magnetic/source CSV`);
        }
        backend.dispose();
        document.querySelector("#result").textContent=JSON.stringify({variant,device,assertions,modes:modes.map(({mode,refinement,flights})=>({mode,refineComputeMs:refinement.map(r=>r.compute_ms),flyComputeMs:flights.map(r=>r.compute_ms)}))},null,2);
        return{device,assertions,modes};
      },{variant,input,expected:references[variant.actual],physics});
      assert.equal(errors.length,0,JSON.stringify(errors));
      assert.ok(requests.every(r=>r.method==="GET"&&r.url.startsWith(origin)),"computation contacted a network service");
      for(const mode of result.modes){
        for(const [suffix,bytes] of Object.entries(mode.files))await writeFile(path.join(output,`${variant.name}-${mode.mode}.${suffix}`),Buffer.from(bytes));
        await writeFile(path.join(output,`${variant.name}-${mode.mode}.csv`),Buffer.from(mode.csv));
        mode.sha256={pa0:createHash("sha256").update(Buffer.from(mode.files.pa0)).digest("hex"),csv:createHash("sha256").update(Buffer.from(mode.csv)).digest("hex")};
        delete mode.files;delete mode.csv;
      }
      await page.screenshot({path:path.join(output,`${variant.name}-desktop.png`),fullPage:true});
      await page.setViewportSize({width:375,height:812});
      await page.screenshot({path:path.join(output,`${variant.name}-mobile.png`),fullPage:true});
      report.variants.push({variant,result,errors,requests});
    }catch(error){report.variants.push({variant,errors,requests,error:String(error)});throw error;}
    finally{await page.close();await server.close();}
  }
  report.verdict="PASS";
}catch(error){report.verdict="FAIL";report.error=String(error);throw error;}
finally{await browser.close();await writeFile(path.join(output,"matrix.json"),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report.variants.map(({variant,result})=>({variant:variant.name,threads:result.device.threads,assertions:result.assertions.length})),null,2));
