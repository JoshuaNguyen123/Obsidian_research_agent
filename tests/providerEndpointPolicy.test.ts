import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackHostnameV1,
  normalizeSecureProviderBaseUrlV1,
  requireSecureProviderBaseUrlV1,
} from "../src/model/providerEndpointPolicy";

test("loopback hostname gate accepts only localhost and 127/::1", () => {
  const cases: Array<{ host: string; allowed: boolean; rule: string }> = [
    { host: "localhost", allowed: true, rule: "localhost is an explicit loopback development host" },
    { host: "LOCALHOST", allowed: true, rule: "loopback host matching is case-insensitive" },
    { host: "::1", allowed: true, rule: "IPv6 loopback is allowed for local development" },
    { host: "[::1]", allowed: true, rule: "bracketed IPv6 loopback is allowed for local development" },
    { host: "127.0.0.1", allowed: true, rule: "IPv4 loopback is allowed for local development" },
    { host: "127.255.255.255", allowed: true, rule: "the entire 127/8 block is loopback" },
    { host: "128.0.0.1", allowed: false, rule: "non-loopback IPv4 must not receive credentials over HTTP" },
    { host: "0.0.0.0", allowed: false, rule: "unspecified IPv4 is not loopback" },
    { host: "example.com", allowed: false, rule: "remote hostnames are not loopback" },
    { host: "127.0.0", allowed: false, rule: "truncated IPv4 is not loopback" },
    { host: "127.0.0.1.example.com", allowed: false, rule: "a loopback prefix on a hostname is not loopback" },
  ];
  for (const { host, allowed, rule } of cases) {
    assert.equal(isLoopbackHostnameV1(host), allowed, rule);
  }
});

test("provider endpoints must be HTTPS, or HTTP only to loopback", () => {
  const cases: Array<{ value: unknown; expected: string | null; rule: string }> = [
    {
      value: "https://api.example.com/v1",
      expected: "https://api.example.com/v1",
      rule: "HTTPS remote endpoints are allowed",
    },
    {
      value: "https://api.example.com/v1/",
      expected: "https://api.example.com/v1",
      rule: "trailing slashes are stripped from HTTPS endpoints",
    },
    {
      value: "http://localhost:11434",
      expected: "http://localhost:11434",
      rule: "plain HTTP is allowed only for loopback development endpoints",
    },
    {
      value: "http://127.0.0.1:11434/api",
      expected: "http://127.0.0.1:11434/api",
      rule: "plain HTTP to IPv4 loopback is allowed",
    },
    {
      value: "http://api.example.com/v1",
      expected: null,
      rule: "plain HTTP to a remote host must not receive credentials",
    },
    {
      value: "https://user:pass@api.example.com/v1",
      expected: null,
      rule: "embedded credentials in the provider URL are rejected",
    },
    {
      value: "ftp://localhost/v1",
      expected: null,
      rule: "non-HTTP(S) schemes cannot carry model credentials",
    },
    {
      value: "  ",
      expected: null,
      rule: "blank endpoints are not a provider URL",
    },
    {
      value: 12,
      expected: null,
      rule: "non-string endpoints are not a provider URL",
    },
  ];
  for (const { value, expected, rule } of cases) {
    assert.equal(normalizeSecureProviderBaseUrlV1(value), expected, rule);
  }
});

test("requireSecureProviderBaseUrlV1 fails closed on an unsafe endpoint", () => {
  assert.equal(
    requireSecureProviderBaseUrlV1("https://ollama.com/api"),
    "https://ollama.com/api",
  );
  assert.throws(
    () => requireSecureProviderBaseUrlV1("http://api.example.com/v1"),
    /HTTPS|localhost|loopback/u,
    "remote HTTP must not be coerced into a usable provider URL",
  );
});
