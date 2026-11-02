"""Scale-to-zero OpenAI-compatible vLLM endpoint for Meta Muse Glimmer 30B.

Deploy with ``modal deploy deploy/modal/muse_glimmer_server.py``. GPU and model
length can be tuned with MUSE_GPU and MUSE_MAX_MODEL_LEN.
"""
from __future__ import annotations

import os
import subprocess
import modal

app = modal.App("openharness-muse-glimmer")
hf_cache = modal.Volume.from_name("openharness-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("openharness-vllm-cache", create_if_missing=True)
GPU_CONFIG = os.environ.get("MUSE_GPU", "H200:1")
image = modal.Image.from_registry("vllm/vllm-openai:muse-glimmer", add_python="3.11").entrypoint([]).env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
secrets = [modal.Secret.from_name("openharness-server")] if os.environ.get("USE_MODAL_SECRET") == "1" else []


@app.function(
    image=image,
    gpu=GPU_CONFIG,
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    secrets=secrets,
    min_containers=0,
    max_containers=1,
    scaledown_window=int(os.environ.get("MUSE_SCALEDOWN_WINDOW", "600")),
    timeout=3600,
    enable_memory_snapshot=True,
)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=8000, startup_timeout=900)
def serve() -> None:
    cmd = [
        "vllm", "serve", os.environ.get("MUSE_MODEL_ID", "meta-models/Muse-Glimmer-30B"),
        "--host", "0.0.0.0", "--port", "8000", "--served-model-name", "muse-glimmer",
        "--tensor-parallel-size", "1", "--enable-auto-tool-choice", "--tool-call-parser", "muse_glimmer",
        "--reasoning-parser", "muse_glimmer", "--generation-config", "auto",
        "--max-model-len", os.environ.get("MUSE_MAX_MODEL_LEN", "65536"),
        "--gpu-memory-utilization", os.environ.get("MUSE_GPU_UTIL", "0.90"),
    ]
    if os.environ.get("MUSE_ENABLE_DFLASH") == "1":
        cmd += ["--speculative-algorithm", "DFLASH", "--speculative-draft-model-path", "meta-models/Muse-Glimmer-30B-assistant", "--speculative-dflash-block-size", "5"]
    subprocess.Popen(cmd, env=os.environ.copy())
