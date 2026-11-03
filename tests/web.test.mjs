import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './helpers.mjs';
import {startWeb} from '../src/web.mjs';

async function server(t){const f=fixture(t);const web=await startWeb(f.app,{port:0});t.after(()=>web.close());const password=JSON.parse(fs.readFileSync(path.join(f.dir,'web-access.json'),'utf8')).password;const post=(route,data={},cookie='',origin=web.url)=>fetch(web.url+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});return {...f,web,password,post};}
const login=async f=>{const r=await f.post('/api/session',{password:f.password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};

test('网页默认要求登录，凭据不进入页面/公开状态；仅白名单静态文件可读',async t=>{
 const f=await server(t);const html=await(await fetch(f.web.url)).text();assert.match(html,/网页访问密码/);assert.ok(!html.includes(f.password));
 assert.equal((await f.post('/api/rpc',{method:'state',args:[]})).status,401);
 for(const p of ['/runtime/web-access.json','/src/store.mjs','/../package.json'])assert.equal((await fetch(f.web.url+p)).status,404);
 assert.equal(fs.statSync(path.join(f.dir,'web-access.json')).mode&0o777,0o600);
 const cookie=await login(f);const index=await(await fetch(f.web.url,{headers:{Cookie:cookie}})).text();assert.match(index,/web-bridge.js/);assert.match(index,/connect-src 'self'/);
 const r=await f.post('/api/rpc',{method:'state',args:[]},cookie);const state=(await r.json()).data;assert.equal(state.config.model.name,'mock-model');assert.ok(!JSON.stringify(state).includes(f.password));
});
test('跨站请求和未知Host/方法被拒绝，错误密码限速，注销使会话失效',async t=>{
 const f=await server(t);const cookie=await login(f);
 assert.equal((await f.post('/api/rpc',{method:'state',args:[]},cookie,'http://evil.example')).status,403);
 const badHost=await new Promise((resolve,reject)=>{const req=http.get(f.web.url,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(badHost,403);
 assert.equal((await f.post('/api/rpc',{method:'constructor',args:[]},cookie)).status,400);
 await f.post('/api/logout',{},cookie);assert.equal((await f.post('/api/rpc',{method:'state',args:[]},cookie)).status,401);
 for(let i=0;i<5;i++)assert.equal((await f.post('/api/session',{password:'incorrect-password'})).status,401);
 assert.equal((await f.post('/api/session',{password:'incorrect-password'})).status,429);
});
test('网页操作使用同一Engine，配置与探测有反馈，导出隐藏模型凭据',async t=>{
 const f=await server(t);const cookie=await login(f);f.app.store.saveConfig({model:{apiKey:'private-local-model-key'}});
 let r=await f.post('/api/rpc',{method:'saveConfig',args:[{model:{name:'changed-model'}}]},cookie);assert.equal(r.status,200);assert.equal(f.app.store.config.model.name,'changed-model');
 r=await f.post('/api/rpc',{method:'sample',args:[]},cookie);assert.equal((await r.json()).data.health.kind,'healthy');
 r=await f.post('/api/rpc',{method:'export',args:[]},cookie);const data=(await r.json()).data;assert.match(data.filename,/network-report/);assert.ok(!JSON.stringify(data).includes('private-local-model-key'));
 assert.equal(f.ctx.actions.length,0);
});
