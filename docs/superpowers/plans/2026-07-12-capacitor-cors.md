# Capacitor CORS Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the Android Capacitor app to create a Railway session and connect to multiplayer presence.

**Architecture:** Preserve the Fastify exact-origin CORS allowlist. Add the native Android and iOS origins to the parsed defaults and to Railway production, then verify from the connected Seeker.

**Tech Stack:** TypeScript, Fastify, Vitest, Railway CLI, Android ADB

## Global Constraints

- Keep exact-origin CORS enforcement.
- Do not rebuild the APK because the failure is server-side.
- Verify the original device-log symptom after deployment.

---

### Task 1: Tested Native Origins

**Files:**
- Modify: `server/src/test/env.test.ts`
- Modify: `server/src/env.ts`

**Interfaces:**
- Consumes: `parseEnv({}).CORS_ORIGINS`
- Produces: default allowlist entries `https://localhost` and `capacitor://localhost`

- [ ] **Step 1: Write the failing test**

Extend the existing default CORS assertion with both native origins.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/env.test.ts --fileParallelism=false`
Expected: FAIL because `https://localhost` and `capacitor://localhost` are absent.

- [ ] **Step 3: Add the native defaults**

Append `https://localhost,capacitor://localhost` to `CORS_ORIGINS` in `server/src/env.ts`.

- [ ] **Step 4: Run tests and build**

Run: `npm test -- src/test/env.test.ts src/test/cors.test.ts --fileParallelism=false && npm run build`
Expected: all selected tests pass and TypeScript exits zero.

- [ ] **Step 5: Commit**

Commit message: `fix: allow Capacitor server sessions`

### Task 2: Railway and Seeker Verification

**Files:**
- Modify: Railway `redline-server` production variable `CORS_ORIGINS`

**Interfaces:**
- Consumes: Capacitor origin `https://localhost`
- Produces: a CORS-authorized `POST /v1/session` and authenticated presence connection

- [ ] **Step 1: Update Railway**

Append `https://localhost` without removing existing origins, then deploy `redline-server`.

- [ ] **Step 2: Verify production CORS**

Send an OPTIONS preflight with `Origin: https://localhost` and assert the matching allow-origin header.

- [ ] **Step 3: Verify on Seeker**

Force-stop and reopen `xyz.redline.game`, then inspect logs for a successful session path and absence of new `/v1/session` CORS errors.

