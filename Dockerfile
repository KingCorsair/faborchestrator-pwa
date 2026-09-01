# Production image for the PWA demo.
#
# Three stages so the shipped layer carries no build toolchain and no dev
# dependencies. `next.config.ts` sets `output: "standalone"`, which is what
# makes the last stage small: Next traces the modules actually reached and
# emits a self-contained `server.js`.
#
# Build and run locally exactly as Fly will:
#   docker build -t faborch-demo . && docker run -p 3000:3000 --env-file .env faborch-demo

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts because `postinstall` runs scripts/copy-zxing-wasm.mjs,
# which does not exist yet at this layer — only the manifests are copied, so
# that the dependency layer caches independently of source changes. The copy
# happens explicitly in the builder below.
RUN npm ci --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The scanner's wasm. CLAUDE.md flags this as a live deployment risk: the file
# is gitignored and written by a lifecycle script, so a host that skips scripts
# ships an app whose scanner silently falls back to manual entry. `test -f`
# turns that silent degradation into a failed build, which is the only place
# it is cheap to notice.
RUN node scripts/copy-zxing-wasm.mjs \
 && test -f public/zxing/zxing_reader.wasm

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# The standalone server reads both of these. HOSTNAME must be 0.0.0.0 — the
# default binds loopback only, which inside a container means the host's health
# check never connects and the deploy rolls back with no useful error.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
