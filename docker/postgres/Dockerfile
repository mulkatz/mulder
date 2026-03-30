FROM pgvector/pgvector:pg17

# Install PostGIS and pg_trgm as root at build time
RUN apt-get update -qq \
    && apt-get install -y -qq postgresql-17-postgis-3 > /dev/null 2>&1 \
    && rm -rf /var/lib/apt/lists/*
