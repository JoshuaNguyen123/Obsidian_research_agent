import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  isUnsafeFetchHostV1,
  normalizePublicFetchUrlV1,
  parseIpv4LiteralV1,
} from "../src/tools/fetchHostPolicy";

/**
 * Spellings of 127.0.0.1 and of the LAN that a dotted-quad regex does not
 * match. Every one of these reached the local machine through `web_fetch` and
 * `document_extract` before the policy parsed addresses instead of matching
 * their punctuation.
 */
const LOOPBACK_SPELLINGS_V1 = [
  "127.0.0.1",
  "127.1",
  "127.0.1",
  "2130706433",
  "0x7f000001",
  "0x7f.0x0.0x0.0x1",
  "017700000001",
  "0177.0.0.01",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "[::]",
  "0.0.0.0",
] as const;

const PRIVATE_SPELLINGS_V1 = [
  "10.0.0.5",
  "10.1",
  "192.168.1.1",
  "3232235777", // 192.168.1.1
  "172.16.0.1",
  "169.254.169.254", // cloud instance metadata
  "100.64.0.1", // CGNAT
  "[fd00::1]",
  "[fe80::1]",
  "printer.local",
  "service.internal",
  "localhost",
  "db.localhost",
] as const;

const PUBLIC_HOSTS_V1 = [
  "example.com",
  "en.wikipedia.org",
  "8.8.8.8",
  "1.1.1.1",
  "[2606:4700:4700::1111]",
  "[::ffff:93.184.216.34]",
  "arxiv.org",
] as const;

test("every literal spelling of the loopback interface is refused", () => {
  for (const host of LOOPBACK_SPELLINGS_V1) {
    assert.ok(isUnsafeFetchHostV1(host), `${host} must be refused`);
  }
});

test("private, link-local and carrier-grade NAT ranges are refused", () => {
  for (const host of PRIVATE_SPELLINGS_V1) {
    assert.ok(isUnsafeFetchHostV1(host), `${host} must be refused`);
  }
});

test("ordinary public hosts stay fetchable", () => {
  for (const host of PUBLIC_HOSTS_V1) {
    assert.ok(!isUnsafeFetchHostV1(host), `${host} must stay allowed`);
  }
});

test("IPv4 literals parse the way a resolver reads them", () => {
  assert.equal(parseIpv4LiteralV1("127.0.0.1"), 0x7f000001);
  assert.equal(parseIpv4LiteralV1("127.1"), 0x7f000001);
  assert.equal(parseIpv4LiteralV1("2130706433"), 0x7f000001);
  assert.equal(parseIpv4LiteralV1("0x7f000001"), 0x7f000001);
  assert.equal(parseIpv4LiteralV1("8.8.8.8"), 0x08080808);
  assert.equal(parseIpv4LiteralV1("example.com"), null);
  assert.equal(parseIpv4LiteralV1("1.2.3.4.5"), null);
  // Out of range for its slot: not an address, and not a DNS name either.
  assert.equal(parseIpv4LiteralV1("256.1.1.1"), null);
  assert.ok(isUnsafeFetchHostV1("4294967296"));
});

test("a normalized URL keeps its scheme rules, drops its fragment, and refuses credentials", () => {
  const errors = {
    invalid: "invalid",
    scheme: "scheme",
    credentials: "credentials",
    privateHost: "private",
  };
  const raise = (message: string): never => {
    throw new Error(message);
  };
  assert.equal(
    normalizePublicFetchUrlV1("example.com/a?b=1#frag", errors, raise),
    "https://example.com/a?b=1",
  );
  assert.throws(
    () => normalizePublicFetchUrlV1("file:///etc/passwd", errors, raise),
    /scheme/u,
  );
  assert.throws(
    () => normalizePublicFetchUrlV1("https://user:pw@example.com", errors, raise),
    /credentials/u,
  );
  assert.throws(
    () => normalizePublicFetchUrlV1("http://2130706433:8765/status", errors, raise),
    /private/u,
  );
});

/**
 * Source-level guard: the bypass existed because two tools each owned a copy
 * of the predicate and both copies only understood dotted quads. A third copy
 * would reopen it in whichever tool was written last.
 */
test("fetching tools share the one host policy", () => {
  for (const file of ["src/tools/webTools.ts", "src/tools/documentExtract.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes("normalizePublicFetchUrlV1"),
      `${file} must validate fetch URLs through fetchHostPolicy.ts`,
    );
    assert.ok(
      !/function\s+isUnsafe\w*Host/u.test(source),
      `${file} re-implements the host policy; extend fetchHostPolicy.ts instead`,
    );
  }
});
