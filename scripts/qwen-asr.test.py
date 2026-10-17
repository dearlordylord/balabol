"""Bridge boundary checks; no model inference, downloads or monkey-patching."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("qwen-asr.py")
spec = importlib.util.spec_from_file_location("qwen_asr", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class QwenBridgeTests(unittest.TestCase):
    def test_preserves_text_and_maps_supported_detected_languages(self):
        for label, tag in bridge.LANGUAGES.items():
            text = "Bonjour. Привет. Hello. こんにちは (speaking in foreign language)"
            self.assertEqual(bridge.project_result(text, label, 1023), {"text": text, "language": tag})
            self.assertEqual(bridge.project_result(text, [label, label], 1)["language"], tag)

    def test_mixed_or_missing_detection_never_invents_a_single_language(self):
        for labels in [None, [], [None], ["French", "Russian"], [None, "French"]]:
            self.assertEqual(bridge.project_result("Bonjour Привет", labels, 0)["language"], None)
        self.assertEqual(bridge.project_result("", "French", 0)["text"], "")

    def test_rejects_truncation_invalid_counts_and_malformed_results(self):
        for count in [1024, 1025, -1, True, None, 1.5]:
            with self.assertRaises(ValueError):
                bridge.project_result("text", "French", count)
        for text in [None, 12, "x" * 100001]:
            with self.assertRaises(ValueError):
                bridge.project_result(text, "French", 1)
        for language in ["German", "Frenchish", ["French", "German"], [["French"]], {}, 1]:
            with self.assertRaises(ValueError):
                bridge.project_result("text", language, 1)

    def test_artifact_validation_checks_size_hash_and_missing_files(self):
        with tempfile.TemporaryDirectory(prefix="balabol-qwen-contract-") as directory:
            root = Path(directory)
            content = b"synthetic model artifact"
            manifest = {"files": [{"path": "weights", "bytes": len(content),
                                   "sha256": hashlib.sha256(content).hexdigest()}]}
            with self.assertRaises(ValueError):
                bridge.check_artifacts(root, manifest)
            artifact = root / "weights"
            artifact.write_bytes(content[:-1])
            with self.assertRaises(ValueError):
                bridge.check_artifacts(root, manifest)
            artifact.write_bytes(b"x" * len(content))
            with self.assertRaises(ValueError):
                bridge.check_artifacts(root, manifest)
            artifact.write_bytes(content)
            bridge.check_artifacts(root, manifest)

    def test_real_check_process_rejects_missing_model_without_readiness_output(self):
        with tempfile.TemporaryDirectory(prefix="balabol-qwen-check-") as directory:
            result = subprocess.run([sys.executable, str(SCRIPT), "--check", "--model", directory],
                                    capture_output=True, text=True, timeout=15, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "Local Qwen recognition failed")


if __name__ == "__main__":
    unittest.main()
