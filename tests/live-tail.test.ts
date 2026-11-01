import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTailProjection, renderLiveTail } from "../lib/live-tail.ts";

test("live tail tracks tool execution and settles", () => {
  const tail = createLiveTailProjection("run-1");
  assert.equal(tail.accept({activityId:"run-1",sequence:1,source:"telegram",timestamp:100,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}}),true);
  assert.equal(tail.accept({activityId:"run-1",sequence:2,source:"telegram",timestamp:1350,type:"tool-end",toolCallId:"a",toolName:"terminal",result:{},isError:false}),true);
  assert.match(renderLiveTail(tail.getSnapshot()), /1\.3s/);
  assert.equal(tail.accept({activityId:"run-1",sequence:3,source:"telegram",timestamp:1400,type:"agent-settled"}),true);
  assert.match(renderLiveTail(tail.getSnapshot()), /Completed/);
  assert.equal(tail.accept({activityId:"run-1",sequence:4,source:"telegram",timestamp:1500,type:"tool-start",toolCallId:"b",toolName:"ignored",args:{}}),false);
});

test("live tail rejects stale and cross-activity events", () => {
  const tail = createLiveTailProjection("run-1");
  assert.equal(tail.accept({activityId:"other",sequence:1,source:"local",timestamp:1,type:"agent-start"}),false);
  assert.equal(tail.accept({activityId:"run-1",sequence:1,source:"local",timestamp:1,type:"agent-start"}),true);
  assert.equal(tail.accept({activityId:"run-1",sequence:1,source:"local",timestamp:1,type:"agent-start"}),false);
});

test("live tail escapes model content", () => {
  const tail = createLiveTailProjection("run-1");
  tail.accept({activityId:"run-1",sequence:1,source:"telegram",timestamp:1,type:"reasoning-delta",contentIndex:0,delta:"<script>&"});
  assert.match(renderLiveTail(tail.getSnapshot()), /&lt;script&gt;&amp;/);
});

test("live tail respects reasoning, tool, and detail visibility", () => {
  const tail = createLiveTailProjection("run-2");
  tail.accept({activityId:"run-2",sequence:1,source:"telegram",timestamp:1,type:"reasoning-delta",contentIndex:0,delta:"private reasoning"});
  tail.accept({activityId:"run-2",sequence:2,source:"telegram",timestamp:2,type:"assistant-segment",contentIndex:1,text:"intermediate plan",placement:"intermediate"});
  tail.accept({activityId:"run-2",sequence:3,source:"telegram",timestamp:3,type:"tool-start",toolCallId:"x",toolName:"terminal",args:{}});
  const snapshot = tail.getSnapshot();
  const minimal = renderLiveTail(snapshot, {reasoning:"hidden",tools:"hidden",detail:"minimal"});
  assert.doesNotMatch(minimal, /private reasoning|terminal|intermediate plan/);
  assert.match(minimal, /STATUS/);
  const collapsed = renderLiveTail(snapshot, {reasoning:"collapsed",tools:"recent"});
  assert.match(collapsed, /<blockquote expandable>/);
  assert.match(collapsed, /terminal/);
});

test("live tail keeps bounded reasoning and recent tool history", () => {
  const tail = createLiveTailProjection("run-3");
  tail.accept({activityId:"run-3",sequence:1,source:"telegram",timestamp:1,type:"reasoning-delta",contentIndex:0,delta:"x".repeat(6000)});
  for (let i = 0; i < 20; i++) {
    tail.accept({activityId:"run-3",sequence:i+2,source:"telegram",timestamp:i+2,type:"tool-start",toolCallId:String(i),toolName:"tool"+i,args:{}});
  }
  assert.equal(tail.getSnapshot().reasoning.length, 360);
  assert.equal(tail.getSnapshot().tools.length, 20);
  assert.ok(renderLiveTail(tail.getSnapshot()).length < 4096);
});

