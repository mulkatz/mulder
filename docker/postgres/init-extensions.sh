#!/bin/bash
set -e

# Enable all required extensions in the mulder database
# PostGIS and pg_trgm are installed at build time via Dockerfile;
# pgvector is pre-installed in the base image.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
