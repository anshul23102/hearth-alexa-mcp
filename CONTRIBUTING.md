# Contributing

Thanks for looking. Hearth is small enough to run in a minute.

```bash
npm install
npm test               # all tests, including the end-to-end suite through the official MCP SDK client
npm run typecheck
npm start              # http://localhost:3939
```

Requires Node 22.16+.

## Ground rules

- **Every behaviour has a test.** A fix starts with a test that fails; a security finding needs an attack test in `test/security.test.ts` and a row in [SECURITY.md](SECURITY.md).
- **No dead code and no placeholder data.** If a control is on the page it must call something real; if a number is in the docs, a test or a script produces it.
- **Docs state the real test count.** `npm test` includes a check that README, the Devpost story and the demo script match the suite.
- **The model never gets more authority than the operator granted.** Spend ceilings, approval and erase stay out of its reach.
- Sample data stays labelled synthetic; recall data comes from the regulators' public feeds.

## Where things live

See the repository map in the [README](README.md#repository-map). Product intent is in [PRODUCT.md](PRODUCT.md), the visual system in [DESIGN.md](DESIGN.md).
