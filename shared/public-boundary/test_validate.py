#!/usr/bin/env python3
"""Synthetic regression cases for the public source boundary."""
from __future__ import annotations

import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

VALIDATOR = pathlib.Path(__file__).with_name("validate.py")


class PublicBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "shared/public-boundary").mkdir(parents=True)
        (self.root / "shared/public-boundary/validate.py").write_bytes(VALIDATOR.read_bytes())
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def add(self, name: str, content: str | bytes) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")

    def check(self, success: bool, label: str | None = None) -> str:
        subprocess.run(["git", "-C", str(self.root), "add", "-A"], check=True)
        result = subprocess.run(
            [sys.executable, str(self.root / "shared/public-boundary/validate.py")],
            cwd=self.root, capture_output=True, text=True,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("PUBLIC_BOUNDARY_VALIDATION_PASS", result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("PUBLIC_BOUNDARY_FAIL", result.stderr)
            if label:
                self.assertIn(label, result.stderr)
        return result.stderr

    def test_validator_checks_itself_and_accepts_safe_source(self) -> None:
        self.add("example.py", "def greet():\n    return 'hello'\n")
        self.check(True)

    def test_private_remote_is_rejected_without_logging_value(self) -> None:
        private = "private_" + "repository = https://github.com/" + "example/synthetic-private.git"
        self.add("config.txt", "source = " + private)
        output = self.check(False, "concrete private or production binding")
        self.assertNotIn(private, output)

    def test_synthetic_production_binding_is_rejected(self) -> None:
        private = "production_control_" + "issue = 424242"
        self.add("config.py", private)
        self.check(False, "concrete private or production binding")

    def test_quoted_json_binding_is_rejected(self) -> None:
        private = '"production_control_' + 'owner_id": "424242"'
        self.add("config.json", "{" + private + "}")
        self.check(False, "concrete private or production binding")

    def test_production_issue_reference_is_rejected(self) -> None:
        text = "production control issue #" + "424242"
        self.add("notes.md", text)
        self.check(False, "production control issue number")

    def test_synthetic_private_key_headers_are_rejected(self) -> None:
        for prefix, suffix in (
            ("", ""),
            ("OPENSSH ", ""),
            ("RSA ", ""),
            ("EC ", ""),
            ("PGP ", " BLOCK"),
        ):
            with self.subTest(prefix=prefix):
                header = "-" * 5 + "BEGIN " + prefix + "PRIVATE KEY" + suffix + "-" * 5
                self.add("synthetic-key.txt", header + "\nplaceholder-only\n")
                output = self.check(False, "private key header")
                self.assertNotIn(header, output)

    def test_provider_credential_shape_is_rejected(self) -> None:
        secret = "sk-" + "A" * 32
        self.add("config.txt", secret)
        output = self.check(False, "provider credential-like material")
        self.assertNotIn(secret, output)

    def test_validator_file_is_not_exempt(self) -> None:
        path = self.root / "shared/public-boundary/validate.py"
        path.write_text(path.read_text() + "\n# " + "production_control_" + "owner_id = 424242\n")
        output = self.check(False, "concrete private or production binding")
        self.assertIn("shared/public-boundary/validate.py", output)

    def test_unreadable_binary_is_not_silently_skipped(self) -> None:
        self.add("random.bin", b"\xff\xfe\x00")
        self.check(False, "unscannable tracked file")

    def test_archived_material_is_checked(self) -> None:
        archive_path = self.root / "release.tgz"
        content = ("production_control_" + "repo = 'private'").encode("utf-8")
        with tarfile.open(archive_path, mode="w:gz") as archive:
            info = tarfile.TarInfo("package/index.js")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        self.check(False, "concrete private or production binding")

    def test_invalid_archive_fails_closed(self) -> None:
        self.add("release.tgz", b"not an archive")
        self.check(False, "unreadable release archive")

    def test_workflow_is_validated_and_fails_nonzero(self) -> None:
        self.add(".github/workflows/unsafe.yml", "name: unsafe\n" + "on: pull_request_target\n")
        self.check(False, "pull_request_target trigger")

    def test_unpinned_action_is_rejected(self) -> None:
        self.add(".github/workflows/unsafe.yml", """name: unsafe
on: pull_request
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
""")
        self.check(False, "action reference is not pinned")


if __name__ == "__main__":
    unittest.main()
