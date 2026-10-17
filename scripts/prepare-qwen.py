"""Explicit provisioning; ordinary backend startup never downloads dependencies."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent
HOME = Path.home() / ".local/share/balabol"
MODEL = HOME / "models/qwen3-asr-1.7b"
PYTHON = HOME / "tools/qwen-asr/.venv/bin/python"


def provision():
    if sys.argv[1:] not in ([], ["--check"]):
        raise ValueError("Use pnpm prepare:qwen [--check]")
    if not sys.argv[1:]:
        subprocess.run(["uv", "venv", "--allow-existing", "--python", "3.12", str(PYTHON.parent.parent)], check=True)
        subprocess.run(["uv", "pip", "sync", "--python", str(PYTHON),
                        str(ROOT / "qwen-requirements.txt")], check=True)
        manifest = json.loads((ROOT / "qwen-model.json").read_text())
        MODEL.mkdir(parents=True, exist_ok=True, mode=0o700)
        for artifact in manifest["files"]:
            destination = MODEL / artifact["path"]
            if destination.is_file():
                with destination.open("rb") as source:
                    if hashlib.file_digest(source, "sha256").hexdigest() == artifact["sha256"]:
                        continue
            temporary = destination.with_suffix(destination.suffix + ".partial")
            url = (f"https://huggingface.co/{manifest['repository']}/resolve/"
                   f"{manifest['revision']}/{artifact['path']}")
            try:
                with urllib.request.urlopen(url, timeout=120) as source, temporary.open("wb") as output:
                    os.chmod(temporary, 0o600)
                    remaining = artifact["bytes"]
                    while chunk := source.read(min(1024 * 1024, remaining + 1)):
                        remaining -= len(chunk)
                        if remaining < 0:
                            raise ValueError("ASR artifact exceeded its size limit")
                        output.write(chunk)
                with temporary.open("rb") as source:
                    digest = hashlib.file_digest(source, "sha256").hexdigest()
                if remaining != 0 or digest != artifact["sha256"]:
                    raise ValueError("ASR artifact integrity mismatch")
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
    subprocess.run([str(PYTHON), str(ROOT / "qwen-asr.py"), "--check", "--model", str(MODEL)], check=True)


if __name__ == "__main__":
    provision()
