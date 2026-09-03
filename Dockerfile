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
# --ignore-scripts on principle: nothing in this tree needs a lifecycle hook to
# build, and a dependency that wants to run one at install time should have to
# say so out loud rather than get it by default.
RUN npm ci --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The barcode scanner's wasm was copied and verified here. Both the scanner and
# the production-order workflow it belonged to were removed on 1 September, and
# `scripts/copy-zxing-wasm.mjs` went with them — so this step referenced a file
# that no longer exists and would have failed the first deploy after that
# change. Removed rather than guarded: there is no scanner left to degrade.

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
