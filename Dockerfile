# OpenFC web platform — build the static export, serve it from nginx.
#
# The site is `output: 'export'`, so there is no Node.js runtime in the final
# image: stage 1 produces ./out, stage 2 is just nginx and static files.
#
# Coolify: set the build pack to Dockerfile. No build arguments are required —
# OPENFC_BASE_URL only needs setting on a fork or a preview deploy.

# ---- build ------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Dependencies are cached separately so a source-only change skips npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Absolute URLs baked into /api/v1 (download_url, documentation_url). This is
# the canonical origin, not necessarily the host being served — the site answers
# on several hostnames but must publish one stable set of links.
ARG OPENFC_BASE_URL=https://openfc.dev
ENV OPENFC_BASE_URL=${OPENFC_BASE_URL}

# `npm run build` runs generate-api first, which fails the build if any
# firmware binary does not match its declared SHA-256 in manifest.json. A
# corrupted or mismatched artifact therefore never reaches a deployment.
RUN npm run build

# Fail early and loudly if the export is missing pieces, rather than deploying
# a container that 404s on the API the docs tell people to call.
RUN test -f out/index.html \
 && test -f out/api/v1/firmware/latest.json \
 && test -f out/api/v1/firmware/hashes.json \
 && test -f out/api/v1/firmware/releases.json \
 && test -f out/api/v1/index.json

# ---- serve ------------------------------------------------------------------
FROM nginx:1.27-alpine AS serve

# Drop the packaged default server block; ours replaces it entirely.
RUN rm /etc/nginx/conf.d/default.conf

COPY deploy/nginx.conf            /etc/nginx/conf.d/openfc.conf
COPY deploy/security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY --from=build /app/out        /usr/share/nginx/html

# Surfaces a bad config at build time instead of on a crash-looping deploy.
RUN nginx -t

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