test("live tail counts duplicate starts and duplicate ends only once", () => {
  const tail = createLiveTailProjection("dedupe");
  const base = {activityId:"dedupe",source:"telegram" as const,timestamp:100};
  tail.accept({...base,sequence:1,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{command:"echo ok"}});
  tail.accept({...base,sequence:2,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}});
  tail.accept({...base,sequence:3,type:"tool-end",toolCallId:"a",toolName:"terminal",result:"done",isError:false});
  tail.accept({...base,sequence:4,type:"tool-end",toolCallId:"a",toolName:"terminal",result:"done",isError:false});
  const state = tail.getSnapshot();
  assert.equal(state.totalTools, 1);
  assert.equal(state.completedTools, 1);
  assert.equal(state.failedTools, 0);
});

test("live tail closes interrupted operations and settles counts", () => {
  const tail = createLiveTailProjection("interrupt");
  for (let i = 0; i < 70; i++) {
    tail.accept({activityId:"interrupt",source:"telegram",timestamp:i+1,sequence:i+1,type:"tool-start",toolCallId:String(i),toolName:"background_job",args:{}});
  }
  tail.accept({activityId:"interrupt",source:"telegram",timestamp:100,sequence:71,type:"agent-settled"});
  const state = tail.getSnapshot();
  assert.equal(state.totalTools, 70);
  assert.equal(state.completedTools, 0);
  assert.equal(state.failedTools, 0);
  assert.equal(state.interruptedTools, 70);
  assert.match(renderLiveTail(state), /0 active/);
});

test("live tail renders compaction and input prompt lifecycle", () => {
  const tail = createLiveTailProjection("phase");
  const common = {activityId:"phase",source:"telegram" as const,timestamp:10};
  tail.accept({...common,sequence:1,type:"compaction-start",reason:"threshold"});
  assert.match(renderLiveTail(tail.getSnapshot()), /Compacting context/);
  tail.accept({...common,sequence:2,type:"compaction-end",reason:"threshold"});
  tail.accept({...common,sequence:3,type:"ui-prompt-start",kind:"confirm",title:"Proceed?"});
  assert.match(renderLiveTail(tail.getSnapshot()), /Proceed\?/);
  tail.accept({...common,sequence:4,type:"ui-prompt-end"});
  assert.doesNotMatch(renderLiveTail(tail.getSnapshot()), /Proceed\?/);
});

test("live tail redacts secrets and retains valid bounded markup", () => {
  const tail = createLiveTailProjection("html");
  tail.accept({activityId:"html",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{command:"echo TOKEN=secret"}});
  tail.accept({activityId:"html",source:"telegram",timestamp:2,sequence:2,type:"tool-update",toolCallId:"a",toolName:"terminal",update:"<hello>&"});
  const output = renderLiveTail(tail.getSnapshot(), {detail:"detailed"});
  assert.doesNotMatch(output, /TOKEN=secret/);
  assert.match(output, /&lt;hello&gt;&amp;/);
  assert.ok(output.length < 4096);
  assert.equal((output.match(/<blockquote expandable>/g) ?? []).length, (output.match(/<\/blockquote>/g) ?? []).length);
});

test("live tail counts completions even when the operation was evicted", () => {
  const tail = createLiveTailProjection("evicted");
  for (let i = 0; i < 70; i++) {
    tail.accept({activityId:"evicted",source:"telegram",timestamp:i+1,sequence:i+1,type:"tool-start",toolCallId:String(i),toolName:"terminal",args:{}});
  }
  tail.accept({activityId:"evicted",source:"telegram",timestamp:100,sequence:71,type:"tool-end",toolCallId:"0",toolName:"terminal",result:"ok",isError:false});
  tail.accept({activityId:"evicted",source:"telegram",timestamp:101,sequence:72,type:"tool-end",toolCallId:"0",toolName:"terminal",result:"ok",isError:false});
  const state = tail.getSnapshot();
  assert.equal(state.totalTools, 70);
  assert.equal(state.completedTools, 1);
  assert.equal(state.failedTools, 0);
});

