# OpenClaw Plugin Compatibility Report

Generated: deterministic
Status: PASS

## Summary

| Metric                     | Value |
| -------------------------- | ----- |
| Fixtures                   | 1     |
| High-priority fixtures     | 1     |
| Hard breakages             | 0     |
| Warnings                   | 0     |
| Compatibility suggestions  | 0     |
| Issue findings             | 0     |
| Open issue findings        | 0     |
| Runtime-covered findings   | 0     |
| Runtime-partial findings   | 0     |
| P0 issues                  | 0     |
| P1 issues                  | 0     |
| Open P0 issues             | 0     |
| Open P1 issues             | 0     |
| Live issues                | 0     |
| Live P0 issues             | 0     |
| Compat gaps                | 0     |
| Deprecation warnings       | 0     |
| Inspector gaps             | 0     |
| Open inspector gaps        | 0     |
| Runtime coverage artifacts | 0     |
| Upstream metadata          | 0     |
| Contract probes            | 0     |
| Decision rows              | 0     |

## Triage Overview

| Class               | Count | P0 | Meaning                                                                                                                                                  |
| ------------------- | ----- | -- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| live-issue          | 0     | 0  | Potential runtime breakage in the target OpenClaw/plugin pair. P0 only when it is not a deprecated compat seam.                                          |
| compat-gap          | 0     | -  | Compatibility behavior is needed but missing from the target OpenClaw compat registry.                                                                   |
| deprecation-warning | 0     | -  | Plugin uses a supported but deprecated compatibility seam; keep it wired while migration exists.                                                         |
| inspector-gap       | 0     | -  | Plugin Inspector needs stronger capture/probe evidence before making contract judgments. Runtime-covered rows are proof-backed and not open report work. |
| upstream-metadata   | 0     | -  | Plugin package or manifest metadata should improve upstream; not a target OpenClaw live break by itself.                                                 |
| fixture-regression  | 0     | -  | Fixture no longer exposes an expected seam; investigate fixture pin or scanner drift.                                                                    |

## P0 Live Issues

_none_

## Other Live Issues

_none_

## Compat Gaps

_none_

## Deprecation Warnings

_none_

## Inspector Proof Gaps

_none_

## Runtime-Covered Inspector Gaps

_none_

## Upstream Metadata Issues

_none_

## Hard Breakages

_none_

## Target OpenClaw Compat Records

| Metric                    | Value                                          |
| ------------------------- | ---------------------------------------------- |
| Configured path           | npm:openclaw@2026.9.4                          |
| Status                    | ok                                             |
| Requested version         | latest                                         |
| Resolved version          | 2026.9.4                                       |
| Range eligibility version | 2026.9.4                                       |
| Source                    | npm:openclaw                                   |
| NPM dist-tag              | latest                                         |
| Prepared cache            | hit                                            |
| Compat registry           | -                                              |
| Compat records            | 0                                              |
| Compat status counts      | -                                              |
| Record ids                | -                                              |
| Hook registry             | dist/agent-harness-runtime-BvaKEkqR.d.ts       |
| Hook names                | 42                                             |
| API builder               | dist/agent-harness-runtime-BvaKEkqR.d.ts       |
| API registrars            | 57                                             |
| Captured registration     | dist/agent-harness-runtime-BvaKEkqR.d.ts       |
| Captured registrars       | 57                                             |
| Package metadata          | package.json                                   |
| Plugin SDK exports        | 338                                            |
| Manifest types            | dist/install-security-scan.types-DTKUtHF_.d.ts |
| Manifest fields           | 0                                              |
| Manifest contract fields  | 22                                             |

## Warnings

_none_

## Suggestions To OpenClaw Compat Layer

_none_

## Issue Findings

_none_

## Contract Probe Backlog

_none_

## Fixture Seam Inventory

| Fixture                        | Priority | Seams        | Hooks                                                             | Registrations                                      | Manifest contracts |
| ------------------------------ | -------- | ------------ | ----------------------------------------------------------------- | -------------------------------------------------- | ------------------ |
| openclaw-interaction-bridge-v2 | high     | dynamic-tool | agent_end, before_agent_reply, before_agent_run, before_tool_call | definePluginEntry, registerHttpRoute, registerTool | tools              |

## Decision Matrix

_none_

## Raw Logs

| Fixture                        | Code                   | Level | Message                                                                               | Evidence                                                                                                                                                                                                 | Compat record |
| ------------------------------ | ---------------------- | ----- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| openclaw-interaction-bridge-v2 | seam-inventory         | log   | observed 4 hooks, 3 registrations, and 1 manifest contracts                           | hook:agent_end, hook:before_agent_reply, hook:before_agent_run, hook:before_tool_call, registration:definePluginEntry, registration:registerHttpRoute, registration:registerTool, manifestContract:tools | -             |
| openclaw-interaction-bridge-v2 | hook-names-present     | log   | all observed hooks exist in the target OpenClaw hook registry                         | agent_end, before_agent_reply, before_agent_run, before_tool_call                                                                                                                                        | -             |
| openclaw-interaction-bridge-v2 | api-registrars-present | log   | all observed api.register* calls exist in the target OpenClaw plugin API builder      | registerHttpRoute, registerTool                                                                                                                                                                          | -             |
| openclaw-interaction-bridge-v2 | sdk-exports-present    | log   | all observed plugin SDK imports exist in target OpenClaw package exports              | openclaw/plugin-sdk/plugin-entry                                                                                                                                                                         | -             |
| openclaw-interaction-bridge-v2 | package-metadata       | log   | selected package metadata for plugin contract checks                                  | package.json, openclaw-interaction-bridge-v2, version:1.6.6                                                                                                                                              | -             |
| openclaw-interaction-bridge-v2 | declarative-contracts  | log   | fixture declares manifest contracts that can be checked without executing plugin code | tools                                                                                                                                                                                                    | -             |
