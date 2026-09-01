"use client";

/**
 * The pre-shell skeleton, shown while `useSession` resolves — before there is
 * a user to draw a top nav for. It carries `.fab` itself so the design tokens
 * exist; without it the bars would be styled by nothing at all.
 */

import { Card, SkeletonBar } from "./fab/primitives";

export function PageSkeleton() {
  return (
    <div className="fab min-h-full">
      <div className="mx-auto flex w-full max-w-[var(--page-width)] flex-col gap-4 px-4 py-6">
        <SkeletonBar width={180} height={22} />
        <SkeletonBar width={260} height={14} delayMs={60} />
        {[0, 1, 2].map((i) => (
          <Card key={i} className="flex flex-col gap-3 p-5">
            <SkeletonBar width={130} height={16} delayMs={i * 90} />
            <SkeletonBar width="55%" delayMs={i * 90 + 60} />
            <SkeletonBar width="80%" height={8} delayMs={i * 90 + 120} />
          </Card>
        ))}
      </div>
    </div>
  );
}
