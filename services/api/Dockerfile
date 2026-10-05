FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

WORKDIR /app

# Install dependencies
COPY services/api/requirements.txt ./services/api/requirements.txt
RUN pip install --no-cache-dir -r ./services/api/requirements.txt

# Copy shared code and API service from repo root context
COPY shared/ ./shared/
COPY services/api/ ./services/api/

ENV PYTHONPATH=/app

EXPOSE 8080

CMD ["uvicorn", "services.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
