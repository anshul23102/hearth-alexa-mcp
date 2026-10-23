# Where does an order actually go?

**In the demo, nowhere.** The store is simulated (`StoreAdapter`, order references like `SIM-…`): nothing leaves the machine, and nothing is bought.

## What Hearth is, and what it is not
Hearth is an Alexa+ add-on (an MCP server). It is not a store and it is not a marketplace. Its job is the part that is hard and that every store skips:

1. **Knowing the household**: what it buys, how fast it uses things (from the person's own order export), and which of those things have been recalled.
2. **Deciding what to reorder** and getting a *person's* consent for it in a way a prompt-injected model cannot fake.
3. **Handing the decision to whatever can fulfil it**, through one small seam, `StoreAdapter`.

Everything about buying lives behind that seam, so connecting to a real store means writing one adapter, not changing Hearth.

## The connectors, and how real each one is
| Connector | State | What it does |
|---|---|---|
| Simulated store | Default, used in the demo | Makes up an order reference. Nothing is bought. |
| **Amazon cart handoff** (`HEARTH_STORE=amazon-cart`) | Built, tested for the link it builds; **not exercised against a real Amazon account** | After the person approves, Hearth prepares their Amazon cart with Amazon's documented "Add to Cart" link (ASINs and quantities) on the storefront that matches their currency, and the person finishes in Amazon's own checkout. Nothing is bought until they press Place your order there, so Hearth never touches payment. Needs real ASINs, which an Amazon order export contains; the synthetic sample households have made-up ones. |
| Amazon Wallet checkout inside Alexa+ | Not built; not available to us | Amazon says brands integrating through the Alexa+ MCP toolkit will be able to offer checkout with the payment method saved in the customer's Amazon account. That is where an approved restock would complete natively, and where the approval code, the ceilings and the undo matter most. |
| A retailer's own MCP server | Not built | A store that exposes its cart or checkout over MCP would be called by Hearth as a client from a `StoreAdapter`. |

## What does not exist
- **Amazon has no public API that lets a third-party app place a shopper's order.** Its public commerce APIs are for sellers and for affiliate links; the cart link above is the sanctioned way to hand a basket to a shopper.
- **Flipkart: I found no public buyer-side ordering API.** Its published APIs are the Marketplace Seller API (listings, orders and shipments for sellers). A Flipkart connector would need a partner agreement or a cart or deep link, and I have not built one.

## The other real-world link: the order history
Hearth learns from a CSV export of the person's own orders (Amazon provides one through its "Request My Data" tool; the importer reads the usual column names, in any order, with mixed dates and currencies). That, not the order placement, is what ties Hearth to a real household, and it is the part judges can try with their own data.

## Why this split is the right one
A stand-alone app that "orders on your behalf" has to be trusted with credentials and payment. Hearth asks for neither: it holds the memory and the safeguards, and lets the store the person already trusts take the order.
