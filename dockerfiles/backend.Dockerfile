# Greenova backend (FastAPI). Built by docker-compose.yaml with ../backend as the build context.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Packages first, so a code change doesn't reinstall them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Same steps as start-backend.bat: check MySQL and create the tables (app.db), add the sample
# batches to an empty database (app.seed, skipped with GREENOVA_SEED=0), then start the API.
CMD ["sh", "-c", "python -m app.db && { [ \"$GREENOVA_SEED\" = 0 ] || python -m app.seed; } && exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"]
