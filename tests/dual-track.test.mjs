import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture, response, call } from './helpers.mjs';
import { uploadView } from '../src/privacy.mjs';
import { Store } from '../src/store.mjs';

const script = (app, source = 'console.log("temporary-tool-ok")', purpose = 'diagnostic') => app.scripts.create({ title: 'test temporary tool', language: 'node', source, purpose, platforms: ['linux'] });
const allow = app => app.store.saveConfig({ repair: { enabled: true }, scripts: { enabled: true } });

test('双轨配置和凭证独立保存，公开配置与日志不泄漏任何一轨Key', t => {
  const { app, dir } = fixture(t); app.store.saveConfig({ model: { apiKey: 'local-private-key' }, onlineModel: { apiKey: 'online-private-key' } });
  const publicConfig = app.store.publicConfig(); assert.equal(publicConfig.model.apiKey, ''); assert.equal(publicConfig.onlineModel.apiKey, ''); assert.equal(publicConfig.onlineModel.hasApiKey, true);
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('private-key'));
  app.store.log('test', 'local-private-key online-private-key'); assert.ok(!fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('private-key'));
  const reloaded = new Store(dir); assert.equal(reloaded.config.model.apiKey, 'local-private-key'); assert.equal(reloaded.config.onlineModel.apiKey, 'online-private-key');
});
test('临时工具可生成；独立脚本开关或自动修复关闭时不能执行', async t => {
  const { app } = fixture(t); const s = script(app); assert.ok(fs.existsSync(path.join(dirOf(app, s.id), 'source.mjs')));
  assert.equal((await app.scripts.run(s.id, { taskId: 'x' })).blocked, true);
  app.store.saveConfig({ scripts: { enabled: true } }); assert.equal((await app.scripts.run(s.id, { taskId: 'x' })).blocked, true); assert.equal(app.scripts.runs.length, 0);
});
function dirOf(app, id) { return path.join(app.store.dir, 'scripts', id); }
test('真实Node脚本在专用目录执行并回传输出和独立探针验证', async t => {
  const { app } = fixture(t); allow(app); const s = script(app, 'console.log(JSON.stringify({message:"tool-ok",cwd:process.cwd()}))');
  const run = await app.scripts.run(s.id, { taskId: 'node-run' }); assert.equal(run.ok, true); assert.equal(run.verified, true); assert.match(run.stdout, /tool-ok/); assert.ok(run.stdout.includes(s.id));
});
test('脚本运行环境不继承模型Key和其他父进程秘密', async t => {
  const { app } = fixture(t); allow(app); process.env.NETWORK_TEST_SECRET = 'parent-private-value'; t.after(() => { delete process.env.NETWORK_TEST_SECRET; });
  const s = script(app, 'console.log(JSON.stringify({custom:process.env.NETWORK_TEST_SECRET,cloud:process.env.NETWORK_ONLINE_API_KEY,local:process.env.NETWORK_MODEL_API_KEY}))');
  const run = await app.scripts.run(s.id, { taskId: 'env-run' }); assert.equal(run.ok, true); assert.deepEqual(JSON.parse(run.stdout), {});
});
test('同故障同内容脚本即便换名称/ID也不重放', async t => {
  const { app } = fixture(t); allow(app); const one = script(app); const two = script(app);
  await app.scripts.run(one.id, { taskId: 'a', incidentId: 'same-incident' }); assert.equal((await app.scripts.run(two.id, { taskId: 'b', incidentId: 'same-incident' })).blocked, true);
});
test('真实无限循环脚本会被超时终止', async t => {
  const { app } = fixture(t); allow(app); app.store.saveConfig({ scripts: { timeoutMs: 500 } }); const s = script(app, 'setInterval(()=>{},1000)');
  const begin = Date.now(); const run = await app.scripts.run(s.id, { taskId: 'timeout' }); assert.equal(run.timedOut, true); assert.equal(run.ok, false); assert.ok(Date.now() - begin < 4000);
});
test('取消信号会终止真实脚本子进程', async t => {
  const { app } = fixture(t); allow(app); const controller = new AbortController(); const s = script(app, 'setInterval(()=>{},1000)');
  const work = app.scripts.run(s.id, { taskId: 'cancel', signal: controller.signal }); const timer = setTimeout(() => controller.abort(), 100); t.after(() => clearTimeout(timer));
  const run = await work; assert.equal(run.cancelled, true); assert.equal(run.ok, false);
});
test('磁盘源码篡改不能绕过审阅哈希执行', async t => {
  const { app } = fixture(t); allow(app); const s = script(app); fs.writeFileSync(path.join(dirOf(app, s.id), 'source.mjs'), 'console.log("changed")');
  await assert.rejects(app.scripts.run(s.id, { taskId: 'tamper' }), /哈希/); assert.equal(app.scripts.runs.at(-1).status, 'failed');
});
test('按脚本确认策略需要批准该不可变版本', async t => {
  const { app } = fixture(t); allow(app); app.store.saveConfig({ scripts: { approval: 'per_script' } }); const s = script(app);
  assert.equal((await app.scripts.run(s.id, { taskId: 'confirm' })).blocked, true); app.scripts.approve(s.id); assert.equal((await app.scripts.run(s.id, { taskId: 'confirm' })).ok, true);
});
test('语义压缩保留先前摘要并保持工具调用配对', async t => {
  let compressedInput; const { app } = fixture(t, { fetcher: async (_u, req) => { compressedInput = JSON.parse(JSON.parse(req.body).messages[1].content); return response(JSON.stringify({ summary: 'keep-failed-action-and-rollback-id', facts: ['DNS'], failedActions: ['flush_dns'], artifacts: ['script-id'], pending: ['verify'] })); } });
  app.store.saveConfig({ agent: { semanticCompact: true }, model: { contextChars: 12000 } });
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'previous-critical-summary' }];
  for (let i=0;i<8;i++) messages.push({ role:'assistant',tool_calls:[call('inspect_network',{},String(i))] },{role:'tool',tool_call_id:String(i),content:'e'.repeat(1800)});
  const result = await app.sessions.compress(messages, { id:crypto.randomUUID(),objective:'restore',plan:[] }, new AbortController().signal);
  assert.equal(result.semantic, true); assert.match(compressedInput.previousContext,/previous-critical-summary/); assert.match(result.messages[1].content,/keep-failed/);
  for(let i=0;i<result.messages.length;i++)if(result.messages[i].role==='tool')assert.ok(result.messages[i-1].tool_calls.some(c=>c.id===result.messages[i].tool_call_id));
});
test('停止钩子在目标缺证据时继续主循环，再由真实工具ID通过判断', async t => {
  let turns=0,judges=0; const {app}=fixture(t,{fetcher:async(_u,req)=>{const b=JSON.parse(req.body);if(b.messages[0].content.includes('独立目标判断器')){judges++;return response(JSON.stringify({satisfied:judges===2,blocked:false,reason:judges===1?'缺少resolver证据':'证据齐全',evidence:judges===2?['resolver-id']:[]}));}turns++;if(turns===1)return response('',[call('inspect_network',{},'first-id')]);if(turns===3)return response('',[call('run_diagnostic',{topic:'resolver'},'resolver-id')]);return response('诊断结论');}});
  app.store.saveConfig({agent:{goalChecks:true}});const task=app.ask('检查resolver并解释');await app.tasks.promises.get(task.id);assert.equal(task.status,'completed');assert.equal(judges,2);assert.equal(turns,4);
});
test('目标判断器引用不存在的工具ID不能宣告成功', async t => {
  const {app}=fixture(t,{fetcher:async(_u,req)=>JSON.parse(req.body).messages[0].content.includes('独立目标判断器')?response('{"satisfied":true,"blocked":false,"reason":"ok","evidence":["invented"]}'):response('已完成')});
  app.store.saveConfig({agent:{goalChecks:true,maxStopChecks:2}});const task=app.ask('diagnose');await app.tasks.promises.get(task.id);assert.equal(task.status,'needs_attention');assert.equal(task.goal.checks,2);
});
test('恢复检查点保留已完成反馈，未提交副作用补未知结果且不执行', async t => {
  const {app}=fixture(t);const id=crypto.randomUUID();const first=call('inspect_network',{},'known');const second=call('run_script',{id:crypto.randomUUID()},'unknown');
  app.sessions.save(id,{mode:'native',messages:[{role:'system',content:'s'},{role:'user',content:'goal'},{role:'assistant',tool_calls:[first,second]}],pending:[first,second],completed:{known:{role:'tool',tool_call_id:'known',content:'actual feedback'}},evidenceIds:['known'],totalTurns:3});
  const result=app.sessions.restore(id);assert.equal(result.messages.find(m=>m.tool_call_id==='known').content,'actual feedback');assert.match(result.messages.find(m=>m.tool_call_id==='unknown').content,/outcomeUnknown/);assert.equal(app.scripts.runs.length,0);
});
test('进程重启后的原任务可自动续跑并保留总轮数', async t => {
  let request;const {app}=fixture(t,{fetcher:async(_u,req)=>{request=JSON.parse(req.body);return response('恢复后完成诊断');}});app.store.saveConfig({agent:{autoResume:true}});
  const id=crypto.randomUUID();app.tasks.items.push({id,kind:'conversation',status:'interrupted',objective:'原始目标',plan:[{title:'原步骤',status:'completed'}],turns:5,totalTurns:5,goal:{condition:'原始目标',checks:0}});
  app.sessions.save(id,{mode:'native',readOnly:false,messages:[{role:'system',content:'old system'},{role:'user',content:'原始目标'}],pending:[],completed:{},evidenceIds:[],totalTurns:5});await app.start();await app.tasks.promises.get(id);
  const task=app.tasks.get(id);assert.equal(task.status,'completed');assert.equal(task.totalTurns,6);assert.equal(task.resumes,1);assert.ok(request.messages.some(m=>m.content?.includes('恢复原会话')));
});
test('长期记忆跨Store重载可检索并保留来源与待核验标志', t => {
  const {app,dir}=fixture(t);app.memory.add({title:'DNS经验',content:'先核对DNS服务器与缓存',source:{taskId:'origin'},verified:false,tags:['dns']});const data=new Store(dir).read('memory.json',[]);assert.equal(data[0].source.taskId,'origin');assert.equal(app.memory.search('DNS 缓存')[0].verified,false);
});
test('复盘脱敏保留私网诊断信息，同时移除Key、密码、MAC和本机身份', t => {
  const {app}=fixture(t);app.store.saveConfig({onlineModel:{apiKey:'cloud-private-key'}});
  const result=uploadView({ip:'192.168.1.1',route:'10.0.0.0/24',password:'private',mac:'aa:bb:cc:dd:ee:ff',log:`cloud-private-key ${os.hostname()} ${os.userInfo().username} password=hidden aa:bb:cc:dd:ee:ff`,stdout:'{"password":"json-credential","api_key":"json-key"}',windows:'AA-BB-CC-DD-EE-FF'},app.store);
  const text=JSON.stringify(result);assert.equal(result.ip,'192.168.1.1');assert.ok(!text.includes('cloud-private-key'));assert.ok(!text.includes('aa:bb'));assert.ok(!text.includes('password=hidden'));assert.equal(result.password,undefined);
  assert.ok(!text.includes('json-credential'));assert.ok(!text.includes('json-key'));assert.ok(!text.includes('AA-BB-CC'));
  assert.match(uploadView({ip:'192.168.1.1'},app.store,'minimal').ip,/PRIVATE_IP/);
});
test('故障未恢复时不请求云端，恢复后用独立模型配置复盘', async t => {
  let requests=0,body;const {app,ctx}=fixture(t,{kind:'dns_failure',fetcher:async(_u,req)=>{requests++;body=JSON.parse(req.body);assert.equal(req.headers.Authorization,'Bearer cloud-test-key');return response('{"summary":"复盘总结","diagnosis":"根因仍需核验","lessons":["核对缓存"],"runbooks":[]}');}});
  app.store.saveConfig({onlineModel:{name:'cloud-model',apiKey:'cloud-test-key'},review:{enabled:true,upload:'auto'}});await app.sensor.sample();const item=app.reviews.enqueue({id:'incident-x',createdAt:new Date(0).toISOString()});await app.reviews.drain();assert.equal(requests,0);
  ctx.kind='healthy';await app.sensor.sample();await app.reviews.drain();assert.equal(requests,1);assert.equal(body.model,'cloud-model');assert.equal(item.status,'completed');assert.equal(app.memory.items.at(-1).verified,false);
});
test('在线复盘失败持久化队列并设置退避，不影响本地采样', async t => {
  const {app}=fixture(t,{fetcher:async()=>new Response('busy',{status:503})});app.store.saveConfig({review:{enabled:true,upload:'auto'}});await app.sensor.sample();const item=app.reviews.enqueue({id:'retry-x',createdAt:new Date(0).toISOString()});await app.reviews.drain();assert.equal(item.status,'failed');assert.ok(item.nextAt>Date.now());assert.equal((await app.sensor.sample()).health.kind,'healthy');assert.equal(app.store.read('reviews.json',[])[0].status,'failed');
});
test('长期方案新脚本不能直接启用；原样已验证恢复脚本可复用，修改版本需重验', async t => {
  const {app,ctx}=fixture(t,{kind:'dns_failure'});allow(app);const source='console.log("repair")';const local=script(app,source,'repair');app.scripts.execute=async()=>{ctx.kind='healthy';return{ok:true,code:0,stdout:'fixture restore',stderr:''};};
  const candidate={title:'DNS恢复',description:'只用于已识别DNS故障',match:{kind:'dns_failure',platform:'linux'},repair:{language:'node',source}};
  const book=app.runbooks.create(candidate,'review-x');assert.throws(()=>app.runbooks.activate(book.id),/尚未/);
  await app.scripts.run(local.id,{taskId:'repair-job',incidentId:'actual-fixture'});assert.equal(app.runbooks.activate(book.id).state,'active');
  const changed=app.runbooks.create({...candidate,repair:{language:'node',source:source+'\n//new version'}},'review-y');assert.throws(()=>app.runbooks.activate(changed.id),/尚未/);
  assert.equal(changed.version,2);assert.equal(changed.previousId,book.id);assert.equal(book.state,'active');
});
test('取消修复脚本并关闭开关后，已关联回滚仍会执行收尾', async t => {
  const {app}=fixture(t,{kind:'dns_failure'});allow(app);const rollback=script(app,'console.log("rollback-finished")','rollback');
  const repair=app.scripts.create({title:'cancel repair',language:'node',source:'setInterval(()=>{},1000)',purpose:'repair',platforms:['linux'],rollbackId:rollback.id});const controller=new AbortController();
  const timer=setTimeout(()=>{app.store.saveConfig({repair:{enabled:false},scripts:{enabled:false}});controller.abort();},100);t.after(()=>clearTimeout(timer));
  const result=await app.scripts.run(repair.id,{taskId:'cancel-with-rollback',signal:controller.signal});assert.equal(result.cancelled,true);assert.equal(result.rollback.ok,true);assert.match(result.rollback.stdout,/rollback-finished/);
});
test('语义压缩服务失败时保留旧摘要和结构化证据，不丢失目标', async t => {
  const {app}=fixture(t,{fetcher:async()=>{throw Error('synthetic compression unavailable');}});app.store.saveConfig({agent:{semanticCompact:true},model:{contextChars:12000}});
  const messages=[{role:'system',content:'system'},{role:'user',content:'critical-previous-constraint'}];for(let i=0;i<8;i++)messages.push({role:'assistant',tool_calls:[call('inspect_network',{},String(i))]},{role:'tool',tool_call_id:String(i),content:'x'.repeat(1800)});
  const result=await app.sessions.compress(messages,{id:crypto.randomUUID(),objective:'original-goal',plan:[]},new AbortController().signal);assert.equal(result.semantic,false);assert.match(result.messages[1].content,/critical-previous-constraint/);assert.match(result.messages[1].content,/original-goal/);
});
test('自动恢复事件排队复盘并分别保存观测事实与在线推测', async t => {
  const {app,ctx}=fixture(t,{kind:'dns_failure',fetcher:async()=>response('{"summary":"合成复盘","diagnosis":"待核验原因","lessons":[],"runbooks":[]}')});app.store.saveConfig({model:{name:''},review:{enabled:true,upload:'auto'}});app.active=true;
  await app.sensor.sample();await app.tasks.promises.get(app.tasks.list().at(-1).id);app.incident.createdAt=new Date(Date.now()-60000).toISOString();ctx.kind='healthy';await app.sensor.sample();assert.equal(app.recoveredPending.length,1);await app.background();
  assert.equal(app.recoveredPending.length,0);assert.equal(app.reviews.items[0].status,'completed');assert.ok(app.memory.items.some(m=>m.verified===true));assert.ok(app.memory.items.some(m=>m.tags.includes('online-review')&&m.verified===false));
});
test('退出时取消在线请求并等待复盘队列落盘', async t => {
  const {app}=fixture(t,{fetcher:async(_u,req)=>new Promise((_resolve,reject)=>req.signal.addEventListener('abort',()=>reject(Error('cancelled on close')),{once:true}))});app.store.saveConfig({review:{enabled:true,upload:'auto'}});await app.sensor.sample();const item=app.reviews.enqueue({id:'close-review',createdAt:new Date(0).toISOString()});
  const pending=app.reviews.drain();await new Promise(resolve=>setImmediate(resolve));await app.close();await pending;assert.equal(item.status,'failed');assert.equal(app.store.read('reviews.json',[])[0].status,'failed');
});
test('异常退出遗留的进程未确认时暂停新动作，确认后仍不重放原脚本', async t => {
  const {app}=fixture(t,{kind:'dns_failure'});allow(app);const s=script(app);app.scripts.runs.push({id:'orphan-run',pid:process.pid,scope:'same-fault',scriptId:s.id,hash:s.hash,status:'interrupted',outcomeUnknown:true});
  assert.equal((await app.repair.execute('flush_dns','test')).blocked,true);assert.equal((await app.scripts.run(s.id,{taskId:'new-task'})).blocked,true);
  app.scripts.acknowledgeRun('orphan-run');assert.equal(app.scripts.liveOrphans().length,0);assert.equal((await app.scripts.run(s.id,{taskId:'next-task',incidentId:'same-fault'})).blocked,true);
});
test('复盘排队后收紧脱敏策略，实际发送视图也会隐藏私网IP', async t => {
  const {app}=fixture(t);await app.sensor.sample();const item=app.reviews.enqueue({id:'privacy-change',createdAt:new Date(0).toISOString()});
  assert.match(JSON.stringify(app.reviews.preview(item.id)),/192\.168\.8/);app.store.saveConfig({review:{privacy:'minimal'}});assert.ok(!JSON.stringify(app.reviews.preview(item.id)).includes('192.168.8'));
});
test('本地巡检可读取延迟统计并在结束后持久化供下次比较', async t => {
  const {app}=fixture(t,{fetcher:async()=>response('巡检完成')});await app.sensor.sample();const task=app.patrolNow();await app.tasks.promises.get(task.id);
  const stats=app.sensor.statistics();assert.equal(stats.latencyMs.average,3);assert.equal(stats.latencyMs.p95,3);assert.ok(app.store.read('patrol.json',{}).metrics.samples>0);assert.equal(task.kind,'patrol');
});

