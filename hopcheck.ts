import { foBaseUrl } from '@/lib/faborch/client';
const base = foBaseUrl();
const u = new URL(base);
console.log(`  resolved base URL scheme : ${u.protocol}`);
console.log(`  host                     : ${u.host}`);
console.log(`  >>> PWA -> FO transport  : ${u.protocol === 'https:' ? 'TLS' : 'CLEARTEXT'}`);
