export const COMPUTER_USE_ERRORS = Object.freeze({
  DISABLED: "COMPUTER_USE_DISABLED",
  REQUIRES_VISION_MODEL: "COMPUTER_USE_REQUIRES_VISION_MODEL",
  OS_PERMISSION_DENIED: "OS_PERMISSION_DENIED",
  APP_APPROVAL_REQUIRED: "APP_APPROVAL_REQUIRED",
  LEASE_NOT_FOUND: "LEASE_NOT_FOUND",
  LEASE_RELEASED: "LEASE_RELEASED",
  STALE_SNAPSHOT: "STALE_SNAPSHOT",
  TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
  CAPABILITY_UNSUPPORTED: "CAPABILITY_UNSUPPORTED",
  ACTION_BLOCKED_BY_POLICY: "ACTION_BLOCKED_BY_POLICY",
  ACTION_REQUIRES_FOREGROUND: "ACTION_REQUIRES_FOREGROUND",
  ACTION_REQUIRES_INPUT_INJECTION_APPROVAL: "ACTION_REQUIRES_INPUT_INJECTION_APPROVAL",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_CRASHED: "PROVIDER_CRASHED",
});

export class ComputerUseError extends Error {
  constructor(code, message, details = {}) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ComputerUseError";
    this.code = code;
    this.details = details;
  }
}

export function computerUseError(code, message, details = {}) {
  return new ComputerUseError(code, message, details);
}

export function serializeComputerUseError(err) {
  if (err instanceof ComputerUseError) {
    return {
      code: err.code,
      message: err.message,
      details: err.details || {},
    };
  }
  return {
    code: COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
    message: err?.message || String(err),
    details: {},
  };
}
