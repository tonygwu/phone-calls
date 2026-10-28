import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSimulationRequest, assertCanStart, buildTest, scoreInvocation, MAX_RUNS, PROTOCOL, billingTelemetry, matchesRequested } from '../scripts/conversation-simulate.ts';
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
test('twelve requests, two setup failures, pending and unknown attempts stop submission',()=>{
 assert.doesNotThrow(()=>assertCanStart(state()));
 const capped=state();capped.attempts=Array.from({length:MAX_RUNS},()=>({status:'completed'}));assert.throws(()=>assertCanStart(capped),/cap/);
 const setup=state();setup.setupFailures=2;assert.throws(()=>assertCanStart(setup),/Two setup/);
 for(const status of ['intent','unknown','pending']){const s=state();s.attempts.push({status});assert.throws(()=>assertCanStart(s),/reconciliation/);}
 const unknownTest=state();unknownTest.tests.a={status:'intent'};assert.throws(()=>assertCanStart(unknownTest),/creation/);
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
