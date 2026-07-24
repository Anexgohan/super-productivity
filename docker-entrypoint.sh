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
# SP_SYNC_EMBED_TOKEN_IN_WEBAPP   → embed an access token so browsers arrive
#                                   logged in (requires JWT_SECRET here and
#                                   SP_SYNC_AUTO_PROVISION=true on the server)
# SP_SYNC_ENCRYPTION_PASSWORD     → also embed the E2E passphrase: fully
#                                   zero-entry browsers (trusted-LAN trade-off)
# nginx fronts sync at /sync, so the baseUrl is root-relative. Set an absolute SP_SYNC_SERVER_URL only if sync lives elsewhere.
SP_SYNC_SERVER_URL="${SP_SYNC_SERVER_URL:-/sync}"
if [ -n "${SP_SYNC_SERVER_URL}" ]; then
  JSON=$(echo "$JSON" | jq '.syncProvider |= "SuperSync"')
  JSON=$(echo "$JSON" | jq ".superSync.baseUrl |= \"$SP_SYNC_SERVER_URL\"")

  # Defaults ON: a pre-authenticated browser is the point of this image.
  if [ "${SP_SYNC_EMBED_TOKEN_IN_WEBAPP:-true}" = "true" ]; then
    # Ask the BRIDGE, not the sync server directly. The sync server mints a new
    # JWT per call, and SuperSync keys its lastServerSeq cursor on
    # hash(baseUrl|accessToken) — so a per-restart token made every browser
    # believe it had met a brand-new server, which surfaces as the
    # "Server Already Contains Data" prompt. The bridge persists one token in
    # Postgres and returns the same string across restarts.
    SP_BRIDGE_TOKEN_URL="${SP_BRIDGE_INTERNAL_URL:-http://sp_bridge:1902}/api/internal/webapp-token"
    TOKEN=""
    for _i in 1 2 3 4 5 6 7 8 9 10; do
      TOKEN=$(curl -sf -H "X-Internal-Secret: ${JWT_SECRET}" \
        "$SP_BRIDGE_TOKEN_URL" | jq -r '.token // empty') && \
        [ -n "$TOKEN" ] && break
      echo "sp-entrypoint: token fetch attempt $_i failed; retrying..." >&2
      sleep 2
    done
    if [ -n "$TOKEN" ]; then
      JSON=$(echo "$JSON" | jq ".superSync.accessToken |= \"$TOKEN\"")
      echo "sp-entrypoint: embedded persistent SuperSync access token into web config"
    else
      # No token means no complete override, so SyncAutoSetupService no-ops and
      # already-configured browsers keep working with the credentials they hold.
      # Failing closed here is better than falling back to a freshly minted
      # token, which would reintroduce exactly the rotation this avoids.
      echo "sp-entrypoint: WARNING: could not fetch access token from sp-bridge; serving config without one" >&2
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

# ── Auth gate (anex/container-parity) ────────────────────────────────────────
# Derive the nginx template variables for the session gate. Kept here rather
# than in compose so the template always has both defined: nginx validates the
# whole config at startup, and an unset variable would be a boot failure.
#   SP_AUTH_REQUEST      "/_auth" to enforce sessions, "off" to disable
#   SP_BRIDGE_INTERNAL_URL  where the login page + /api/auth/* are served from
export SP_BRIDGE_INTERNAL_URL="${SP_BRIDGE_INTERNAL_URL:-http://sp_bridge:1902}"
export SP_SYNC_INTERNAL_URL="${SP_SYNC_INTERNAL_URL:-http://sp_supersync:1900}"
if [ "${SP_AUTH_ENABLED:-true}" = "false" ]; then
  export SP_AUTH_REQUEST="off"
  echo "sp-web: auth gate DISABLED (SP_AUTH_ENABLED=false)"
else
  export SP_AUTH_REQUEST="/_auth"
  echo "sp-web: auth gate enabled via ${SP_BRIDGE_INTERNAL_URL}"
fi

# go back to nginx's built-in entrypoint script
exec /docker-entrypoint.sh nginx -g "daemon off;"
