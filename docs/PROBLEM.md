# The problem, stated carefully

I am not claiming nobody has ever thought of this. Amazon already shows recall notices on its site, and regulators already
push marketplaces to notify buyers. The claim is narrower, and each part has evidence.

## 1. Recalls are published; owners are not reliably reached
- CPSC's FY2025 Agency Performance Report puts the average correction (response) rate across consumer product recalls at **44.55%**
  against a 43% target, so more than half of recalled units are not remedied. Source: [CPSC FY2025 report](https://www.cpsc.gov/s3fs-public/FY25-APR.pdf).
- CPSC's own staff caution that even this is an imperfect measure (people who bin the product are not counted), and an
  older workshop figure put consumer participation at roughly **6%** (about 4% for products under $20). Older method, different
  definition; I cite it for scale, not as the current rate. Source: [CPSC recall effectiveness workshop report](https://www.cpsc.gov/s3fs-public/Recall_Effectiveness_Workshop_Report-2018.pdf).
- The pressure is landing on marketplaces. In January 2025 CPSC ordered Amazon to notify purchasers directly of recalls
  for 400,000+ hazardous products sold through Fulfilled by Amazon, by email and on "Your Orders". Amazon is contesting the
  order in court; I have not verified the outcome. Source: [CPSC release](https://www.cpsc.gov/Newsroom/News-Releases/2025/CPSC-Issues-Final-Order-to-Amazon-com-Outlining-Remediation-Plans-for-Hazardous-Products).

**Reaching owners is a push problem, not a search problem.** The order that matters is "notify purchasers on the day the recall publishes", so Hearth indexes owners by brand and, when a new notice appears, finds every affected household and pushes to its open session (and stores the alert for the ones that are offline), instead of waiting for someone to ask.

**The hard part is the join.** A recall is free text issued by a regulator in one country ("Foodi OP300 series pressure
cookers"); an order is a marketplace title ("Ninja Foodi 6.5 Qt ... OP302"). Matching them without crying wolf is an entity-resolution
problem across 10,000+ notices, several regulators and retitled listings. Hearth measures this (see [SCALE.md](SCALE.md)):
85.4% of known recalls surfaced, 0% false alerts on an unrelated product of the same brand, 2.1% false "likely" on a wrong model.

## 2. Agents that spend money need a safety layer the platform does not hand you
Alexa+ add-ons are MCP servers; a server that can place orders is a server that can spend a customer's money on a model's
say-so. Vendor-run 2026 surveys report that a majority of consumers are not comfortable with agents purchasing for them
and most expect strong safeguards (Riskified Q1 2026, as reported in search results: 55.0% uncomfortable, 73.9% expecting
safeguards; vendor survey, treat as indicative). I did not find a standard pattern for the basics: propose-then-confirm,
idempotent retries so a flaky network cannot double-order, undo, audit, operator-set ceilings, and tools a model is not
even shown. Hearth ships that pattern, with tests, as a reusable template.

## What this project is, then
A reference implementation of two things an Alexa+ household add-on will need: **owner-level recall matching across
regulators, with honest uncertainty**, and **a safe way for an agent to spend money**. Not a replacement for what Amazon
already does; a measured, open, testable layer that works from order history, in the moment a household is talking to Alexa+.

## What it is not
Not proven on real customers, not integrated with a real storefront or Alexa+ device, and the recall matcher is a heuristic
with a measured error rate, not a safety guarantee. See the limits in [SCALE.md](SCALE.md) and [SECURITY.md](../SECURITY.md).
