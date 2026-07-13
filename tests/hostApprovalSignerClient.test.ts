import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createHostApprovalReceiptEvidenceV1,
  sealHostApprovalReceiptV1,
} from "../packages/core-api/src/hostApprovalReceiptV1";
import {
  CompanionCoordinatorClientErrorV1,
  CompanionCoordinatorClientV1,
} from "../packages/headless-runtime/src/companionCoordinatorClient";
import { createSessionBootstrapTokenLeaseV1 } from "../packages/headless-runtime/src/backgroundContinuation";

interface HmacVector {
  name: string;
  keyHex: string;
  evidenceFingerprint: string;
  signingKeyFingerprint: string;
  authenticator: string;
}

const TOKEN = "host-approval-client-bootstrap-token-0123456789abcdef";
const vectors = JSON.parse(
  readFileSync(
    new URL("../companion/tests/host_approval_hmac_vectors.json", import.meta.url),
    "utf8",
  ),
) as HmacVector[];

test("TypeScript and Python share the exact host-approval HMAC vector", () => {
  assert.equal(vectors.length, 1);
  const vector = vectors[0];
  const key = Buffer.from(vector.keyHex, "hex");
  assert.equal(
    `sha256:${createHash("sha256").update(key).digest("hex")}`,
    vector.signingKeyFingerprint,
    vector.name,
  );
  assert.equal(
    createHmac("sha256", key)
      .update(vector.evidenceFingerprint, "ascii")
      .digest("base64url"),
    vector.authenticator,
    vector.name,
  );
});

test("headless client describes, seals, and verifies through authenticated closed endpoints", async () => {
  const vector = vectors[0];
  const key = Buffer.from(vector.keyHex, "hex");
  const evidence = createHostApprovalReceiptEvidenceV1({
    id: "approval-client-1",
    preparedActionId: "prepared-client-1",
    preparedActionFingerprint: fp("a"),
    confirmationOrdinal: 1,
    requiredConfirmations: 2,
    decision: "approved",
    hostInstanceFingerprint: fp("b"),
    actorFingerprint: fp("c"),
    sessionFingerprint: fp("d"),
    decidedAt: "2026-07-13T12:00:00.000Z",
  });
  const requestBodies: string[] = [];
  const paths: string[] = [];
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18771",
    credential: createSessionBootstrapTokenLeaseV1(TOKEN),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(new Headers(init?.headers).get("cache-control"), "no-store");
      assert.equal(init?.cache, "no-store");
      const body = typeof init?.body === "string" ? init.body : "";
      if (body) requestBodies.push(body);

      if (url.pathname === "/host-approval-signer") {
        return jsonResponse({
          version: 1,
          kind: "host_approval_signer",
          persistent: true,
          provisioned: true,
          backend: "fake-os-keyring",
          signingKeyFingerprint: vector.signingKeyFingerprint,
        });
      }
      if (url.pathname === "/host-approval-signer/provision") {
        assert.deepEqual(JSON.parse(body), { version: 1 });
        return jsonResponse({
          version: 1,
          kind: "host_approval_signer",
          persistent: true,
          provisioned: true,
          backend: "fake-os-keyring",
          signingKeyFingerprint: vector.signingKeyFingerprint,
        });
      }
      if (url.pathname === "/host-approval-signer/sign") {
        const request = JSON.parse(body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(request).sort(), ["evidence", "version"]);
        assert.deepEqual(request.evidence, evidence);
        return jsonResponse(sealHostApprovalReceiptV1(evidence, {
          signingKeyFingerprint: vector.signingKeyFingerprint,
          authenticator: createHmac("sha256", key)
            .update(evidence.evidenceFingerprint, "ascii")
            .digest("base64url"),
        }));
      }
      if (url.pathname === "/host-approval-signer/verify") {
        const request = JSON.parse(body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(request).sort(), ["receipt", "version"]);
        return jsonResponse({
          version: 1,
          verified: true,
          reason: "verified",
          signingKeyFingerprint: vector.signingKeyFingerprint,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  assert.equal((await client.describeHostApprovalSigner()).provisioned, true);
  assert.equal((await client.provisionHostApprovalSigner()).persistent, true);
  const receipt = await client.sealHostApprovalReceipt(evidence);
  assert.equal(receipt.signingKeyFingerprint, vector.signingKeyFingerprint);
  assert.equal((await client.verifyHostApprovalReceipt(receipt)).verified, true);
  assert.deepEqual(paths, [
    "GET /host-approval-signer",
    "POST /host-approval-signer/provision",
    "POST /host-approval-signer/sign",
    "POST /host-approval-signer/verify",
  ]);
  assert.equal(requestBodies.some((body) => body.includes(vector.keyHex)), false);
  assert.equal(requestBodies.some((body) => body.includes(TOKEN)), false);
});

test("headless sealer rejects denied evidence locally and strict response parsing rejects extras", async () => {
  let requests = 0;
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18772",
    credential: createSessionBootstrapTokenLeaseV1(TOKEN),
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({
        version: 1,
        kind: "host_approval_signer",
        persistent: true,
        provisioned: true,
        backend: "fake-os-keyring",
        signingKeyFingerprint: fp("e"),
        unexpected: true,
      });
    },
  });
  const denied = createHostApprovalReceiptEvidenceV1({
    id: "approval-client-denied",
    preparedActionId: "prepared-client-1",
    preparedActionFingerprint: fp("a"),
    confirmationOrdinal: 1,
    requiredConfirmations: 1,
    decision: "denied",
    hostInstanceFingerprint: fp("b"),
    actorFingerprint: fp("c"),
    sessionFingerprint: fp("d"),
    decidedAt: "2026-07-13T12:00:00.000Z",
  });
  await assert.rejects(
    client.sealHostApprovalReceipt(denied),
    (error: unknown) => {
      assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
      assert.equal(error.code, "invalid_request");
      return true;
    },
  );
  assert.equal(requests, 0);

  await assert.rejects(
    client.describeHostApprovalSigner(),
    (error: unknown) => {
      assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
  assert.equal(requests, 1);
});

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