test('小模型虚构工具证据时，停止反馈明确列出实际调用ID而不照抄成功宣告', async t => {
  const {app}=fixture(t,{fetcher:async()=>response(JSON.stringify({satisfied:true,blocked:false,reason:'都做完了',evidence:['latestNetwork']}))});
  const task=app.tasks.start('conversation','执行诊断',async(task,signal)=>{
    const verdict=await app.goals.check(task,'声称已经诊断',[],signal);
    assert.equal(verdict.satisfied,false);assert.match(verdict.reason,/尚未调用任何工具/);assert.match(verdict.reason,/latestNetwork/);return {};
  });await app.tasks.promises.get(task.id);
});

test('主巡检沿用用户轮数预算，超过四轮后仍可结合持久化工具收据完成', async t => {
  let turns=0;const {app}=fixture(t,{fetcher:async(_u,req)=>{const b=JSON.parse(req.body);if(b.messages[0].content.includes('独立目标判断器')){const d=JSON.parse(b.messages[1].content);assert.ok(d.toolReceipts.some(r=>r.tool==='inspect_network'));return response(JSON.stringify({satisfied:true,blocked:false,reason:'已核对',evidence:d.evidenceIds.slice(-1)}));}turns++;return turns<=5?response('',[call('inspect_network',{},'patrol-'+turns)]):response('完成五轮观测后的总结');}});
  app.store.saveConfig({agent:{goalChecks:true}});const task=app.patrolNow();await app.tasks.promises.get(task.id);assert.equal(task.status,'completed');assert.equal(turns,6);assert.equal(app.sessions.load(task.id).receipts.length,5);
});
