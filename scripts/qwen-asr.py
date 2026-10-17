"""Private, bounded-file bridge to the pinned local Qwen ASR runtime."""
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys

VERSION = "0.5.9"
MANIFEST = Path(__file__).with_name("qwen-model.json")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

LANGUAGES = {"Russian": "ru", "French": "fr", "English": "en", "Japanese": "ja"}


def check_artifacts(directory, manifest):
    for item in manifest["files"]:
        path = directory / item["path"]
        if not path.is_file() or path.stat().st_size != item["bytes"]:
            raise ValueError("Pinned local ASR artifact is missing or has an invalid size")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != item["sha256"]:
                raise ValueError("Pinned local ASR artifact hash mismatch")


def project_result(text, language, generation_tokens):
    if type(generation_tokens) is not int or generation_tokens < 0 or generation_tokens >= 1024:
        raise ValueError("ASR output has an invalid token count or reached its token limit")
    if not isinstance(text, str) or len(text) > 100000:
        raise ValueError("Invalid ASR text")
    detected = language if isinstance(language, list) else [language]
    if any(item is not None and (not isinstance(item, str) or item not in LANGUAGES) for item in detected):
        raise ValueError("Unsupported or malformed ASR language")
    unique = set(detected)
    label = next(iter(unique)) if len(unique) == 1 else None
    return {"text": text, "language": LANGUAGES.get(label)}


def transcribe(model_path, input_path):
    # Libraries may print progress; stdout is exclusively the bridge protocol.
    with contextlib.redirect_stdout(sys.stderr):
        from mlx_audio.stt.utils import load_model
        model = load_model(str(model_path))
        result = model.generate(str(input_path), language=None, temperature=0.0,
                                max_tokens=1024, verbose=False)
    return project_result(result.text, result.language, result.generation_tokens)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    if args.check:
        if importlib.metadata.version("mlx-audio") != VERSION:
            raise ValueError("Unsupported local ASR runtime version")
        with contextlib.redirect_stdout(sys.stderr):
            import mlx.core as mx
            from mlx_audio.stt.utils import load_model
            if not callable(load_model) or not mx.metal.is_available():
                raise ValueError("Local ASR requires an available MLX Metal runtime")
        check_artifacts(args.model, manifest)
        print(json.dumps({"version": VERSION, "modelRevision": manifest["revision"]}))
        return
    if args.input is None or args.output is None:
        parser.error("--input and --output are required for transcription")
    # Acquired native scopes provide the private directory and enforce audio bounds.
    result = transcribe(args.model, args.input)
    with args.output.open("w", encoding="utf-8") as output:
        os.chmod(args.output, 0o600)
        json.dump(result, output, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Local Qwen recognition failed", file=sys.stderr)
        sys.exit(1)
