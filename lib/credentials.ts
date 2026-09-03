/**
 * What the operator actually typed, as opposed to what React recorded.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * The sign-in fields are controlled inputs, so their React state and their DOM
 * value are normally the same thing — but only once React has hydrated. Before
 * that the page is server-rendered HTML: it paints, it accepts typing, and
 * every keystroke lands in the DOM with no `onChange` attached to record it.
 * The state stays empty while the field visibly holds an email address.
 *
 * Submitting then sent `{ email: "" }`, and the operator was told **"Email is
 * required"** while looking straight at their own address — an error that
 * contradicts the screen, which is the kind a person cannot act on.
 *
 * Found on the Fly deployment, where the hydration gap is long enough to hit by
 * hand. It is invisible on localhost, which is why every local browser check
 * had passed. A phone on fab-floor signal is the worst case for it, and this
 * app's entire target.
 *
 * ── Why a module ────────────────────────────────────────────────────────────
 * The same reason `conversation.ts` is not inside the screen: this is a rule,
 * and a rule that is only reachable by rendering React is a rule with no test
 * behind it. The component reads the form; this decides what that means.
 */

/** The credentials to submit, and where each came from. */
export interface SubmittedCredentials {
  email: string;
  password: string;
}

/**
 * Prefer what is in the form over what is in React state.
 *
 * The DOM is the authority because it is what the operator can see. State is
 * the fallback for the one case the DOM cannot cover: a browser that submitted
 * without populating `FormData` at all.
 *
 * Email is trimmed — a phone keyboard adds a trailing space readily, and an
 * address with one is rejected by the API for a reason nobody could guess from
 * the screen. The password is **not** trimmed: leading and trailing spaces are
 * legitimate characters in a password, and silently removing them would turn a
 * correct credential into a failed sign-in.
 */
export function submittedCredentials(
  form: Pick<FormData, "get">,
  state: { email: string; password: string },
): SubmittedCredentials {
  const formEmail = String(form.get("email") ?? "").trim();
  const formPassword = String(form.get("password") ?? "");

  return {
    email: formEmail || state.email.trim(),
    password: formPassword || state.password,
  };
}
