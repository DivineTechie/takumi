from fastapi import FastAPI

app = FastAPI(title="TAKUMI API", version="0.1.0")


@app.get("/healthz")
@app.get("/api/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