test("live tail does not restart an evicted operation with the same ID", () => {
  const tail = createLiveTailProjection("evicted-dedupe");
  for (let i = 0; i < 70; i++) {
    tail.accept({activityId:"evicted-dedupe",source:"telegram",timestamp:i+1,sequence:i+1,type:"tool-start",toolCallId:String(i),toolName:"terminal",args:{}});
  }
  tail.accept({activityId:"evicted-dedupe",source:"telegram",timestamp:100,sequence:71,type:"tool-start",toolCallId:"0",toolName:"terminal",args:{}});
  assert.equal(tail.getSnapshot().totalTools, 70);
});

test("interrupted count is correct after a mix of completed and failed operations", () => {
  const tail = createLiveTailProjection("mixed");
  for (let i = 0; i < 3; i++) tail.accept({activityId:"mixed",source:"telegram",timestamp:10+i,sequence:i+1,type:"tool-start",toolCallId:String(i),toolName:"terminal",args:{}});
  tail.accept({activityId:"mixed",source:"telegram",timestamp:20,sequence:4,type:"tool-end",toolCallId:"0",toolName:"terminal",result:"ok",isError:false});
  tail.accept({activityId:"mixed",source:"telegram",timestamp:21,sequence:5,type:"tool-end",toolCallId:"1",toolName:"terminal",result:"failed",isError:true});
  tail.accept({activityId:"mixed",source:"telegram",timestamp:22,sequence:6,type:"agent-settled"});
  const state = tail.getSnapshot();
  assert.equal(state.completedTools, 1);
  assert.equal(state.failedTools, 1);
  assert.equal(state.interruptedTools, 1);
  assert.match(renderLiveTail(state), /0 active/);
  assert.match(renderLiveTail(state), /1 interrupted/);
});

test("credential-bearing URLs and command options are not displayed", () => {
  const tail = createLiveTailProjection("secrets");
  const cmds = ["curl https://alice:password@example.com", "tool --token abc123", "export AWS_SECRET_ACCESS_KEY=abc"];
  cmds.forEach((command, i) => tail.accept({activityId:"secrets",source:"telegram",timestamp:i+1,sequence:i+1,type:"tool-start",toolCallId:String(i),toolName:"terminal",args:{command}}));
  const output = renderLiveTail(tail.getSnapshot(), {detail:"detailed"});
  assert.doesNotMatch(output, /alice:password|abc123|AWS_SECRET_ACCESS_KEY=abc/);
});

test("tool updates preserve the last meaningful preview", () => {
  const tail = createLiveTailProjection("updates");
  tail.accept({activityId:"updates",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}});
  tail.accept({activityId:"updates",source:"telegram",timestamp:2,sequence:2,type:"tool-update",toolCallId:"a",toolName:"terminal",update:"step one"});
  tail.accept({activityId:"updates",source:"telegram",timestamp:3,sequence:3,type:"tool-update",toolCallId:"a",toolName:"terminal",update:{unknown:1}});
  assert.equal(tail.getSnapshot().tools[0]?.update, "step one");
});

test("detailed history does not repeat recent operations", () => {
  const tail = createLiveTailProjection("history");
  for (let i = 0; i < 12; i++) {
    tail.accept({activityId:"history",source:"telegram",timestamp:i*2+1,sequence:i*2+1,type:"tool-start",toolCallId:String(i),toolName:"operation_"+i,args:{}});
    tail.accept({activityId:"history",source:"telegram",timestamp:i*2+2,sequence:i*2+2,type:"tool-end",toolCallId:String(i),toolName:"operation_"+i,result:"ok",isError:false});
  }
  const output = renderLiveTail(tail.getSnapshot(), {detail:"detailed",tools:"recent",reasoning:"hidden"});
  assert.equal((output.match(/operation_11/g) ?? []).length, 1);
  assert.equal((output.match(/operation_10/g) ?? []).length, 1);
});

