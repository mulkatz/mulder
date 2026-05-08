ALTER TABLE temporal_anomaly_clusters
  DROP CONSTRAINT IF EXISTS temporal_anomaly_clusters_anomaly_type_check;

ALTER TABLE temporal_anomaly_clusters
  ADD CONSTRAINT temporal_anomaly_clusters_anomaly_type_check
  CHECK (anomaly_type IN ('frequency_spike', 'frequency_changepoint'));
