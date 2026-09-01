/**
 * `PLATFORM_CAPABILITIES` — what the landing page says FabOrchestrator does.
 *
 * These tests pin **honesty properties**, not rendering. The landing page lists
 * the capabilities of the wider platform that this demo does not implement, and
 * the only thing standing between that and a fabricated feature grid is that
 * every entry traces to a real document and that none of them pretends to be
 * reachable.
 *
 * The `href` test is the one that matters. Nothing in the type system stops
 * somebody adding one — the interface simply has no such field — and the
 * change that would break this is an obvious and well-meant one: making the
 * cards "clickable for the demo". A card that looks like a door and opens onto
 * nothing is the same dishonesty as a hard-coded severity, which is the failure
 * `featured-order.test.ts` exists to prevent on the other half of this screen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_CAPABILITIES } from "../../lib/capabilities";

test("every capability is complete and carries where it was read from", () => {
  assert.ok(PLATFORM_CAPABILITIES.length > 0, "the platform section would render empty");

  for (const capability of PLATFORM_CAPABILITIES) {
    const where = capability.id || "(no id)";
    assert.match(capability.id, /^[a-z0-9-]+$/, `${where}: id must be a kebab-case slug`);
    assert.ok(capability.title.trim().length > 0, `${where}: needs a title`);
    assert.ok(capability.line.trim().length > 0, `${where}: needs a line`);
    // Not `typeof === "function"`: lucide builds its icons with `forwardRef`,
    // which returns an *object* carrying a `$$typeof` tag. Both shapes are
    // valid React element types; a string or a nullish value is not, and those
    // are what a bad import actually produces.
    assert.ok(
      capability.icon != null &&
        (typeof capability.icon === "function" || typeof capability.icon === "object"),
      `${where}: icon must be a renderable component, got ${typeof capability.icon}`,
    );

    // The claim has to be checkable by a reviewer who does not trust it, which
    // means naming a file or a route — not "the product does this".
    assert.ok(
      capability.source.trim().length > 0,
      `${where}: needs a source, or it is an invented feature`,
    );
    assert.match(
      capability.source,
      /\.md|claudeai_athena|admin_athena|README/,
      `${where}: source must name a document or an app, not assert on its own`,
    );
  }
});

test("ids are unique, so React keys and this test's own messages are stable", () => {
  const ids = PLATFORM_CAPABILITIES.map((capability) => capability.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in [${ids.join(", ")}]`);
});

test("none of them is a link", () => {
  for (const capability of PLATFORM_CAPABILITIES) {
    // `in` rather than a property read: the point is that the field does not
    // exist at all, and `undefined` from a field somebody added and left blank
    // would pass a truthiness check while the card rendered as a door.
    assert.equal(
      "href" in capability,
      false,
      `${capability.id}: none of these is implemented here, so none of them may be a link. ` +
        `If one becomes real, move it into the workflow section instead.`,
    );
  }
});
