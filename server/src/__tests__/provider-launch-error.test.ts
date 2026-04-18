import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMiniMaxRuntimeFailure,
  serializeProviderLaunchError,
  tryDeserializeProviderLaunchError
} from "../services/provider-launch-error.js";

test("provider launch error normalizer treats MiniMax 529 as transient runtime error", () => {
  const error = normalizeMiniMaxRuntimeFailure({
    status: 529,
    message: "overloaded_error"
  });

  assert.ok(error);
  assert.equal(error?.code, "PROVIDER_UPSTREAM_TRANSIENT_ERROR");
  assert.equal(error?.category, "runtime");
  assert.equal(error?.retryable, true);
  assert.equal(error?.details?.status, 529);
});

test("provider launch error normalizer treats MiniMax timeout as transient runtime error", () => {
  const error = normalizeMiniMaxRuntimeFailure({
    code: "ETIMEDOUT",
    message: "request timed out"
  });

  assert.ok(error);
  assert.equal(error?.code, "PROVIDER_UPSTREAM_TRANSIENT_ERROR");
  assert.equal(error?.retryable, true);
  assert.equal(error?.details?.code, "ETIMEDOUT");
});

test("provider launch error normalizer ignores MiniMax context window style errors", () => {
  const error = normalizeMiniMaxRuntimeFailure({
    status: 400,
    message: "invalid_request_error (2013): context window exceeds limit"
  });

  assert.equal(error, undefined);
});

test("provider launch error serializer round-trips transient errors", () => {
  const normalized = normalizeMiniMaxRuntimeFailure({
    status: 503,
    message: "service unavailable"
  });
  assert.ok(normalized);

  const roundTrip = tryDeserializeProviderLaunchError(serializeProviderLaunchError(normalized));
  assert.ok(roundTrip);
  assert.equal(roundTrip?.code, "PROVIDER_UPSTREAM_TRANSIENT_ERROR");
  assert.equal(roundTrip?.retryable, true);
  assert.equal(roundTrip?.details?.status, 503);
});
