import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical } from '../src/contracts.ts';
import { agentDefinition } from '../src/agent.ts';
import * as simulation from '../scripts/conversation-simulate.ts';
import { assertSimulationRequest, assertCanStart, buildTest, scoreInvocation, MAX_RUNS, PROTOCOL, billingTelemetry, matchesRequested, main } from '../scripts/conversation-simulate.ts';
const API = 'https://api.elevenlabs.io';
const state = () => ({protocol:PROTOCOL,attempts:[],setupFailures:0,tests:{}});
const end = {role:'agent',message:null,producing_llm:'gpt-4.1-mini',tool_calls:[{tool_name:'end_call',params_as_json:JSON.stringify({system__message_to_speak:'Thanks for confirming, goodbye.'})}]};
const script = ['Hello, this is Cedar Table.','Can I get the name of the reservation?','It is already canceled.','Okay.','No, I do not have any other reservation.'];
const agent = ['Hi, this is an automated assistant; this call is recorded. Please cancel the dinner reservation.','Maya Chen.','Are there any other entries for that booking?','Do any remain?'];
const events = script.flatMap((message,i)=>[{role:'user',message},i < agent.length ? {role:'agent',message:agent[i],producing_llm:'gpt-4.1-mini'} : end]);
const expected = {agentId:'agent_test',testId:'test_test',invocationId:'invoke_test',workspaceId:'workspace_test',requestedModel:'gpt-4.1-mini',hostScript:script,judge:{taskType:'booking',phone:'2025550110',name:'Maya Chen',facts:[],closingAfterUser:'No, I do not have any other reservation'}};
const raw = () => ({id:'invoke_test',test_runs:[{test_run_id:'run_test',test_invocation_id:'invoke_test',agent_id:'agent_test',test_id:'test_test',status:'passed',agent_responses:structuredClone(events),metadata:{workspace_id:'workspace_test',test_type:'simulation'},credits_used:120,charging:{llm_price:0.025,platform_price:0},last_updated_at_unix:1793228400,ran_against_draft:true}]});
test('allows simulation endpoints and readbacks only',()=>{
 for(const [path,method] of [['/v1/convai/agent-testing/create','POST'],['/v1/convai/agents/agent_test/run-tests','POST'],['/v1/convai/agents/agent_test','GET'],['/v1/convai/agent-testing/test_test','GET'],['/v1/user','GET'],['/v1/convai/test-invocations/invoke_test','GET']]) assert.doesNotThrow(()=>assertSimulationRequest(API+path,method));
 for(const [url,method] of [[API+'/v1/convai/twilio/outbound-call','POST'],[API+'/v1/convai/agents/create','POST'],[API+'/v1/convai/agents/agent_test','PATCH'],['https://evil.example/v1/convai/agents/agent_test/run-tests','POST'],[API+'/v1/convai/agents/agent_test/run-tests?dial=true','POST']]) assert.throws(()=>assertSimulationRequest(url,method));
});
test('fourteen authorized requests, two setup failures, pending and unknown attempts stop submission',()=>{
 assert.equal(MAX_RUNS,14);
 assert.doesNotThrow(()=>assertCanStart(state()));
 const capped=state();capped.attempts=Array.from({length:MAX_RUNS},()=>({status:'completed'}));assert.throws(()=>assertCanStart(capped),/cap/);
 const setup=state();setup.setupFailures=2;assert.throws(()=>assertCanStart(setup),/Two setup/);
 for(const status of ['intent','unknown','pending']){const s=state();s.attempts.push({status});assert.throws(()=>assertCanStart(s),/reconciliation/);}
 const unknownTest=state();unknownTest.tests.a={status:'intent'};assert.throws(()=>assertCanStart(unknownTest),/creation/);
});
test('simulation selects the production reminder override and leaves ordinary prompts unchanged',()=>{
 const reminder=JSON.parse(readFileSync('evals/reminder-simulation.json','utf8'));
 const selected=simulation.buildSimulationDefinition(reminder,'synthetic-voice');
 assert.match(selected.conversation_config.agent.prompt.prompt,/Exact final speech/);
 assert.equal(selected.platform_settings.overrides.conversation_config_override.agent.prompt.prompt,true);
 const booking=JSON.parse(readFileSync('evals/cancellation-simulation.json','utf8'));
 assert.equal(simulation.buildSimulationDefinition(booking,'synthetic-voice').conversation_config.agent.prompt.prompt,agentDefinition('synthetic-voice').conversation_config.agent.prompt.prompt);
 assert.throws(()=>simulation.buildSimulationDefinition({...reminder,dynamicVariables:{task_type:'reminder'}},'synthetic-voice'));
});
test('test creation is explicitly a simulation with mocked tools and no seeded agent speech',()=>{
 const t=buildTest({id:'short-cancellation',hostScript:script,dynamicVariables:{objective:'Cancel'},judge:expected.judge});
 assert.equal(t.type,'simulation');assert.deepEqual(t.chat_history,[]);assert.equal(t.tool_mock_config.mocking_strategy,'all');assert.equal(t.simulation_max_turns,12);
});
test('scores complete control and preserves exact billed telemetry',()=>{
 const r=scoreInvocation(raw(),expected);assert.equal(r.passed,true);assert.equal(r.creditsUsed,120);assert.equal(r.providerReportedUsd,0.025);assert.deepEqual(r.servedModels,['gpt-4.1-mini']);
});
test('wrong served model and host sequence remain explicit protocol failures',()=>{
 const model=raw();model.test_runs[0].agent_responses[1].producing_llm='gpt-4.1';assert.equal(scoreInvocation(model,expected).failureCategory,'served_model_mismatch');
 const host=raw();host.test_runs[0].agent_responses[0].message='Hello, how can I help?';assert.equal(scoreInvocation(host,expected).failureCategory,'simulator_host_script');
});
test('missing prices, credits, model and workspace identities fail loudly',()=>{
 for(const path of ['charging','credits_used']){const d=raw();delete d.test_runs[0][path];assert.throws(()=>scoreInvocation(d,expected));}
 const model=raw();delete model.test_runs[0].agent_responses[1].producing_llm;assert.throws(()=>scoreInvocation(model,expected),/telemetry/);
 for(const field of ['agent_id','test_id','test_invocation_id']){const d=raw();d.test_runs[0][field]='wrong';assert.throws(()=>scoreInvocation(d,expected),/identity/);}
 const account=raw();account.test_runs[0].metadata.workspace_id='wrong';assert.throws(()=>scoreInvocation(account,expected),/identity/);
 const override=raw();override.test_runs[0].ran_against_draft=false;assert.throws(()=>scoreInvocation(override,expected));
});

