import type { FormEvent } from "react";

/**
 * Reads a submitted form's named fields.
 *
 * Credential inputs (username, passwords, TOTP codes) are uncontrolled and read here on submit:
 * password managers such as 1Password write straight into the DOM, which a controlled React
 * input misses (its state stays "") and then wipes on the next render.
 */
export function formValues(e: FormEvent): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(e.currentTarget as HTMLFormElement).forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

/** "123 456" / "123-456" → "123456" */
export const digits = (s = "") => s.replace(/\D/g, "");
