import { describe, expect, it, vi } from "vitest";
import { KinlockError } from "../errors.js";
import { calculateBackoff, isTransientError, withRetry } from "../retry.js";

describe("packages/sdk/src/retry.ts", () => {
  describe("isTransientError()", () => {
    it("identifies HTTP 429 rate limits as transient", () => {
      expect(isTransientError({ status: 429 })).toBe(true);
      expect(isTransientError({ statusCode: 429 })).toBe(true);
      expect(isTransientError({ response: { status: 429 } })).toBe(true);
      expect(isTransientError(new Error("RPC rate limit exceeded (HTTP 429)"))).toBe(true);
      expect(isTransientError(new Error("Too Many Requests"))).toBe(true);
    });

    it("identifies HTTP 503 and 502/504 as transient", () => {
      expect(isTransientError({ status: 503 })).toBe(true);
      expect(isTransientError({ status: 502 })).toBe(true);
      expect(isTransientError({ status: 504 })).toBe(true);
      expect(isTransientError(new Error("Service Unavailable"))).toBe(true);
    });

    it("identifies socket and network drops as transient", () => {
      expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
      expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
      expect(isTransientError(new Error("fetch failed"))).toBe(true);
      expect(isTransientError(new Error("socket hang up"))).toBe(true);
      expect(isTransientError(new Error("connection reset by peer"))).toBe(true);
    });

    it("treats HTTP 400 Bad Request as non-transient (fails immediately)", () => {
      expect(isTransientError({ status: 400 })).toBe(false);
      expect(isTransientError(new Error("Bad Request (HTTP 400)"))).toBe(false);
      expect(isTransientError(new Error("status code 400"))).toBe(false);
    });

    it("treats 401 Unauthorized and 403 Forbidden as non-transient", () => {
      expect(isTransientError({ status: 401 })).toBe(false);
      expect(isTransientError({ status: 403 })).toBe(false);
      expect(isTransientError(new Error("Unauthorized"))).toBe(false);
    });

    it("treats Kinlock contract logic errors as non-transient", () => {
      const contractErr = new KinlockError("LockNotFound: no lock found", "CONTRACT_ERROR");
      expect(isTransientError(contractErr)).toBe(false);

      const inputErr = new KinlockError("sender is not a valid address", "INVALID_INPUT");
      expect(isTransientError(inputErr)).toBe(false);
    });
  });

  describe("calculateBackoff()", () => {
    it("calculates exponential ceiling with full jitter", () => {
      // Mock random returning 1.0 (maximum jitter bound)
      const maxRandom = () => 1.0;
      expect(calculateBackoff(0, 200, 5000, maxRandom)).toBe(200); // 200 * 2^0
      expect(calculateBackoff(1, 200, 5000, maxRandom)).toBe(400); // 200 * 2^1
      expect(calculateBackoff(2, 200, 5000, maxRandom)).toBe(800); // 200 * 2^2
      expect(calculateBackoff(3, 200, 5000, maxRandom)).toBe(1600); // 200 * 2^3

      // Mock random returning 0.5 (half jitter)
      const halfRandom = () => 0.5;
      expect(calculateBackoff(0, 200, 5000, halfRandom)).toBe(100);
      expect(calculateBackoff(1, 200, 5000, halfRandom)).toBe(200);

      // Capped by maxDelayMs
      expect(calculateBackoff(10, 200, 5000, maxRandom)).toBe(5000);
    });
  });

  describe("withRetry()", () => {
    it("returns result immediately on first attempt if successful", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const result = await withRetry(fn, { sleepFn });
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    });

    it("retries on HTTP 429 rate limit and succeeds on second attempt", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: "Too Many Requests" })
        .mockResolvedValueOnce("recovered");

      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const randomFn = () => 1.0;

      const result = await withRetry(fn, { sleepFn, randomFn });
      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).toHaveBeenCalledWith(200); // attempt 0 max ceiling
    });

    it("retries on transient 503 and network disconnect", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 503, message: "Service Unavailable" })
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce("connected");

      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const randomFn = () => 1.0;

      const result = await withRetry(fn, { sleepFn, randomFn });
      expect(result).toBe("connected");
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenNthCalledWith(1, 200);
      expect(sleepFn).toHaveBeenNthCalledWith(2, 400);
    });

    it("fails immediately on HTTP 400 Bad Request without retrying", async () => {
      const badRequest = { status: 400, message: "Bad Request: malformed JSON" };
      const fn = vi.fn().mockRejectedValue(badRequest);
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      await expect(withRetry(fn, { sleepFn })).rejects.toEqual(badRequest);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    });

    it("fails immediately on contract simulation errors without retrying", async () => {
      const contractError = new KinlockError("LockExpired: lock has expired", "CONTRACT_ERROR");
      const fn = vi.fn().mockRejectedValue(contractError);
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      await expect(withRetry(fn, { sleepFn })).rejects.toThrow(/LockExpired/);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    });

    it("exhausts maxRetries (default 3) and throws the final transient error", async () => {
      const rateLimit = { status: 429, message: "Rate limit exceeded" };
      const fn = vi.fn().mockRejectedValue(rateLimit);
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      await expect(withRetry(fn, { sleepFn })).rejects.toEqual(rateLimit);
      // 1 initial call + 3 retries = 4 total calls
      expect(fn).toHaveBeenCalledTimes(4);
      expect(sleepFn).toHaveBeenCalledTimes(3);
    });

    it("respects custom maxRetries and baseDelayMs options", async () => {
      const rateLimit = { status: 429, message: "Too many calls" };
      const fn = vi.fn().mockRejectedValue(rateLimit);
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const randomFn = () => 1.0;

      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 500, sleepFn, randomFn }),
      ).rejects.toEqual(rateLimit);

      // 1 initial + 2 retries = 3 calls
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenNthCalledWith(1, 500); // 500 * 2^0
      expect(sleepFn).toHaveBeenNthCalledWith(2, 1000); // 500 * 2^1
    });

    it("supports custom shouldRetry predicate", async () => {
      const customError = new Error("CUSTOM_RETRYABLE");
      const fn = vi.fn().mockRejectedValueOnce(customError).mockResolvedValueOnce("custom_ok");
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const result = await withRetry(fn, {
        shouldRetry: (err) => (err as Error).message === "CUSTOM_RETRYABLE",
        sleepFn,
      });

      expect(result).toBe("custom_ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