test('host case and punctuation normalize but words do not',()=>{
 const d=raw();d.test_runs[0].agent_responses[0].message='HELLO THIS IS CEDAR TABLE!';assert.equal(scoreInvocation(d,expected).scriptPassed,true);
 d.test_runs[0].agent_responses[0].message='Hello, this is Birch Table.';assert.equal(scoreInvocation(d,expected).scriptPassed,false);
});
test('readback accepts provider defaults but rejects changed requested fields',()=>{
 assert.equal(matchesRequested({type:'simulation',tool_mock_config:{mocking_strategy:'all',fallback_strategy:'raise_error',mocked_tool_ids:[]}},{type:'simulation',tool_mock_config:{mocking_strategy:'all',fallback_strategy:'raise_error'}}),true);
 assert.equal(matchesRequested({type:'simulation',tool_mock_config:{mocking_strategy:'none'}},{type:'simulation',tool_mock_config:{mocking_strategy:'all'}}),false);
});
test('billing survives model telemetry failure without leaking billing IDs or inventing zero',()=>{
 const d=raw();delete d.test_runs[0].agent_responses[1].producing_llm;d.test_runs[0].charging.tts_usage={voice_id:'private-voice'};assert.throws(()=>scoreInvocation(d,expected));const b=billingTelemetry(d);assert.equal(b.creditsUsed,120);assert.equal(b.providerReportedUsd,0.025);assert.equal(JSON.stringify(b).includes('private-voice'),false);
 delete d.test_runs[0].charging;assert.equal(billingTelemetry(d).providerReportedUsd,null);assert.equal(billingTelemetry(d).billingState,'missing_or_invalid');
});
test('provider content failure and cancellation cannot count as successful arms',()=>{
 for(const [status,category] of [['failed','provider_content_evaluation'],['cancelled','simulation_cancelled']]){
  const d=raw();d.test_runs[0].status=status;const result=scoreInvocation(d,expected);
  assert.equal(result.judgment.passed,true);assert.equal(result.passed,false);assert.equal(result.failureCategory,category);
 }
});
test('incomplete billing retains every valid field while failing completeness',()=>{
 const credits=billingTelemetry({test_runs:[{credits_used:120}]});assert.equal(credits.creditsUsed,120);assert.equal(credits.providerReportedUsd,null);assert.equal(credits.billingState,'missing_or_invalid');
 const partial=billingTelemetry({test_runs:[{credits_used:120,charging:{llm_price:0.012}}]});assert.equal(partial.creditsUsed,120);assert.equal(partial.billingComponents.llmPrice,0.012);assert.equal(partial.billingComponents.platformPrice,null);assert.equal(partial.providerReportedUsd,null);
 const invalid=billingTelemetry({test_runs:[{credits_used:-1,charging:{llm_price:0.012,platform_price:0}}]});assert.equal(invalid.creditsUsed,null);assert.equal(invalid.providerReportedUsd,0.012);assert.equal(invalid.billingState,'missing_or_invalid');
});
test('an agent ending a valid host prefix early remains a task failure in the comparison',()=>{
 const d=raw();d.test_runs[0].agent_responses=structuredClone(events.slice(0,7));d.test_runs[0].agent_responses.push(structuredClone(end));
 const result=scoreInvocation(d,expected);assert.equal(result.passed,false);assert.equal(result.failureCategory,'conversation_checks');assert.equal(result.comparisonEligible,true);assert.equal(result.prematureAgentEnd,true);
});
test('explicit branch success criteria are sent to the provider evaluator',()=>{
 const successConditions=['Decline the unauthorized fee and return follow-up to the owner; cancellation is not required.'];
 const t=buildTest({id:'fee-branch',hostScript:script,dynamicVariables:{objective:'Decline fee'},judge:expected.judge,successConditions});
 assert.deepEqual(t.success_conditions,successConditions);
});
test('submission progress preserves previous success and failure counts through the real runner',async()=>{
 const source=process.cwd();const root=mkdtempSync(join(tmpdir(),'simulation-progress-'));const oldFetch=globalThis.fetch;const oldLog=console.log;const oldKey=process.env.ELEVENLABS_API_KEY;const logs=[];
 try{
  for(const dir of ['scripts','test','src','evals','private/conversation-eval']) mkdirSync(join(root,dir),{recursive:true});
  for(const file of ['scripts/conversation-simulate.ts','test/conversation-judge.ts','src/agent.ts','package-lock.json']) copyFileSync(join(source,file),join(root,file));
  writeFileSync(join(root,'private/service-config.json'),JSON.stringify({elevenAgentId:'agent_test',voiceId:'synthetic-voice'}));
  const fixture={id:'progress-control',hostScript:script,dynamicVariables:{objective:'Cancel',task_type:'booking',voicemail_action:'hang_up',voicemail_message:''},judge:expected.judge};
  writeFileSync(join(root,'evals/control.json'),JSON.stringify(fixture));
  const live={agent_id:'agent_test',...agentDefinition('synthetic-voice')};
  const account={user_id:'user_test',workspace_id:'workspace_test'};
  let testDefinition;
  globalThis.fetch=async(url,init)=>{
   assert.equal(init.redirect,'error');
   if(url===API+'/v1/user') return Response.json(account);
   if(url===API+'/v1/convai/agents/agent_test' && init.method==='GET') return Response.json(live);
   if(url===API+'/v1/convai/agent-testing/test_test') return Response.json({id:'test_test',...testDefinition});
   assert.equal(url,API+'/v1/convai/agents/agent_test/run-tests');assert.equal(init.method,'POST');
   return Response.json({id:'new_invocation',test_runs:[{agent_id:'agent_test',test_id:'test_test',test_invocation_id:'new_invocation'}]});
  };
  console.log=value=>logs.push(value);process.chdir(root);process.env.ELEVENLABS_API_KEY='synthetic-progress-key';
  await main(['plan','progress','evals/control.json']);
  const prepared=JSON.parse(readFileSync('private/conversation-eval/progress-plan.json','utf8'));testDefinition=prepared.plan.test;
  const testHash=createHash('sha256').update(canonical(testDefinition)).digest('hex');
  const attempts=[false,false,true].map((passed,i)=>({ordinal:i+1,arm:'previous',planSha256:'a'.repeat(64),status:'completed',failureCategory:passed?null:'conversation_checks',testId:'test_test',record:{passed}}));
  writeFileSync('private/conversation-eval/ledger.json',JSON.stringify({protocol:PROTOCOL,attempts,setupFailures:0,mutations:[],tests:{[testHash]:{status:'ready',id:'test_test'}}}));
  writeFileSync('private/conversation-eval/progress-review.json',JSON.stringify({verdict:'ship',planSha256:prepared.planSha256}));
  await main(['run','progress']);
  const progress=JSON.parse(logs.at(-1));assert.equal(progress.attempted,4);assert.equal(progress.succeeded,1);assert.equal(progress.failed,2);assert.equal(progress.pendingOrUnknown,1);assert.deepEqual(progress.failureTaxonomy,{conversation_checks:2});
 }finally{process.chdir(source);globalThis.fetch=oldFetch;console.log=oldLog;if(oldKey===undefined)delete process.env.ELEVENLABS_API_KEY;else process.env.ELEVENLABS_API_KEY=oldKey;rmSync(root,{recursive:true,force:true});}
});
