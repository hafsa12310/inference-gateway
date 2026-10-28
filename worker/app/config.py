from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    worker_id: str = "worker-local"
    model_name: str = "churn"
    model_version: str = "v1"
    port: int = 8000

settings = Settings()