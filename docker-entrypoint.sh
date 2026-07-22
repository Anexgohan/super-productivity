#!/bin/sh

# Set default port if not provided
: "${APP_PORT:=80}"
export APP_PORT

# Generate ./assets/sync-config-default-override.json from environment variables
JSON="{}"
JSON_PATH=./assets/sync-config-default-override.json
if [ -n "${WEBDAV_BASE_URL}" ]; then
  JSON=$(echo "$JSON" | jq ".webDav.baseUrl |= \"$WEBDAV_BASE_URL\"")
fi
if [ -n "${WEBDAV_USERNAME}" ]; then
  JSON=$(echo "$JSON" | jq ".webDav.userName |= \"$WEBDAV_USERNAME\"")
fi
if [ -n "${WEBDAV_SYNC_FOLDER_PATH}" ]; then
  JSON=$(echo "$JSON" | jq ".webDav.syncFolderPath |= \"$WEBDAV_SYNC_FOLDER_PATH\"")
fi
if [ "$JSON" != "{}" ]; then
  # Change syncProvider if previous variables are set
  JSON=$(echo "$JSON" | jq '.syncProvider |= "WebDAV"')
fi

# ── SuperSync zero-setup (anex/container-parity) ─────────────────────────────
# SP_SYNC_SERVER_URL              → pre-select SuperSync + server URL
# SP_SYNC_EMBED_TOKEN_IN_WEBAPP   → fetch an access token from the sync server's
#                                   internal endpoint (requires JWT_SECRET and
#                                   SP_SYNC_AUTO_PROVISION=true on the server)
#                                   and embed it: browsers arrive logged in
# SP_SYNC_ENCRYPTION_PASSWORD     → also embed the E2E passphrase: fully
#                                   zero-entry browsers (trusted-LAN trade-off)
if [ -n "${SP_SYNC_SERVER_URL}" ]; then
  JSON=$(echo "$JSON" | jq '.syncProvider |= "SuperSync"')
  JSON=$(echo "$JSON" | jq ".superSync.baseUrl |= \"$SP_SYNC_SERVER_URL\"")

  if [ "${SP_SYNC_EMBED_TOKEN_IN_WEBAPP}" = "true" ]; then
    SP_SYNC_INTERNAL_URL="${SP_SYNC_INTERNAL_URL:-http://supersync:1900}"
    TOKEN=""
    for _i in 1 2 3 4 5; do
      TOKEN=$(curl -sf -X POST -H "X-Internal-Secret: ${JWT_SECRET}" \
        "${SP_SYNC_INTERNAL_URL}/api/internal/token" | jq -r '.token // empty') && \
        [ -n "$TOKEN" ] && break
      echo "sp-entrypoint: token fetch attempt $_i failed; retrying..." >&2
      sleep 2
    done
    if [ -n "$TOKEN" ]; then
      JSON=$(echo "$JSON" | jq ".superSync.accessToken |= \"$TOKEN\"")
      echo "sp-entrypoint: embedded SuperSync access token into web config"
    else
      echo "sp-entrypoint: WARNING: could not fetch access token; browsers will need manual token entry" >&2
    fi
  fi

  if [ -n "${SP_SYNC_ENCRYPTION_PASSWORD}" ]; then
    JSON=$(echo "$JSON" | jq ".superSync.encryptKey |= \"$SP_SYNC_ENCRYPTION_PASSWORD\"")
    JSON=$(echo "$JSON" | jq '.superSync.isEncryptionEnabled |= true')
  fi
fi
if [ -n "${SYNC_INTERVAL}" ]; then
  JSON=$(echo "$JSON" | jq ".syncInterval |= $(expr $SYNC_INTERVAL \* 60000)")
fi
if [ -n "${IS_COMPRESSION_ENABLED}" ]; then
  JSON=$(echo "$JSON" | jq ".isCompressionEnabled |= $IS_COMPRESSION_ENABLED")
fi
if [ -n "${IS_ENCRYPTION_ENABLED}" ]; then
  JSON=$(echo "$JSON" | jq ".isEncryptionEnabled |= $IS_ENCRYPTION_ENABLED")
fi
if [ "$JSON" != "{}" ]; then
  # Write the resultant json
  echo "$JSON" >$JSON_PATH
fi

# go back to nginx's built-in entrypoint script
exec /docker-entrypoint.sh nginx -g "daemon off;"
