import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shared ToolAnnotations for the three safety tiers. openWorldHint is false
 * everywhere: the server only talks to the configured Paperless instance.
 */

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Single-entity deletes: repeating the call does not delete anything further. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Delete-capable bulk/mixed operations (bulk_edit_*, process_mail_account). */
export const DESTRUCTIVE_BULK: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
