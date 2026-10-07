FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /app

# Install system dependencies (ffmpeg is required for keyframe extraction)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY services/forge/requirements.txt ./services/forge/requirements.txt
RUN pip install --no-cache-dir -r ./services/forge/requirements.txt

# Copy shared models/schemas and forge service from repo root build context
COPY shared/ ./shared/
COPY services/forge/ ./services/forge/

ENV PYTHONPATH=/app

EXPOSE 8080

CMD ["uvicorn", "services.forge.main:app", "--host", "0.0.0.0", "--port", "8080"]
