import * as React from "react";

/** next/link renders an anchor; that is all these screens need from it. */
export default function Link({
  href,
  children,
  ...rest
}: { href: string } & React.ComponentPropsWithoutRef<"a">) {
  return React.createElement("a", { href, ...rest }, children);
}
