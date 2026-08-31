# Container image for the Docker deployment. The BTP/MTA path is unaffected -
# it uses the `btp` profile, this image uses `docker`.

# ------------------------------------------------------------------- build
FROM node:22-slim AS build
WORKDIR /build

# `cds build` needs the dev tooling (@sap/cds-dk), so install everything.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY db/ db/
COPY srv/ srv/
RUN npx cds build --production --profile docker

# The generated server pulls in the BTP drivers as well. This deployment talks
# to Postgres and authenticates nobody, so neither is needed in the image.
RUN cd gen/srv \
 && npm pkg delete "dependencies.@cap-js/hana" "dependencies.@sap/xssec" \
 && npm pkg delete devDependencies scripts.watch scripts.test scripts.deploy scripts.test:ui

# ----------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    CDS_ENV=docker \
    PORT=4004

WORKDIR /app

COPY --from=build /build/gen/srv/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /build/gen/srv/srv ./srv

# The web client. CAP serves ./app statically - that is what the approuter did
# on BTP. Only the sources, not app/js/package.json (an ESM marker for tests).
COPY app/index.html app/styles.css ./app/
COPY app/js/*.js ./app/js/

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

USER node
EXPOSE 4004
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node_modules/.bin/cds-serve"]
