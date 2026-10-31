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
  assert.match(minimal, /Status/);
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
  assert.equal(tail.getSnapshot().reasoning.length, 500);
  assert.equal(tail.getSnapshot().tools.length, 8);
  assert.ok(renderLiveTail(tail.getSnapshot()).length < 4096);
});
