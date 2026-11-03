#!/usr/bin/env bash
# Publishes the built site. The pipeline runs this only when the CATALOG_DEPLOY variable is "true".
# $1 is the folder holding the built site.
set -euo pipefail

SITE_DIR="${1:?Usage: deploy.sh <site folder>}"

# Replace these lines with your own upload command, for example:
#   aws s3 sync "$SITE_DIR" s3://your-bucket --delete
#   rsync -a --delete "$SITE_DIR/" deploy@your-server:/var/www/catalog/
echo "deploy.sh has no deployment command yet, so $SITE_DIR was not published." >&2
exit 1
