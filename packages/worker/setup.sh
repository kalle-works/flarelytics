#!/usr/bin/env bash
set -e

# -------------------------------------------------------
# Flarelytics Worker Setup
# -------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_header() {
  echo ""
  echo "-------------------------------------------------------"
  echo "  $1"
  echo "-------------------------------------------------------"
}

print_step() {
  echo ""
  echo ">> $1"
}

# -------------------------------------------------------
# 1. Check prerequisites
# -------------------------------------------------------

print_header "Checking prerequisites"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' is not available. Please install it and re-run."
    exit 1
  fi
  echo "  ok  $1"
}

check_cmd node
check_cmd npx

# wrangler may not be globally installed, but npx can run it
if ! npx wrangler --version &>/dev/null 2>&1; then
  echo "ERROR: 'wrangler' could not be invoked via npx. Run 'npm install' first."
  exit 1
fi
echo "  ok  wrangler (via npx)"

# openssl is used for key generation
if ! command -v openssl &>/dev/null; then
  echo "ERROR: 'openssl' is not available. Please install it and re-run."
  exit 1
fi
echo "  ok  openssl"

# -------------------------------------------------------
# 2. Collect configuration
# -------------------------------------------------------

print_header "Configuration"

echo ""
echo "  Find your Account ID at:"
echo "  dash.cloudflare.com -> any zone -> Overview sidebar"
echo ""
read -p "  Cloudflare Account ID: " CF_ACCOUNT_ID

if [[ -z "$CF_ACCOUNT_ID" ]]; then
  echo "ERROR: Account ID is required."
  exit 1
fi

echo ""
echo "  Comma-separated list of origins that will send events."
echo "  e.g. https://mysite.com,http://localhost:3000"
echo ""
read -p "  Allowed origins: " ALLOWED_ORIGINS

if [[ -z "$ALLOWED_ORIGINS" ]]; then
  echo "ERROR: At least one allowed origin is required."
  exit 1
fi

echo ""
echo "  Name used for the Analytics Engine dataset and worker."
echo "  Press Enter to accept the default."
echo ""
read -p "  Dataset name [flarelytics]: " DATASET_NAME
DATASET_NAME="${DATASET_NAME:-flarelytics}"

# -------------------------------------------------------
# 3. Generate wrangler.toml
# -------------------------------------------------------

print_header "Generating wrangler.toml"

EXAMPLE_FILE="$SCRIPT_DIR/wrangler.toml.example"
OUTPUT_FILE="$SCRIPT_DIR/wrangler.toml"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "ERROR: wrangler.toml.example not found at $EXAMPLE_FILE"
  exit 1
fi

sed \
  -e "s|dataset = \"flarelytics\"|dataset = \"$DATASET_NAME\"|g" \
  -e "s|ALLOWED_ORIGINS = \"https://yoursite.com,http://localhost:4321\"|ALLOWED_ORIGINS = \"$ALLOWED_ORIGINS\"|g" \
  -e "s|DATASET_NAME = \"flarelytics\"|DATASET_NAME = \"$DATASET_NAME\"|g" \
  "$EXAMPLE_FILE" > "$OUTPUT_FILE"

# Inject account_id after the name line
if ! grep -q "^account_id" "$OUTPUT_FILE"; then
  sed -i.bak "s|^name = \"flarelytics\"|name = \"$DATASET_NAME\"\naccount_id = \"$CF_ACCOUNT_ID\"|" "$OUTPUT_FILE"
  rm -f "$OUTPUT_FILE.bak"
fi

echo "  Written: $OUTPUT_FILE"

# -------------------------------------------------------
# 4. Deploy the worker
# -------------------------------------------------------

print_header "Deploying worker"

cd "$SCRIPT_DIR"
npx wrangler deploy

# -------------------------------------------------------
# 5. Generate and set QUERY_API_KEY
# -------------------------------------------------------

print_header "Setting secrets"

print_step "Generating QUERY_API_KEY..."
QUERY_API_KEY=$(openssl rand -hex 16)
echo "$QUERY_API_KEY" | npx wrangler secret put QUERY_API_KEY
echo "  QUERY_API_KEY set."

# -------------------------------------------------------
# 6. Set CF_API_TOKEN
# -------------------------------------------------------

echo ""
echo "  A Cloudflare API token is needed so the worker can query Analytics Engine."
echo "  Required permissions: Account > Account Analytics > Read"
echo "  Create one at: dash.cloudflare.com/profile/api-tokens"
echo ""
read -p "  CF_API_TOKEN: " CF_API_TOKEN

if [[ -z "$CF_API_TOKEN" ]]; then
  echo "ERROR: CF_API_TOKEN is required."
  exit 1
fi

echo "$CF_API_TOKEN" | npx wrangler secret put CF_API_TOKEN
echo "  CF_API_TOKEN set."

# -------------------------------------------------------
# 7. Set CF_ACCOUNT_ID as a secret
# -------------------------------------------------------

echo "$CF_ACCOUNT_ID" | npx wrangler secret put CF_ACCOUNT_ID
echo "  CF_ACCOUNT_ID set."

# -------------------------------------------------------
# 8. Smoke test /health
# -------------------------------------------------------

print_header "Testing worker"

# Derive the worker subdomain from the name in wrangler.toml
WORKER_SUBDOMAIN=$(grep '^name' "$OUTPUT_FILE" | head -1 | sed 's/name = "\(.*\)"/\1/')
HEALTH_URL="https://${WORKER_SUBDOMAIN}.workers.dev/health"

print_step "Requesting $HEALTH_URL ..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" || echo "000")

if [[ "$HTTP_STATUS" == "200" ]]; then
  HEALTH_BODY=$(curl -s --max-time 10 "$HEALTH_URL" || echo "")
  echo "  Status: $HTTP_STATUS"
  echo "  Response: $HEALTH_BODY"
else
  echo "  WARNING: Health check returned HTTP $HTTP_STATUS"
  echo "  The worker may still be propagating. Check manually:"
  echo "  curl $HEALTH_URL"
fi

# -------------------------------------------------------
# 9. Summary
# -------------------------------------------------------

print_header "Setup complete"

echo ""
echo "  Worker URL:  https://${WORKER_SUBDOMAIN}.workers.dev"
echo "  QUERY_API_KEY:  $QUERY_API_KEY"
echo ""
echo "  Save the API key — it will not be shown again."
echo ""
echo "-------------------------------------------------------"
echo "  Next step: add the tracking script to your site"
echo "-------------------------------------------------------"
echo ""
echo "  <script"
echo "    defer"
echo "    data-endpoint=\"https://${WORKER_SUBDOMAIN}.workers.dev\""
echo "    src=\"https://${WORKER_SUBDOMAIN}.workers.dev/tracker.js\""
echo "  ></script>"
echo ""
echo "  Then open the dashboard at https://flarelytics-dashboard.pages.dev"
echo "  and enter:"
echo "    Worker URL:  https://${WORKER_SUBDOMAIN}.workers.dev"
echo "    API Key:     $QUERY_API_KEY"
echo "    Site:        your-site-hostname.com"
echo ""
