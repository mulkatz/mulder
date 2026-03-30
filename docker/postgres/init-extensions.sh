#!/bin/bash
set -e

# Install PostGIS (pgvector is pre-installed in the base image)
apt-get update -qq && apt-get install -y -qq postgresql-17-postgis-3 > /dev/null 2>&1

# Enable all required extensions in the mulder database
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