test("invalid timestamps are ignored", () => {
  const tail = createLiveTailProjection("timestamp");
  assert.equal(tail.accept({activityId:"timestamp",source:"telegram",timestamp:NaN,sequence:1,type:"agent-start"}),false);
  assert.equal(tail.accept({activityId:"timestamp",source:"telegram",timestamp:10,sequence:1,type:"agent-start"}),true);
});

test("reasoning-end preserves previous reasoning segments", () => {
  const tail = createLiveTailProjection("reasoning-switch");
  tail.accept({activityId:"reasoning-switch",source:"telegram",timestamp:1,sequence:1,type:"reasoning-delta",contentIndex:0,delta:"first segment"});
  tail.accept({activityId:"reasoning-switch",source:"telegram",timestamp:2,sequence:2,type:"reasoning-end",contentIndex:1,text:"second segment"});
  const state = tail.getSnapshot();
  assert.match(state.earlierReasoning, /first segment/);
  assert.equal(state.reasoning, "second segment");
});

test("compaction and settlement clear stale interactive prompts", () => {
  const tail = createLiveTailProjection("prompt-clear");
  tail.accept({activityId:"prompt-clear",source:"telegram",timestamp:1,sequence:1,type:"ui-prompt-start",kind:"confirm",title:"Confirm operation"});
  tail.accept({activityId:"prompt-clear",source:"telegram",timestamp:2,sequence:2,type:"compaction-start",reason:"manual"});
  assert.equal(tail.getSnapshot().prompt, undefined);
  tail.accept({activityId:"prompt-clear",source:"telegram",timestamp:3,sequence:3,type:"ui-prompt-start",kind:"input",title:"Enter value"});
  tail.accept({activityId:"prompt-clear",source:"telegram",timestamp:4,sequence:4,type:"agent-settled"});
  assert.equal(tail.getSnapshot().prompt, undefined);
});

test("detailed recent history includes successful tool result previews", () => {
  const tail = createLiveTailProjection("success-preview");
  tail.accept({activityId:"success-preview",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"one",toolName:"terminal",args:{command:"echo hello"}});
  tail.accept({activityId:"success-preview",source:"telegram",timestamp:2,sequence:2,type:"tool-end",toolCallId:"one",toolName:"terminal",result:"hello from command",isError:false});
  const output = renderLiveTail(tail.getSnapshot(), {detail:"detailed",tools:"recent"});
  assert.match(output, /hello from command/);
});

test("status distinguishes failures from interrupted work", () => {
  const tail = createLiveTailProjection("failed-status");
  tail.accept({activityId:"failed-status",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}});
  tail.accept({activityId:"failed-status",source:"telegram",timestamp:2,sequence:2,type:"tool-end",toolCallId:"a",toolName:"terminal",result:"failed",isError:true});
  tail.accept({activityId:"failed-status",source:"telegram",timestamp:3,sequence:3,type:"agent-settled"});
  assert.match(renderLiveTail(tail.getSnapshot()), /Finished with errors/);
});

test("settled Live Tail does not render active-operation sections", () => {
  const tail = createLiveTailProjection("settled-ui");
  tail.accept({activityId:"settled-ui",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"a",toolName:"subagent",args:{task:"work"}});
  tail.accept({activityId:"settled-ui",source:"telegram",timestamp:2,sequence:2,type:"agent-settled"});
  const output = renderLiveTail(tail.getSnapshot(), {detail:"detailed"});
  assert.doesNotMatch(output, /<b>ACTIVE OPERATIONS<\/b>/);
  assert.match(output, /Interrupted/);
});

