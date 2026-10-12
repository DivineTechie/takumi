#!/usr/bin/env bash
# Operational events pipeline: Cloud Run -> Pub/Sub topic takumi-events -> BigQuery subscription -> takumi.events.
# Idempotent: safe to re-run. Run from the repo root with gcloud and bq authenticated as a project owner.
set -euo pipefail
PROJECT=takumi-cup-2026
TOPIC=takumi-events
SUB=takumi-events-to-bigquery
TABLE=takumi.events
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format="value(projectNumber)")
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# 1. Table (partitioned by day on ts, clustered for the control tower queries)
bq show "$PROJECT:$TABLE" >/dev/null 2>&1 || bq mk --table \
  --time_partitioning_type=DAY --time_partitioning_field=ts --clustering_fields=kind,source \
  --description "All operational events, written by the Pub/Sub BigQuery subscription" \
  "$PROJECT:$TABLE" shared/schema/bigquery/events.json

# 2. Topic
gcloud pubsub topics describe "$TOPIC" --project="$PROJECT" >/dev/null 2>&1 || \
  gcloud pubsub topics create "$TOPIC" --project="$PROJECT"

# 3. IAM (least privilege, resource level): the API may publish to this topic only;
#    Pub/Sub's service agent may write to this table only.
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project="$PROJECT" \
  --member="serviceAccount:takumi-api@${PROJECT}.iam.gserviceaccount.com" --role=roles/pubsub.publisher --format=none
bq add-iam-policy-binding --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/bigquery.dataEditor "$PROJECT:$TABLE" >/dev/null

# 4. BigQuery subscription (message JSON keys map to table columns)
gcloud pubsub subscriptions describe "$SUB" --project="$PROJECT" >/dev/null 2>&1 || \
  gcloud pubsub subscriptions create "$SUB" --project="$PROJECT" --topic="$TOPIC" \
    --bigquery-table="$PROJECT:$TABLE" --use-table-schema --drop-unknown-fields

echo "Events pipeline ready: $TOPIC -> $SUB -> $TABLE"
