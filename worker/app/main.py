from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.config import settings

app = FastAPI(title="model-worker")


@app.get("/health")
def health():
    return {"status": "ok", "worker_id": settings.worker_id}


@app.get("/ready")
def ready():
    # Phase 1: return 503 until the model is loaded
    return {"ready": True, "model": f"{settings.model_name}:{settings.model_version}"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
