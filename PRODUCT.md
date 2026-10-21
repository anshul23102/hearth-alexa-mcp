# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
INFERRED (no interview; owner asked to proceed without questions). Primary: a household's main shopper, in the kitchen, talking to Alexa+ with hands busy. Secondary: hackathon judges (Amazon Devices/Alexa/AWS staff) evaluating in ~3 minutes via a demo video and a locally run repo.

## Product Purpose
Hearth is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) that gives Alexa+ durable household memory: it learns consumption pace from messy order history, warns before things run out, checks owned appliances against live CPSC recalls, and proposes restocks that only execute after an explicit yes, with idempotent retry and undo. The web simulator is a real MCP client standing in for the gated Alexa+ device tooling.

## Positioning
Not a Q&A wrapper: stateful across sessions, honest about uncertainty (± windows, confidence, "possible" vs "likely" recall matches), and safe by construction (propose, confirm, undo, audit). Only possible because it reasons over the user's own purchase history plus live public recall data.

## Operating Context
Voice-first, glanceable screen on a kitchen counter, often evening light. Input data is a messy order-history CSV export. Judges run it locally; there is no real Alexa+ device or Amazon storefront access, so purchasing is a simulated StoreAdapter.

## Capabilities and Constraints
Tools: import_order_history, household_runway, check_recalls, plan_restock, confirm_restock, undo_restock, remember_preference, activity_log. MCP Apps view at ui://hearth/runway. OAuth 2.1 + PKCE account linking. Sample data is SYNTHETIC; recall data is real (CPSC). No real purchases. Alexa+ add-on certification tooling is partner-only and out of scope.

## Evidence on Hand
Real: live CPSC recall API responses (SharkNinja Foodi OP300 series recall, Cuisinart blender recall). Synthetic: data/sample-orders.csv. Absent: any Amazon customers, benchmarks, or user studies; never claim them.

## Product Principles
1. Never act on a guess: plan, read back, confirm, and keep undo available.
2. Show uncertainty instead of false precision.
3. Spoken reply is one or two sentences; detail lives on screen.
4. Every action is auditable.
