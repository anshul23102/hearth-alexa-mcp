# GitHub "About" box

**Description** (under 350 characters):

> Hearth: an Alexa+ add-on (self-hosted MCP server, OAuth 2.1 + PKCE) that tells a household the day a product they own is recalled, and never spends their money without an explicit, undoable yes. Real CPSC and Health Canada recalls, approval codes a model cannot forge, hash-chained audit log, Claude on Amazon Bedrock.

**Website:** the YouTube demo link, once uploaded.

**Topics:**

`mcp` `model-context-protocol` `alexa` `alexa-plus` `oauth2` `pkce` `amazon-bedrock` `claude` `ai-agents` `agent-safety` `product-recalls` `cpsc` `typescript` `nodejs` `sqlite` `accessibility` `hackathon`

Apply with:

```bash
gh repo edit anshul23102/hearth-alexa-mcp --description "$(sed -n '5p' docs/GITHUB_ABOUT.md | sed 's/^> //')" --add-topic mcp,model-context-protocol,alexa,alexa-plus,oauth2,pkce,amazon-bedrock,claude,ai-agents,agent-safety,product-recalls,cpsc,typescript,nodejs,sqlite,accessibility,hackathon
```