test("hidden tools also hide ongoing delegated tasks", () => {
  const tail = createLiveTailProjection("hidden-jobs");
  for (let i = 0; i < 4; i++) tail.accept({activityId:"hidden-jobs",source:"telegram",timestamp:i+1,sequence:i+1,type:"tool-start",toolCallId:String(i),toolName:"subagent",args:{task:"hidden work"}});
  const output = renderLiveTail(tail.getSnapshot(), {detail:"detailed",tools:"hidden",reasoning:"hidden"});
  assert.doesNotMatch(output, /ONGOING TASKS|ACTIVE OPERATIONS|subagent/);
});

test("finished operation IDs cannot be completed twice", () => {
  const tail = createLiveTailProjection("duplicate-failure");
  tail.accept({activityId:"duplicate-failure",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}});
  tail.accept({activityId:"duplicate-failure",source:"telegram",timestamp:2,sequence:2,type:"tool-end",toolCallId:"a",toolName:"terminal",result:"failed",isError:true});
  tail.accept({activityId:"duplicate-failure",source:"telegram",timestamp:3,sequence:3,type:"tool-end",toolCallId:"a",toolName:"terminal",result:"success",isError:false});
  assert.equal(tail.getSnapshot().failedTools, 1);
  assert.equal(tail.getSnapshot().completedTools, 0);
});

test("zero timestamp remains the start of the activity", () => {
  const tail = createLiveTailProjection("zero-start");
  tail.accept({activityId:"zero-start",source:"telegram",timestamp:0,sequence:1,type:"agent-start"});
  tail.accept({activityId:"zero-start",source:"telegram",timestamp:5000,sequence:2,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}});
  assert.equal(tail.getSnapshot().startedAt, 0);
  assert.match(renderLiveTail(tail.getSnapshot()), /5s/);
});

test("invalid event sequence numbers do not corrupt ordering", () => {
  const tail = createLiveTailProjection("bad-sequence");
  for (const sequence of [-1, 0.5, NaN, Infinity]) {
    assert.equal(tail.accept({activityId:"bad-sequence",source:"telegram",timestamp:1,sequence,type:"agent-start"}), false);
  }
  assert.equal(tail.accept({activityId:"bad-sequence",source:"telegram",timestamp:2,sequence:1,type:"agent-start"}), true);
});

test("unmatched lifecycle completion does not erase a newer phase", () => {
  const tail = createLiveTailProjection("overlap");
  tail.accept({activityId:"overlap",source:"telegram",timestamp:1,sequence:1,type:"ui-prompt-start",kind:"confirm",title:"Continue?"});
  tail.accept({activityId:"overlap",source:"telegram",timestamp:2,sequence:2,type:"compaction-end",reason:"manual"});
  assert.equal(tail.getSnapshot().phase, "awaiting-input");
  tail.accept({activityId:"overlap",source:"telegram",timestamp:3,sequence:3,type:"compaction-start",reason:"manual"});
  tail.accept({activityId:"overlap",source:"telegram",timestamp:4,sequence:4,type:"ui-prompt-end"});
  assert.equal(tail.getSnapshot().phase, "compacting");
});

test("snapshot modifications cannot mutate internal tool records", () => {
  const tail = createLiveTailProjection("defensive");
  tail.accept({activityId:"defensive",source:"telegram",timestamp:1,sequence:1,type:"tool-start",toolCallId:"a",toolName:"terminal",args:{}});
  const state = tail.getSnapshot();
  state.tools[0]!.name = "tampered";
  state.tools.pop();
  assert.equal(tail.getSnapshot().tools[0]?.name, "terminal");
});

test("non-finite elapsed time does not leak NaN or Infinity into Telegram HTML", () => {
  const tail = createLiveTailProjection("elapsed");
  tail.accept({activityId:"elapsed",source:"telegram",timestamp:1,sequence:1,type:"agent-start"});
  const state = tail.getSnapshot();
  state.updatedAt = Infinity;
  assert.doesNotMatch(renderLiveTail(state), /NaN|Infinity/);
});
