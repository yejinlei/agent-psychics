"""配置层：从 .env 加载，字段可空。多 provider 策略参考 nobel-kg。"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- 主模型（OpenAI 兼容） ----
    llm_base_url: str = Field(default="https://openrouter.ai/api/v1", alias="LLM_BASE_URL")
    llm_api_key: str = Field(default="", alias="LLM_API_KEY")
    llm_model: str = Field(default="openai/gpt-4o-mini", alias="LLM_MODEL")
    llm_temperature: float = Field(default=0.4, alias="LLM_TEMPERATURE")
    llm_timeout: int = Field(default=60, alias="LLM_TIMEOUT")
    openrouter_referer: str = Field(default="https://agent-psychics.local", alias="OPENROUTER_REFERER")
    openrouter_title: str = Field(default="Psychics Ontology Agent", alias="OPENROUTER_TITLE")

    # ---- 备用模型（可选） ----
    llm_fallback_base_url: str = Field(default="", alias="LLM_FALLBACK_BASE_URL")
    llm_fallback_api_key: str = Field(default="", alias="LLM_FALLBACK_API_KEY")
    llm_fallback_model: str = Field(default="", alias="LLM_FALLBACK_MODEL")

    # ---- ASR ----
    asr_provider: str = Field(default="openai", alias="ASR_PROVIDER")
    asr_model: str = Field(default="whisper-1", alias="ASR_MODEL")
    asr_api_key: str = Field(default="", alias="ASR_API_KEY")
    asr_base_url: str = Field(default="", alias="ASR_BASE_URL")
    local_whisper_model: str = Field(default="base", alias="LOCAL_WHISPER_MODEL")

    # ---- TTS ----
    tts_provider: str = Field(default="openai", alias="TTS_PROVIDER")
    tts_model: str = Field(default="tts-1", alias="TTS_MODEL")
    tts_voice: str = Field(default="alloy", alias="TTS_VOICE")
    tts_api_key: str = Field(default="", alias="TTS_API_KEY")
    tts_base_url: str = Field(default="", alias="TTS_BASE_URL")
    dashscope_api_key: str = Field(default="", alias="DASHSCOPE_API_KEY")
    dashscope_model: str = Field(default="cosyvoice-v2", alias="DASHSCOPE_MODEL")
    dashscope_voice: str = Field(default="longxiaochun", alias="DASHSCOPE_VOICE")

    # ---- 服务 ----
    api_host: str = Field(default="0.0.0.0", alias="API_HOST")
    api_port: int = Field(default=8000, alias="API_PORT")
    api_cors_origins: str = Field(default="*", alias="API_CORS_ORIGINS")

    # ---- 治理 ----
    ontology_strict: bool = Field(default=False, alias="ONTOLOGY_STRICT")

    # ---- 便捷：ASR/TTS 未配独立 key 时回落到主 LLM key ----
    @property
    def effective_asr_key(self) -> str:
        return self.asr_api_key or self.llm_api_key

    @property
    def effective_asr_base_url(self) -> str:
        return (self.asr_base_url or self.llm_base_url).rstrip("/")

    @property
    def effective_tts_key(self) -> str:
        return self.tts_api_key or self.llm_api_key

    @property
    def effective_tts_base_url(self) -> str:
        return (self.tts_base_url or self.llm_base_url).rstrip("/")

    def cors_origin_list(self) -> list[str]:
        raw = self.api_cors_origins.strip()
        if not raw:
            return []
        if raw == "*":
            return ["*"]
        return [x.strip() for x in raw.split(",") if x.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
