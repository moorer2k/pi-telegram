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
