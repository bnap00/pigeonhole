# Laya (https://www.layaaimodel.com) behind `laya-serve`, its Jev-compatible
# HTTP server: POST /v1/systemone, GET /health. Only the `laya` compose
# service uses it; see docs/laya.md.
#
# CPU by default. docker-compose.gpu.yml rebuilds it with CUDA wheels.

FROM python:3.11-slim-bookworm

ARG TORCH_INDEX=cpu
ARG TORCH_VERSION=2.14.0
ARG LAYA_VERSION=0.3.20

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# torch first, from the index that matches the hardware, so installing laya
# does not pull the default (CUDA, several GB) wheel from PyPI instead.
RUN pip install "torch==${TORCH_VERSION}" --index-url "https://download.pytorch.org/whl/${TORCH_INDEX}" \
    && pip install "laya[serve]==${LAYA_VERSION}" \
    && pip check

# TORCH_DISABLE_NATIVE_JIT: torch 2.14 compiles some CUDA kernels with Triton on
# the first request, which needs a C compiler this image does not carry. The
# stock kernels give the same answers.
ENV PYTHONUNBUFFERED=1 \
    TORCH_DISABLE_NATIVE_JIT=1 \
    TOKENIZERS_PARALLELISM=false \
    USE_TF=0 \
    HF_HOME=/home/laya/.cache/huggingface \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000

RUN useradd --uid 10001 --create-home laya \
    && mkdir -p "$HF_HOME" \
    && chown -R laya:laya /home/laya/.cache
USER laya

EXPOSE 8000
CMD ["laya-serve"]
