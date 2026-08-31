#!/bin/sh
# Brings the schema up to date, then hands over to the server.
set -e

ATTEMPTS=${GE_DEPLOY_ATTEMPTS:-10}

# `schema_evolution: auto` is the @cap-js/postgres default, so this is an
# incremental migration - safe to run on every start, existing games survive.
until node_modules/.bin/cds-deploy; do
  ATTEMPTS=$((ATTEMPTS - 1))
  if [ "$ATTEMPTS" -le 0 ]; then
    echo "schema deployment failed - giving up" >&2
    exit 1
  fi
  echo "database not ready yet, retrying in 3s ($ATTEMPTS left)" >&2
  sleep 3
done

exec "$@"
