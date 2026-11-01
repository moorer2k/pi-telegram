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
  assert.equal(state.failedTools, 70);
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
