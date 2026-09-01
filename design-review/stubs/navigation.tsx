/** Stand-ins for next/navigation so the real screens render outside Next. */
export function usePathname() {
  return (globalThis as { __DESIGN_PATH?: string }).__DESIGN_PATH ?? "/decisions";
}
export function useRouter() {
  return { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
}
export function useParams() {
  return { orderId: "PO-10382" };
}
export function useSearchParams() {
  return new URLSearchParams();
}
